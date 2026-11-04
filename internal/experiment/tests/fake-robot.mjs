import { createServer } from 'node:http'

/** Start a local robot-shaped HTTP server; `handler` receives { method, path, query, headers, body }. */
export async function startFakeRobot(handler) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const body = Buffer.concat(chunks)
      requests.push({ method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body })
      let result
      try {
        result = await handler({ method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body })
      } catch (error) {
        result = { status: 500, body: { error: String(error?.message ?? error) } }
      }
      const status = result?.status ?? 200
      const payload = result?.body ?? {}
      response.writeHead(status, { 'Content-Type': 'application/json', ...(result?.headers ?? {}) })
      response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

/** Standard read-only health, instrument, door, and emergency-stop responses. */
export function healthyRobot(overrides = {}) {
  return ({ path }) => {
    const routes = {
      '/health': { body: { name: 'FakeBot', robot_model: 'OT-3 Standard', api_version: '9.0.0', system_version: 'v0.0.1' } },
      '/instruments': { body: { data: [{ mount: 'left', instrumentModel: 'p1000_single_v3.6' }, { mount: 'right', instrumentModel: 'p1000_multi_v3.5' }] } },
      '/robot/door/status': { body: { data: { status: 'closed', doorRequiredClosedForProtocol: true } } },
      '/robot/control/estopStatus': { body: { data: { status: 'disengaged' } } },
      '/labwareOffsets': { body: { data: [] } },
    }
    return { ...(routes[path] ?? { status: 404, body: { error: 'not found' } }), ...(overrides[path] ?? {}) }
  }
}
