const tools = [
  {
    name: 'moss_status',
    description: '查询 MOSS 实验服务是否可用；不代表设备已连接或实验可运行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'moss_experiment_status',
    description: '按实验 ID 查询已绑定会话中的实验版本和检查状态。检查记录不代表真机运行许可。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'moss_delegate',
    description: '将实验需求委派给本地网页 Agent；若已有运行或超时任务，则把本条作为同一任务的最新要求送入同一网页会话，替代冲突的旧要求，请提供完整最新需求。返回任务编号、会话、generation 和 currentGeneration；较旧代次的返回不能覆盖最新状态，使用 moss_task_status 查询当前结果。改口不重置等待播报预算，不撤回已执行操作，不授权真实设备运行。',
    inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 8000, description: '用户提出的完整任务和已知实验条件。' } }, required: ['message'], additionalProperties: false },
  },
  {
    name: 'moss_task_status',
    description: '查询委派任务的机器状态和完整 result；语音必须遵守 speech：仅当 speak=true 时原样播报 text 一次，speak=false 时保持静默，不得朗读或改写 result、状态或自行追加等待提示。每任务前三次等待查询可播报，之后静默；完成只提醒一句且只一次。查询会消费播报机会，不保证设备已播出。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['jobId'], additionalProperties: false },
  },
]

function response(id, result) { return { jsonrpc: '2.0', id, result } }
function failure(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } } }
function text(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}

/** Handle an MCP JSON-RPC message using only the fixed session's read methods.
 * @param {unknown} message Incoming JSON value.
 * @param {object} store Experiment store service.
 * @param {string} sessionId Deployment-selected session identity.
 * @returns {Promise<object|null>} JSON-RPC response, or null for a notification.
 */
export async function handleMessage(message, store, sessionId, delegation) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(null, -32600, 'Invalid Request')
  const hasId = Object.hasOwn(message, 'id')
  if (hasId && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)) || message.id === null)) return failure(null, -32600, 'Invalid Request')
  if (!hasId) return null
  const { id, method, params } = message
  if (method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18']
    const version = supported.includes(params?.protocolVersion) ? params.protocolVersion : '2024-11-05'
    return response(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'moss-xiaozhi-readonly', version: '0.1.0' } })
  }
  if (method === 'ping') return response(id, {})
  if (method === 'tools/list') return response(id, { tools })
  if (method !== 'tools/call') return failure(id, -32601, 'Method not found')
  const name = params?.name
  const args = params?.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure(id, -32602, 'Invalid tool arguments')
  if (name === 'moss_status') {
    if (Object.keys(args).length) return failure(id, -32602, 'Invalid tool arguments')
    return response(id, text({ experiment_store: 'available', device_status: 'unknown', live_control: 'unavailable' }))
  }
  if (name === 'moss_delegate' || name === 'moss_task_status') {
    const key = name === 'moss_delegate' ? 'message' : 'jobId'
    if (Object.keys(args).length !== 1 || typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (name === 'moss_delegate' ? 8000 : 128)) return failure(id, -32602, 'Invalid tool arguments')
    if (!delegation) return response(id, text({ error: '委派服务不可用，请检查本地网页应用及桥接配置后重试。' }, true))
    try {
      return response(id, text(name === 'moss_delegate' ? await delegation.submit(args.message) : delegation.get(args.jobId)))
    } catch (error) {
      return response(id, text({ error: String(error.message).slice(0, 300) }, true))
    }
  }
  if (name !== 'moss_experiment_status') return failure(id, -32602, 'Unknown tool')
  if (Object.keys(args).length !== 1 || typeof args.id !== 'string' || !args.id.trim() || args.id.length > 128) return failure(id, -32602, 'Invalid tool arguments')
  if (sessionId === null) return response(id, text({ error: '尚未绑定网页实验会话。' }, true))
  try {
    const experiment = await store.getForSession(sessionId, args.id)
    const checks = await store.getChecksForSession(sessionId, args.id, experiment.revision)
    const latest = new Map()
    for (const check of checks) latest.set(check.name, check.status)
    return response(id, text({ id: experiment.id, revision: experiment.revision, created_at: experiment.createdAt, checks: [...latest].slice(-20).map(([name, status]) => ({ name: String(name).slice(0, 100), status })), note: '检查记录由本地存储提供，不表示真机就绪。' }))
  } catch {
    return response(id, text({ error: '实验不存在、不可访问或存储不可用。' }, true))
  }
}

/** Start one outbound bridge; caller owns disposal and any reconnection policy.
 * @param {{ url: string, sessionId: string, store: object, WebSocketClass?: typeof WebSocket, onState?: Function }} options Bridge configuration.
 * @returns {() => void} Disposes the connection.
 */
export function connectBridge({ url, sessionId, store, delegation, WebSocketClass = WebSocket, onState = () => {} }) {
  if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim())) throw new Error('xiaozhi requires a fixed session ID or null')
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('xiaozhi endpoint is invalid') }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash) throw new Error('xiaozhi endpoint must be a secure WebSocket URL without userinfo or fragment')
  if (!store || typeof store.getForSession !== 'function' || typeof store.getChecksForSession !== 'function') throw new Error('xiaozhi requires the session-scoped experiment store')
  let socket
  try { socket = new WebSocketClass(parsed.href) } catch { throw new Error('xiaozhi connection could not be created') }
  let disposed = false
  socket.addEventListener('open', () => { if (!disposed) onState('connected') })
  socket.addEventListener('error', () => { if (!disposed) onState('connection_error') })
  socket.addEventListener('close', () => { if (!disposed) onState('disconnected') })
  socket.addEventListener('message', async event => {
    if (disposed) return
    let answer
    if (typeof event.data !== 'string' || event.data.length > 65536) answer = failure(null, -32600, 'Invalid Request')
    else {
      let parsedMessage
      try { parsedMessage = JSON.parse(event.data) } catch { answer = failure(null, -32700, 'Parse error') }
      if (parsedMessage !== undefined) {
        try { answer = await handleMessage(parsedMessage, store, sessionId, delegation) }
        catch { answer = failure(parsedMessage?.id ?? null, -32603, 'Internal error') }
      }
    }
    if (!disposed && answer && socket.readyState === 1) {
      try { socket.send(JSON.stringify(answer)) } catch { if (!disposed) onState('connection_error') }
    }
  })
  return () => { disposed = true; socket.close() }
}
