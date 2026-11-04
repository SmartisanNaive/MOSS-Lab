/** Authenticated local text fallback and navigation state for the same MCP delegation. */
export function workbenchRoute(delegation) {
  return async request => {
    const headers = { 'Cache-Control': 'private, no-store' }
    if (request.method === 'GET') return Response.json(delegation.workbench(), { headers })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers })
    const origin = request.headers.get('origin')
    let trustedOrigin = false
    try {
      if (origin) { const parsed = new URL(origin); trustedOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === new URL(`${parsed.protocol}//${request.headers.get('host') ?? new URL(request.url).host}`).origin && parsed.origin === origin }
    } catch { trustedOrigin = false }
    if (!trustedOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: '请求来源不匹配' }, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: '需要 JSON 请求' }, { status: 400, headers })
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request.body ?? []) {
        size += chunk.byteLength
        if (size > 12000) throw new Error('请求内容过长')
        chunks.push(Buffer.from(chunk))
      }
      const text = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['message', 'newExperiment'].includes(key))) throw new Error('请求参数无效')
      return Response.json(await delegation.submit(body.message, { newExperiment: body.newExperiment === undefined ? false : body.newExperiment }), { headers })
    } catch (error) {
      return Response.json({ error: String(error.message).slice(0, 300) }, { status: 400, headers })
    }
  }
}

/** Register the browser status and bounded text-input methods on the owner carrier. */
export function registerWorkbench(connection, delegation) {
  const status = connection.fetch.register({ path: '/api/xiaozhi-workbench', methods: ['GET'], requestBody: 'buffered', fetch: workbenchRoute(delegation) })
  let message
  try {
    message = connection.fetch.register({ path: '/api/xiaozhi-workbench/message', methods: ['POST'], requestBody: 'streaming', fetch: workbenchRoute(delegation) })
  } catch (error) { void status(); throw error }
  return async () => { await status(); await message() }
}
