import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../robot-status-plugin.mjs'

async function serverFor(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function routeFor(t, url, overrides = {}) {
  const previous = process.env.OPENTRONS_URL
  if (url === undefined) delete process.env.OPENTRONS_URL
  else process.env.OPENTRONS_URL = url
  const ctx = new Context()
  let route
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => { route = undefined } } } })
  const fiber = ctx.plugin(plugin, { timeoutMs: 200, maxBytes: 4096, ...overrides })
  try {
    await fiber.await()
  } finally {
    if (previous === undefined) delete process.env.OPENTRONS_URL
    else process.env.OPENTRONS_URL = previous
  }
  t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose(); assert.equal(route, undefined) })
  assert.equal(route.path, '/api/robot-status')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
  return async () => {
    const response = await route.fetch(new Request('http://localhost/api/robot-status?url=http://example.invalid'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const value = await response.json()
    assert.equal(new Date(value.queriedAt).toISOString(), value.queriedAt)
    return value
  }
}

test('reads only the two fixed GET endpoints and projects safe fields', async t => {
  const requests = []
  const url = await serverFor(t, (req, res) => {
    requests.push([req.method, req.url, req.headers['opentrons-version']])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/health'
      ? { robot_model: 'OT-3 Standard', status: 'ok', robot_serial: 'secret' }
      : { data: [{ mount: 'left', instrumentName: 'flex_1channel_1000', serialNumber: 'secret' }] }))
  })
  const query = await routeFor(t, `${url}/ignored?secret=token`)
  const result = await query()
  assert.deepEqual({ ...result, queriedAt: undefined }, { status: 'ready', queriedAt: undefined, health: { status: 'ok', robotModel: 'OT-3 Standard' }, instruments: [{ mount: 'left', name: 'flex_1channel_1000' }] })
  assert.deepEqual(requests.sort(), [['GET', '/health', '4'], ['GET', '/instruments', '4']])
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('reports unconfigured, invalid, and unavailable targets without details', async t => {
  const missing = await routeFor(t, undefined)
  assert.deepEqual({ ...(await missing()), queriedAt: undefined }, { status: 'not_configured', queriedAt: undefined, health: null, instruments: null })
  const invalid = await routeFor(t, 'file:///private/password')
  assert.equal((await invalid()).status, 'unreachable')
  const unavailable = await serverFor(t, (req, res) => { res.statusCode = 503; res.end('http://secret:password@host/') })
  const query = await routeFor(t, unavailable)
  const value = await query()
  assert.equal(value.status, 'unreachable')
  assert.equal(JSON.stringify(value).includes('secret'), false)
})

test('keeps partial and empty results distinct and filters sensitive values', async t => {
  const url = await serverFor(t, (req, res) => {
    if (req.url === '/health') { res.statusCode = 500; res.end('private'); return }
    res.end(JSON.stringify({ data: [] }))
  })
  const query = await routeFor(t, url)
  const value = await query()
  assert.equal(value.status, 'partial')
  assert.equal(value.health, null)
  assert.deepEqual(value.instruments, [])
})

test('bounds slow or oversized responses and rejects redirects', async t => {
  const seen = []
  const url = await serverFor(t, (req, res) => {
    seen.push(req.url)
    if (req.url === '/health') { res.writeHead(302, { Location: '/forbidden' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ mount: 'left', instrumentName: 'x'.repeat(1000) }] }))
  })
  const query = await routeFor(t, url, { maxBytes: 128 })
  assert.equal((await query()).status, 'unreachable')
  assert.equal(seen.includes('/forbidden'), false)
  const slow = await serverFor(t, (req, res) => { res.writeHead(200); res.write('{') })
  const slowQuery = await routeFor(t, slow, { timeoutMs: 30 })
  assert.equal((await slowQuery()).status, 'unreachable')
})

test('omits configured credentials and address even in selected fields', async t => {
  const url = await serverFor(t, (req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`)
    res.end(JSON.stringify(req.url === '/health' ? { status: 'password', robotModel: '127.0.0.1' } : { data: [{ mount: 'left', name: 'user' }] }))
  })
  const query = await routeFor(t, url.replace('http://', 'http://user:password@'))
  const value = await query()
  assert.deepEqual(value.health, { status: null, robotModel: null })
  assert.deepEqual(value.instruments, [{ mount: 'left', name: null }])
})
