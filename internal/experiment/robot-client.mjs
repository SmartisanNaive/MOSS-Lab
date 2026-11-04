import { randomUUID } from 'node:crypto'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { buildRobotUrl } from '../../labscriptai-ot/servers/opentrons-mcp/lib/http.js'
import { buildProtocolRunCreateBody, prepareOffsetsForRunCreate } from '../../labscriptai-ot/servers/opentrons-mcp/lib/labware-offsets.js'

const RUN_ACTIONS = new Set(['play', 'pause', 'stop', 'resume-from-recovery'])
// Reuse TLS connections; the lab tunnel resets idle ones, and read retries cover that.
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 4 })
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4 })

/** Structured robot failure with a stable code for tools and tests. */
export class RobotError extends Error {
  /** @param {string} code stable failure code. @param {string} message bounded operator-facing message. */
  constructor(code, message) {
    super(message)
    this.name = 'RobotError'
    this.code = code
  }
}

function unwrap(payload) {
  return payload !== null && typeof payload === 'object' && 'data' in payload ? payload.data : payload
}

function boundedText(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, limit)
}

function robotIdentity(health) {
  const data = unwrap(health) ?? {}
  return {
    name: typeof data.name === 'string' ? data.name.slice(0, 100) : null,
    model: typeof (data.robot_model ?? data.robotModel) === 'string' ? String(data.robot_model ?? data.robotModel).slice(0, 100) : null,
    apiVersion: typeof data.api_version === 'string' ? data.api_version.slice(0, 40) : null,
    systemVersion: typeof data.system_version === 'string' ? data.system_version.slice(0, 40) : null,
  }
}

function instrumentList(payload) {
  const data = unwrap(payload)
  if (!Array.isArray(data)) return null
  return data
    .filter(item => item !== null && typeof item === 'object' && (item.mount === 'left' || item.mount === 'right'))
    .map(item => ({ mount: item.mount, name: boundedText(item.instrumentModel ?? item.instrumentType ?? item.name, 80) }))
}

function doorState(payload) {
  const data = unwrap(payload)
  if (data === null || typeof data !== 'object') return null
  return { status: typeof data.status === 'string' ? data.status.slice(0, 40) : null, requiredClosedForProtocol: data.doorRequiredClosedForProtocol === true }
}

function estopState(payload) {
  const data = unwrap(payload)
  if (data === null || typeof data !== 'object') return null
  return { status: typeof data.status === 'string' ? data.status.slice(0, 40) : null }
}

function runSummary(payload) {
  const data = unwrap(payload)
  if (data === null || typeof data !== 'object') return null
  return {
    runId: typeof data.id === 'string' ? data.id : null,
    status: typeof data.status === 'string' ? data.status.slice(0, 40) : null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
    current: data.current === true,
    errors: Array.isArray(data.errors) ? data.errors.slice(0, 5).map(error => ({ detail: boundedText(error?.detail ?? error?.message ?? error, 300), createdAt: typeof error?.createdAt === 'string' ? error.createdAt : null })) : [],
  }
}

function commandList(payload, limit = 20) {
  const data = unwrap(payload)
  if (!Array.isArray(data)) return null
  return data.slice(-limit).map(command => ({
    id: typeof command?.id === 'string' ? command.id : null,
    commandType: typeof command?.commandType === 'string' ? command.commandType.slice(0, 80) : null,
    status: typeof command?.status === 'string' ? command.status.slice(0, 40) : null,
    error: command?.error === null || command?.error === undefined ? null : boundedText(command.error?.detail ?? command.error?.message ?? command.error, 300),
  }))
}

function multipart(protocol, filename) {
  const boundary = `----MOSS${randomUUID().replaceAll('-', '')}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename.replaceAll('"', '')}"\r\nContent-Type: text/x-python\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, body: Buffer.concat([head, Buffer.from(protocol, 'utf8'), tail]) }
}

/**
 * Create a bounded Opentrons HTTP client for one configured robot base URL.
 * The URL is fixed at startup; callers never supply a target. Credentials embedded
 * in the URL are sent as Basic auth and removed from requests and error text.
 * Uses the Node HTTP transport rather than fetch: the lab robot is reached through
 * a tunneled address whose proxy resets undici uploads and idle connections.
 * @param {{ url: string, timeoutMs?: number, maxBytes?: number, maxProtocolBytes?: number }} config Robot configuration.
 * @returns {object} Status, upload, run, and query operations.
 */
export function createRobotClient(config) {
  if (!config || typeof config.url !== 'string' || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || !Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0 || !Number.isSafeInteger(config.maxProtocolBytes) || config.maxProtocolBytes <= 0) {
    throw new Error('robot-client requires a url, positive timeoutMs, maxBytes, and maxProtocolBytes')
  }
  const parsed = new URL(config.url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('robot-client requires an http(s) robot URL')
  const authorization = parsed.username || parsed.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
    : null
  parsed.username = ''
  parsed.password = ''
  const base = parsed.toString().replace(/\/+$/, '')
  // The lab tunnel resets requests without a user agent; keep this stable across deployments.
  const headers = { Accept: 'application/json', 'Opentrons-Version': '4', 'User-Agent': 'MOSS-Lab/0.1', ...(authorization ? { Authorization: authorization } : {}) }

  function send(method, target, body, contentType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
      let settled = false
      const finish = (action, value) => {
        if (settled) return
        settled = true
        action(value)
      }
      const request = transport(target, {
        method,
        agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
        headers: {
          ...headers,
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, response => {
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > config.maxBytes) {
            finish(reject, new RobotError('ROBOT_RESPONSE_TOO_LARGE', 'robot response exceeds the configured size limit'))
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => finish(resolve, { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      })
      request.setTimeout(timeoutMs, () => {
        finish(reject, new RobotError('ROBOT_TIMEOUT', `${method} ${target.pathname} timed out`))
        request.destroy()
      })
      request.on('error', error => {
        if (error instanceof RobotError) finish(reject, error)
        else finish(reject, new RobotError('ROBOT_UNREACHABLE', `${method} ${target.pathname} could not reach the robot`))
      })
      if (body !== null) request.write(body)
      request.end()
    })
  }

  async function request(method, pathname, { body = null, contentType = null, timeoutMs = config.timeoutMs, searchParams = null } = {}) {
    let target
    try {
      target = new URL(buildRobotUrl(base, pathname))
    } catch {
      throw new RobotError('ROBOT_URL_INVALID', 'robot URL configuration is invalid')
    }
    if (searchParams) for (const [key, value] of Object.entries(searchParams)) if (value !== undefined && value !== null) target.searchParams.set(key, String(value))
    // Tunneled lab robots reset idle connections; retry read-only calls, never uploads or actions.
    const attempts = method === 'GET' ? 3 : 1
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await send(method, target, body, contentType, timeoutMs)
        if (response.status < 200 || response.status >= 300) throw new RobotError('ROBOT_HTTP_ERROR', `${method} ${pathname} failed with HTTP ${response.status}: ${boundedText(response.text, 300)}`)
        if (!response.text) return null
        try {
          return JSON.parse(response.text)
        } catch {
          throw new RobotError('ROBOT_INVALID_RESPONSE', `${method} ${pathname} returned invalid JSON`)
        }
      } catch (error) {
        if (attempt >= attempts || !(error instanceof RobotError) || error.code !== 'ROBOT_UNREACHABLE') throw error
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }

  async function readStatus() {
    const [health, instruments, door, estop] = await Promise.all([
      request('GET', '/health').catch(error => ({ unavailable: String(error?.message ?? error) })),
      request('GET', '/instruments').catch(() => null),
      request('GET', '/robot/door/status').catch(() => null),
      request('GET', '/robot/control/estopStatus').catch(() => null),
    ])
    const identity = health?.unavailable ? { name: null, model: null, apiVersion: null, systemVersion: null } : robotIdentity(health)
    return {
      queriedAt: new Date().toISOString(),
      health: health?.unavailable ? { available: false, reason: boundedText(health.unavailable) } : { available: true, ...identity },
      instruments: instrumentList(instruments),
      door: doorState(door),
      estop: estopState(estop),
    }
  }

  async function uploadProtocol(protocol, filename = 'protocol.py') {
    if (Buffer.byteLength(protocol) > config.maxProtocolBytes) throw new RobotError('PROTOCOL_TOO_LARGE', 'protocol exceeds the configured upload limit')
    const form = multipart(protocol, filename)
    const payload = await request('POST', '/protocols', { body: form.body, contentType: `multipart/form-data; boundary=${form.boundary}` })
    const protocolId = unwrap(payload)?.id
    if (typeof protocolId !== 'string' || !protocolId) throw new RobotError('PROTOCOL_UPLOAD_FAILED', 'robot did not return a protocol id')
    return { protocolId }
  }

  async function createRun(protocolId) {
    const offsetsPayload = await request('GET', '/labwareOffsets').catch(() => null)
    const offsets = prepareOffsetsForRunCreate(Array.isArray(unwrap(offsetsPayload)) ? unwrap(offsetsPayload) : [])
    const payload = await request('POST', '/runs', { body: JSON.stringify(buildProtocolRunCreateBody({ protocolId, labwareOffsets: offsets.length > 0 ? offsets : null })), contentType: 'application/json' })
    const runId = unwrap(payload)?.id
    if (typeof runId !== 'string' || !runId) throw new RobotError('RUN_CREATE_FAILED', 'robot did not return a run id')
    return { runId }
  }

  async function runAction(runId, action) {
    if (typeof runId !== 'string' || !runId) throw new RobotError('RUN_ID_REQUIRED', 'a run id is required')
    if (!RUN_ACTIONS.has(action)) throw new RobotError('RUN_ACTION_INVALID', `unsupported run action: ${action}`)
    await request('POST', `/runs/${encodeURIComponent(runId)}/actions`, { body: JSON.stringify({ data: { actionType: action } }), contentType: 'application/json' })
    return { action, accepted: true }
  }

  async function getRun(runId) {
    if (typeof runId !== 'string' || !runId) throw new RobotError('RUN_ID_REQUIRED', 'a run id is required')
    const summary = runSummary(await request('GET', `/runs/${encodeURIComponent(runId)}`))
    if (!summary) throw new RobotError('RUN_INVALID_RESPONSE', 'robot returned an invalid run record')
    return summary
  }

  async function getCommands(runId, pageLength = 20) {
    if (typeof runId !== 'string' || !runId) throw new RobotError('RUN_ID_REQUIRED', 'a run id is required')
    const commands = commandList(await request('GET', `/runs/${encodeURIComponent(runId)}/commands`, { searchParams: { pageLength } }), pageLength)
    if (commands === null) throw new RobotError('RUN_INVALID_RESPONSE', 'robot returned an invalid command list')
    return commands
  }

  return { base, headers, status: readStatus, uploadProtocol, createRun, runAction, getRun, getCommands }
}
