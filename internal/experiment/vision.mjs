import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExperimentError } from './index.mjs'

/** Authenticated route that serves captured deck photos and annotated overlays. */
export const VISION_ROUTE = '/api/robot-camera'
// Newest captures stay addressable by the Web UI; older files remain on disk and expire by count only.
const RETAINED_CAPTURES = 20
const MAX_SCRIPT_STDOUT = 1024 * 1024
const MAX_SCRIPT_STDERR = 4096
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const IMAGE_TYPES = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png']])

function boundedText(value, limit) {
  if (typeof value !== 'string') return null
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, limit)
}

function boundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null
}

function unwrap(payload) {
  return payload !== null && typeof payload === 'object' && 'data' in payload ? payload.data : payload
}

function cameraSummary(payload) {
  const data = unwrap(payload)
  if (data === null || typeof data !== 'object') return null
  return {
    enabled: data.cameraEnabled === true,
    liveStreamEnabled: data.liveStreamEnabled === true,
    errorRecoveryCameraEnabled: data.errorRecoveryCameraEnabled === true,
  }
}

function mediaType(path) {
  for (const [extension, type] of IMAGE_TYPES) if (path.toLowerCase().endsWith(extension)) return type
  return 'application/octet-stream'
}

/**
 * Build the Markdown image line the chat renders inline from a local file.
 * The client rewrites an absolute destination through the authenticated
 * `/api/file` route, so the reply only needs the path. Forward slashes avoid
 * CommonMark backslash escapes on Windows paths, and the angle-bracket form
 * keeps spaces literal.
 * @param {string} alt Image alt text shown in the chat.
 * @param {string} path Absolute image path on the host.
 * @returns {string|null} One Markdown image line, or null for a path that cannot be embedded.
 */
export function chatImageMarkdown(alt, path) {
  if (typeof alt !== 'string' || alt === '' || /[\\[\]]/u.test(alt)) return null
  if (typeof path !== 'string' || path === '' || /[<>\r\n]/u.test(path)) return null
  return `![${alt}](<${path.replaceAll('\\', '/')}>)`
}

/** Project one vision-script result into the bounded model-visible report. */
export function summarizeVisionResult(result) {
  if (result === null || typeof result !== 'object') throw new ExperimentError('VISION_INVALID_RESULT', 'the vision script returned no result object')
  if (typeof result.error === 'object' && result.error !== null) {
    throw new ExperimentError('VISION_FAILED', boundedText(result.error.detail ?? result.error.type, 500) ?? 'the vision script reported an error')
  }
  const slots = {}
  for (const [slot, raw] of Object.entries(result.slot_observations ?? {})) {
    const observation = raw !== null && typeof raw === 'object' ? raw : {}
    slots[slot] = {
      state: boundedText(observation.state, 40) ?? 'unknown',
      label: boundedText(observation.label, 80),
      confidence: boundedNumber(observation.confidence),
      source: boundedText(observation.source, 40),
      needsHumanReview: observation.needs_human_review === true || observation.state === 'uncertain',
    }
  }
  const observedItems = Array.isArray(result.observed_items)
    ? result.observed_items.slice(0, 20).map(item => ({
      slot: boundedText(item?.slot, 10),
      label: boundedText(item?.label, 80),
      classRaw: boundedText(item?.class_name_raw, 80),
      confidence: boundedNumber(item?.confidence),
      coveredSlots: Array.isArray(item?.covered_slots) ? item.covered_slots.slice(0, 12).map(slot => boundedText(slot, 10)) : [],
      needsHumanReview: item?.needs_human_review === true,
    }))
    : []
  const uncertainties = Array.isArray(result.uncertainties)
    ? result.uncertainties.slice(0, 10).map(item => boundedText(item, 200)).filter(Boolean)
    : []
  return {
    summary: boundedText(result.summary, 800) ?? '',
    slotMapping: {
      method: boundedText(result.slot_mapping?.method, 60),
      cornersSource: boundedText(result.slot_mapping?.corners_source, 60),
    },
    model: {
      family: boundedText(result.model?.family, 20),
      weights: boundedText(result.model?.weights_effective ?? result.model?.weights_requested, 300),
      labTuned: result.model?.lab_tuned === true,
    },
    slots,
    observedItems,
    uncertainties,
    needsHumanReview: result.needs_human_review === true || uncertainties.length > 0,
  }
}

function runVisionScript({ python, script, payload, timeoutMs, cwd }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-I', script], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        MPLCONFIGDIR: join(cwd, 'matplotlib'),
        YOLO_CONFIG_DIR: join(cwd, 'ultralytics'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (action, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new ExperimentError('VISION_TIMEOUT', 'deck analysis timed out'))
    }, timeoutMs)
    child.once('error', error => finish(reject, new ExperimentError('VISION_FAILED', `deck analysis could not start: ${boundedText(String(error?.message ?? error), 300)}`)))
    child.stdout.on('data', chunk => {
      if (settled) return
      if (stdout.length + chunk.length > MAX_SCRIPT_STDOUT) {
        child.kill('SIGKILL')
        finish(reject, new ExperimentError('VISION_INVALID_RESULT', 'deck analysis produced too much output'))
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_SCRIPT_STDERR) })
    child.once('close', code => {
      if (settled) return
      const text = stdout.trim()
      let parsed
      try {
        parsed = JSON.parse(text.slice(text.indexOf('{')))
      } catch {
        finish(reject, new ExperimentError('VISION_FAILED', `deck analysis exited ${code} without a JSON result${stderr ? `: ${boundedText(stderr, 500)}` : ''}`))
        return
      }
      if (code !== 0 && !(typeof parsed.error === 'object' && parsed.error !== null)) {
        finish(reject, new ExperimentError('VISION_FAILED', `deck analysis exited ${code}${stderr ? `: ${boundedText(stderr, 500)}` : ''}`))
        return
      }
      finish(resolvePromise, parsed)
    })
    child.stdin.once('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * Create the deck-camera observation service.
 * Captures are saved under `captureRoot` with owner-only permissions and are never
 * robot motion. Analysis runs the lab's local vision script against the newest
 * capture; its result is observation-only and must be compared with robot state.
 * @param {object} config Bounded configuration and the optional configured robot client.
 * @returns {object} capture, inspect, fetch, and latest operations.
 */
export function createVisionService(config) {
  const { client, python, script, weights, captureRoot, calibrationPath, analyzeTimeoutMs } = config
  const captures = new Map()
  const order = []
  const analyzing = new Set()
  let calibration = null

  function latest() {
    const id = order.at(-1)
    return id === undefined ? undefined : captures.get(id)
  }

  function publicCapture(record) {
    return {
      id: record.id,
      capturedAt: record.capturedAt,
      bytes: record.bytes,
      contentType: record.contentType,
      imageUrl: `${VISION_ROUTE}?id=${encodeURIComponent(record.id)}`,
      annotatedImageUrl: record.annotatedPath ? `${VISION_ROUTE}?id=${encodeURIComponent(record.id)}&kind=annotated` : null,
      savedTo: record.path,
      photoMarkdown: chatImageMarkdown('台面照片', record.path),
      annotatedMarkdown: record.annotatedPath ? chatImageMarkdown('台面识别标注图', record.annotatedPath) : null,
    }
  }

  async function deckCorners() {
    if (calibration !== null) return calibration
    calibration = undefined
    if (typeof calibrationPath !== 'string' || !calibrationPath.trim()) return (calibration = undefined)
    try {
      const parsed = JSON.parse(await readFile(calibrationPath, 'utf8'))
      const corners = parsed?.optional_deck_corners_norm
      calibration = Array.isArray(corners) && corners.length === 4 ? corners : undefined
    } catch {
      // Missing or unreadable calibration falls back to the vision script's own default mapping.
      calibration = undefined
    }
    return calibration
  }

  async function capture() {
    if (!client) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'OPENTRONS_URL is not configured')
    const camera = await client.cameraStatus().catch(() => null)
    const image = await client.capturePreviewImage()
    const id = randomUUID()
    const capturedAt = new Date().toISOString()
    const extension = image.contentType === 'image/png' ? 'png' : 'jpg'
    await mkdir(captureRoot, { recursive: true, mode: 0o700 })
    const path = join(captureRoot, `${capturedAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.${extension}`)
    await writeFile(path, image.data, { mode: 0o600, flag: 'wx' })
    const record = {
      id,
      path,
      contentType: image.contentType,
      bytes: image.data.length,
      capturedAt,
      camera: cameraSummary(camera),
      annotatedPath: null,
    }
    captures.set(id, record)
    order.push(id)
    while (order.length > RETAINED_CAPTURES) captures.delete(order.shift())
    return publicCapture(record)
  }

  async function inspect(input = {}) {
    const photoId = input?.photoId
    if (photoId !== undefined && typeof photoId !== 'string') throw new ExperimentError('INVALID_INPUT', 'photoId must be a capture id returned by capture_deck_photo')
    const record = photoId ? captures.get(photoId) : latest()
    if (!record) throw new ExperimentError('VISION_NO_CAPTURE', 'no deck photo has been captured yet; call capture_deck_photo first')
    if (analyzing.has(record.id)) throw new ExperimentError('VISION_BUSY', 'this deck photo is already being analyzed')
    analyzing.add(record.id)
    try {
      const payload = {
        mode: 'deck',
        image_path: record.path,
        conf_threshold: 0.25,
        weights,
        load_labels_sidecar: false,
        annotated_output_dir: join(captureRoot, 'annotated'),
      }
      const corners = await deckCorners()
      if (corners) payload.deck_corners_norm = corners
      const result = await runVisionScript({ python, script, payload, timeoutMs: analyzeTimeoutMs, cwd: captureRoot })
      const analysis = summarizeVisionResult(result)
      if (typeof result.annotated_image_path === 'string' && result.annotated_image_path.trim()) {
        const path = result.annotated_image_path.trim()
        try {
          await readFile(path)
          record.annotatedPath = path
        } catch {
          // The overlay is optional; keep the textual observations when it is missing.
        }
      }
      return { photo: publicCapture(record), analysis }
    } finally {
      analyzing.delete(record.id)
    }
  }

  async function fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: NO_STORE })
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (!id) return new Response(null, { status: 400, headers: NO_STORE })
    const record = captures.get(id)
    if (!record) return new Response(null, { status: 404, headers: NO_STORE })
    const kind = url.searchParams.get('kind') ?? 'photo'
    const path = kind === 'annotated' ? record.annotatedPath : kind === 'photo' ? record.path : null
    if (!path) return new Response(null, { status: 404, headers: NO_STORE })
    try {
      const bytes = await readFile(path)
      return new Response(bytes, { headers: { ...NO_STORE, 'Content-Type': mediaType(path) } })
    } catch {
      return new Response(null, { status: 404, headers: NO_STORE })
    }
  }

  return { capture, inspect, fetch, latest }
}
