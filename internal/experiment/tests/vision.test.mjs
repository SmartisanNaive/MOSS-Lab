import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRobotClient } from '../robot-client.mjs'
import { chatImageMarkdown, createVisionService, summarizeVisionResult, VISION_ROUTE } from '../vision.mjs'
import { startFakeRobot } from './fake-robot.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
// A killed analysis process can hold the directory briefly on Windows; retry before failing cleanup.
async function removeTree(path) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const python = [join(projectRoot, 'labscriptai-ot', '.venv', 'Scripts', 'python.exe'), join(projectRoot, 'labscriptai-ot', '.venv', 'bin', 'python')].find(path => existsSync(path))
const skipWithoutPython = python === undefined ? 'the project uv Python environment is required' : false

function cameraRobot() {
  return startFakeRobot(request => {
    if (request.method === 'GET' && request.path === '/camera') return { body: { cameraEnabled: true, liveStreamEnabled: true, errorRecoveryCameraEnabled: true } }
    if (request.method === 'POST' && request.path === '/camera/capturePreviewImage') return { body: JPEG, headers: { 'Content-Type': 'image/jpeg' } }
    return { status: 404, body: { error: 'not found' } }
  })
}

const SUCCESS_SCRIPT = `import json, pathlib, sys
payload = json.load(sys.stdin)
annotated = pathlib.Path(payload["annotated_output_dir"]) / "annotated.jpg"
annotated.parent.mkdir(parents=True, exist_ok=True)
annotated.write_bytes(b"\\xff\\xd8\\xff\\xe0stub")
print(json.dumps({
  "mode": "deck",
  "summary": "1 item detected: tiprack_200 on A2",
  "slot_mapping": {"method": "uniform_image_grid", "corners_source": None},
  "model": {"family": "YOLO", "weights_effective": payload["weights"], "lab_tuned": True},
  "slot_observations": {
    "A1": {"state": "fixed", "label": "pcr_thermocycler", "reasons": ["fixed_hardware"]},
    "A2": {"state": "occupied", "label": "tiprack_200", "confidence": 0.91, "source": "trained_yolo_detection", "reasons": []},
    "B2": {"state": "unknown"}
  },
  "observed_items": [{"slot": "A2", "label": "tiprack_200", "confidence": 0.91, "needs_human_review": False, "covered_slots": ["A2"]}],
  "uncertainties": [],
  "needs_human_review": False,
  "annotated_image_path": str(annotated.resolve()),
}))
`

const ERROR_SCRIPT = `import json, sys
print(json.dumps({"error": {"type": "FileNotFound", "detail": "image disappeared"}, "needs_human_review": True}))
sys.exit(1)
`

const SLOW_SCRIPT = `import sys, time
time.sleep(5)
print("{}")
`

async function setup({ script = SUCCESS_SCRIPT, analyzeTimeoutMs = 20000 } = {}) {
  const robot = await cameraRobot()
  const captureRoot = await mkdtemp(join(tmpdir(), 'moss-vision-'))
  const scriptPath = join(captureRoot, 'stub_vision.py')
  await writeFile(scriptPath, script, 'utf8')
  const client = createRobotClient({ url: robot.url, timeoutMs: 2000, maxBytes: 1024 * 1024 })
  const service = createVisionService({ client, python, script: scriptPath, weights: 'stub-weights.pt', captureRoot, calibrationPath: '', analyzeTimeoutMs })
  return {
    robot,
    service,
    captureRoot,
    async close() {
      await robot.close()
      await removeTree(captureRoot)
    },
  }
}

test('captures a photo, serves it, and analyzes it with the local vision script', { skip: skipWithoutPython }, async () => {
  const context = await setup()
  try {
    const photo = await context.service.capture()
    assert.equal(photo.contentType, 'image/jpeg')
    assert.equal(photo.bytes, JPEG.length)
    assert.match(photo.imageUrl, /^\/api\/robot-camera\?id=/)
    assert.deepEqual(photo.annotatedImageUrl, null)
    assert.deepEqual(photo.photoMarkdown, chatImageMarkdown('台面照片', photo.savedTo))
    assert.match(photo.photoMarkdown, /^!\[台面照片\]\(<.+\.jpg>\)$/u)
    assert.equal(photo.photoMarkdown.includes('\\'), false)
    assert.deepEqual(photo.annotatedMarkdown, null)

    const served = await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}?id=${photo.id}`))
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), JPEG)

    const result = await context.service.inspect({})
    assert.equal(result.photo.id, photo.id)
    assert.equal(result.analysis.summary, '1 item detected: tiprack_200 on A2')
    assert.equal(result.analysis.slots.A2.state, 'occupied')
    assert.equal(result.analysis.slots.A2.label, 'tiprack_200')
    assert.equal(result.analysis.slots.A2.confidence, 0.91)
    assert.equal(result.analysis.slots.A1.state, 'fixed')
    assert.equal(result.analysis.slots.A1.needsHumanReview, false)
    assert.deepEqual(result.analysis.observedItems, [{ slot: 'A2', label: 'tiprack_200', classRaw: null, confidence: 0.91, coveredSlots: ['A2'], needsHumanReview: false }])
    assert.equal(result.analysis.needsHumanReview, false)
    assert.match(result.photo.annotatedImageUrl, /kind=annotated/)
    assert.match(result.photo.annotatedMarkdown, /^!\[台面识别标注图\]\(<.+annotated\.jpg>\)$/u)
    assert.equal(result.photo.annotatedMarkdown.includes('\\'), false)

    const annotated = await context.service.fetch(new Request(`http://127.0.0.1${result.photo.annotatedImageUrl}`))
    assert.equal(annotated.status, 200)
    assert.equal(annotated.headers.get('content-type'), 'image/jpeg')
  } finally { await context.close() }
})

test('reports an unavailable robot and a missing photo without spawning analysis', { skip: skipWithoutPython }, async () => {
  const captureRoot = await mkdtemp(join(tmpdir(), 'moss-vision-'))
  try {
    const service = createVisionService({ client: null, python, script: join(captureRoot, 'missing.py'), weights: 'stub-weights.pt', captureRoot, calibrationPath: '', analyzeTimeoutMs: 20000 })
    await assert.rejects(service.capture(), error => error.code === 'ROBOT_NOT_CONFIGURED')
    await assert.rejects(service.inspect({}), error => error.code === 'VISION_NO_CAPTURE')
  } finally { await removeTree(captureRoot) }
})

test('rejects a vision script error result with its detail', { skip: skipWithoutPython }, async () => {
  const context = await setup({ script: ERROR_SCRIPT })
  try {
    await context.service.capture()
    await assert.rejects(context.service.inspect({}), error => error.code === 'VISION_FAILED' && error.message.includes('image disappeared'))
  } finally { await context.close() }
})

test('bounds analysis time', { skip: skipWithoutPython }, async () => {
  const context = await setup({ script: SLOW_SCRIPT, analyzeTimeoutMs: 300 })
  try {
    await context.service.capture()
    await assert.rejects(context.service.inspect({}), error => error.code === 'VISION_TIMEOUT')
  } finally { await context.close() }
})

test('serves only existing captures and only GET requests', { skip: skipWithoutPython }, async () => {
  const context = await setup()
  try {
    assert.equal((await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}`))).status, 400)
    assert.equal((await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}?id=unknown`))).status, 404)
    assert.equal((await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}?id=unknown`, { method: 'POST' }))).status, 405)
    const photo = await context.service.capture()
    assert.equal((await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}?id=${photo.id}&kind=annotated`))).status, 404)
    assert.equal((await context.service.fetch(new Request(`http://127.0.0.1${VISION_ROUTE}?id=${photo.id}&kind=other`))).status, 404)
  } finally { await context.close() }
})

test('bounds and rejects malformed vision results', () => {
  assert.throws(() => summarizeVisionResult({ error: { detail: 'bad image' } }), error => error.code === 'VISION_FAILED' && error.message === 'bad image')
  assert.throws(() => summarizeVisionResult(null), error => error.code === 'VISION_INVALID_RESULT')
  const summarized = summarizeVisionResult({
    summary: 'x'.repeat(2000),
    slot_observations: { A2: { state: 'occupied', label: 'y'.repeat(200), confidence: Number.NaN, reasons: [] } },
    observed_items: Array.from({ length: 30 }, () => ({ slot: 'A2', label: 'plate', confidence: 0.5, covered_slots: ['A2'] })),
    uncertainties: Array.from({ length: 20 }, () => 'u'.repeat(500)),
    needs_human_review: false,
  })
  assert.equal(summarized.summary.length, 800)
  assert.equal(summarized.slots.A2.label.length, 80)
  assert.equal(summarized.slots.A2.confidence, null)
  assert.equal(summarized.observedItems.length, 20)
  assert.equal(summarized.uncertainties.length, 10)
  assert.equal(summarized.uncertainties[0].length, 200)
  assert.equal(summarized.needsHumanReview, true)
})

test('builds one inline chat image line for local photos', () => {
  assert.equal(chatImageMarkdown('台面照片', 'C:\\Users\\a b\\shot.jpg'), '![台面照片](<C:/Users/a b/shot.jpg>)')
  assert.equal(chatImageMarkdown('台面照片', '/tmp/shot.jpg'), '![台面照片](</tmp/shot.jpg>)')
  assert.equal(chatImageMarkdown('台面照片', ''), null)
  assert.equal(chatImageMarkdown('', '/tmp/shot.jpg'), null)
  assert.equal(chatImageMarkdown('a[b]', '/tmp/shot.jpg'), null)
  assert.equal(chatImageMarkdown('台面照片', '/tmp/<bad>.jpg'), null)
  assert.equal(chatImageMarkdown('台面照片', '/tmp/bad\n.jpg'), null)
})

test('captures into a directory whose name contains a space', { skip: skipWithoutPython }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss vision space '))
  const robot = await cameraRobot()
  try {
    const captureRoot = join(root, 'capture dir')
    const scriptPath = join(root, 'stub_vision.py')
    await writeFile(scriptPath, SUCCESS_SCRIPT, 'utf8')
    const client = createRobotClient({ url: robot.url, timeoutMs: 2000, maxBytes: 1024 * 1024 })
    const service = createVisionService({ client, python, script: scriptPath, weights: 'stub-weights.pt', captureRoot, calibrationPath: '', analyzeTimeoutMs: 20000 })
    const photo = await service.capture()
    assert.equal(photo.photoMarkdown, chatImageMarkdown('台面照片', photo.savedTo))
    assert.ok(photo.photoMarkdown.includes('capture dir'))
  } finally {
    await robot.close()
    await removeTree(root)
  }
})
