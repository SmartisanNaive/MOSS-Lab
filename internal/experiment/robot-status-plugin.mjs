import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

// Reuse TLS connections; the tunnel resets idle ones, and retries cover that.
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 4 })
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4 })

export const name = 'robot-status'
export const inject = ['connection']

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value, secrets) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_ .-]{1,100}$/.test(value) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value)) return null
  const lower = value.toLowerCase()
  return secrets.some(secret => secret && lower.includes(secret.toLowerCase())) ? null : value
}

function healthResult(payload, secrets) {
  const data = object(payload) && 'data' in payload ? payload.data : payload
  if (!object(data)) return null
  return {
    status: safeText(data.status, secrets),
    robotModel: safeText(data.robot_model ?? data.robotModel, secrets),
  }
}

function instrumentsResult(payload, secrets) {
  const data = object(payload) && 'data' in payload ? payload.data : payload
  if (!Array.isArray(data)) return null
  const result = []
  for (const item of data) {
    if (!object(item)) return null
    // Flex also lists the gripper with mount "extension"; this route reports pipettes only.
    if (item.mount !== 'left' && item.mount !== 'right') continue
    result.push({ mount: item.mount, name: safeText(item.instrumentName ?? item.name ?? item.model ?? item.instrumentModel, secrets) })
  }
  return result
}

function readJson(url, headers, timeoutMs, maxBytes) {
  // The tunneled robot resets fetch/undici connections and ignores redirects, so use the
  // Node HTTP transport with explicit bounds. Failures return null without the target.
  return new Promise(resolve => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      request = transport(url, { method: 'GET', headers, agent: url.protocol === 'https:' ? httpsAgent : httpAgent }, response => {
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > maxBytes) {
            finish(null)
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (settled) return
          if (response.statusCode < 200 || response.statusCode >= 300) return finish(null)
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            finish(null)
          }
        })
      })
    } catch {
      finish(null)
      return
    }
    request.setTimeout(timeoutMs, () => {
      finish(null)
      request.destroy()
    })
    request.on('error', () => finish(null))
    request.end()
  })
}

/**
 * Register GET /api/robot-status on the authenticated connection carrier.
 * The response has status (not_configured, unreachable, partial, or ready),
 * queriedAt (ISO 8601), health ({ status, robotModel } or null), and
 * instruments (array of { mount, name } or null). Null fields are unavailable;
 * an empty instruments array means the query succeeded with no instruments.
 * The environment target is read once, and failures never expose its value.
 */
export function apply(ctx, config) {
  if (!config || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || !Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) throw new Error('robot-status requires positive timeoutMs and maxBytes')
  const configuredUrl = process.env.OPENTRONS_URL
  const configured = typeof configuredUrl === 'string' && configuredUrl.trim() !== ''
  let target = null
  const headers = { 'Opentrons-Version': '4', Accept: 'application/json', 'User-Agent': 'MOSS-Lab/0.1' }
  const secrets = []
  if (configured) {
    try {
      const parsed = new URL(configuredUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol')
      secrets.push(parsed.hostname, decodeURIComponent(parsed.username), decodeURIComponent(parsed.password), ...parsed.searchParams.values())
      if (parsed.username || parsed.password) headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
      parsed.username = ''
      parsed.password = ''
      target = parsed.origin
    } catch (error) {
      // Invalid configuration is reported as unreachable without exposing its value.
    }
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/robot-status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const queriedAt = new Date().toISOString()
      let health = null
      let instruments = null
      if (target) {
        // The tunneled robot resets concurrent or idle reads, so query sequentially and retry once.
        const read = async resource => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const payload = await readJson(new URL(resource, target), headers, config.timeoutMs, config.maxBytes)
            if (payload !== null) return payload
            await new Promise(resolve => setTimeout(resolve, 150))
          }
          return null
        }
        health = healthResult(await read('/health'), secrets)
        instruments = instrumentsResult(await read('/instruments'), secrets)
      }
      const status = !configured ? 'not_configured' : health && instruments ? 'ready' : health || instruments ? 'partial' : 'unreachable'
      return Response.json({ status, queriedAt, health, instruments }, { headers: { 'Cache-Control': 'private, no-store' } })
    },
  }), 'robot-status.route')
}
