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
    if (!object(item) || !['left', 'right'].includes(item.mount)) return null
    result.push({ mount: item.mount, name: safeText(item.instrumentName ?? item.name ?? item.model ?? item.instrumentModel, secrets) })
  }
  return result
}

async function readJson(url, headers, timeoutMs, maxBytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) return null
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch (error) {
    // Upstream errors may contain the configured address or credentials.
    return null
  } finally {
    controller.abort()
    clearTimeout(timer)
  }
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
  const headers = { 'Opentrons-Version': '4', Accept: 'application/json' }
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
        const [healthPayload, instrumentsPayload] = await Promise.all([
          readJson(new URL('/health', target), headers, config.timeoutMs, config.maxBytes),
          readJson(new URL('/instruments', target), headers, config.timeoutMs, config.maxBytes),
        ])
        health = healthResult(healthPayload, secrets)
        instruments = instrumentsResult(instrumentsPayload, secrets)
      }
      const status = !configured ? 'not_configured' : health && instruments ? 'ready' : health || instruments ? 'partial' : 'unreachable'
      return Response.json({ status, queriedAt, health, instruments }, { headers: { 'Cache-Control': 'private, no-store' } })
    },
  }), 'robot-status.route')
}
