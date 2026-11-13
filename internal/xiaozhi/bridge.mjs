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
    description: '把用户原话交给本地网页实验助手。已在处理或刚结束的任务默认继续同一网页会话；生成中改口也立即提交，最新要求覆盖旧要求。只有用户明确要求另开新实验时才设 newTask=true；实验助手等待确认时，即使误设 true，只要原话没有明确新实验也会作为回答继续。实验助手追问确认时，把用户回答再次交给此工具即可继续同一实验。返回任务编号、会话、generation 和 currentGeneration；稍后用 moss_task_status 查询。不会授权真实设备运行。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 8000, description: '用户提出的完整任务、补充条件或对确认的回答。' },
        newTask: { type: 'boolean', description: '仅当用户明确要求另开新实验时为 true；补充、改口和回答确认都保持 false。' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'moss_task_status',
    description: '查询任务状态、待确认问题和播报决策。语音只按 speech.text 播报一次；speak=false 时保持静默，不要朗读或概述 result。awaitingConfirmation=true 时 speech.text 是实验助手等待用户回答的问题，用户回答后再次调用 moss_delegate（newTask=false）继续同一会话。只有用户明确询问进度时才设 userQuery=true；若返回 followJobId，改查该任务以获取同一实验的最新回执。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', minLength: 1, maxLength: 128 },
        userQuery: { type: 'boolean', description: '只有用户明确询问当前进度才为 true；自动观察保持 false。' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
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
    const allowed = name === 'moss_delegate' ? ['message', 'newTask'] : ['jobId', 'userQuery']
    const booleanKey = name === 'moss_delegate' ? 'newTask' : 'userQuery'
    if (Object.keys(args).some(argument => !allowed.includes(argument))
      || typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (name === 'moss_delegate' ? 8000 : 128)
      || (args[booleanKey] !== undefined && typeof args[booleanKey] !== 'boolean')) return failure(id, -32602, 'Invalid tool arguments')
    if (!delegation) return response(id, text({ error: '委派服务不可用。' }, true))
    try {
      return response(id, text(name === 'moss_delegate'
        ? await delegation.submit(args.message, { newTask: args.newTask ?? false })
        : delegation.get(args.jobId, { userQuery: args.userQuery ?? false })))
    } catch (error) {
      return response(id, text({ error: String(error.message).slice(0, 300) }, true))
    }
  }
  if (name !== 'moss_experiment_status') return failure(id, -32602, 'Unknown tool')
  if (Object.keys(args).length !== 1 || typeof args.id !== 'string' || !args.id.trim() || args.id.length > 128) return failure(id, -32602, 'Invalid tool arguments')
  const currentSession = delegation?.activeSessionId?.() ?? sessionId
  if (currentSession === null) return response(id, text({ error: '尚未绑定网页实验会话。' }, true))
  try {
    const experiment = await store.getForSession(currentSession, args.id)
    const checks = await store.getChecksForSession(currentSession, args.id, experiment.revision)
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
