import WebSocket from 'ws'

const tools = [
  {
    name: 'moss_status',
    description: '查询电脑端 MOSS 实验服务、委派能力和真机运行模式。live_control=approval_required 表示可让电脑端实验助手经网页确认后运行真机，语音端不能直接启动；该状态不代表机器人已就绪。',
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
    description: '把用户原话交给电脑上的当前实验助手。生成中改口也立即提交，最新要求覆盖旧要求；不要要求用户等旧任务结束。仅明确新实验时设newExperiment=true。严格按返回的speech.speak/text播报一次，然后持续调用moss_task_status观察最新任务；speech.speak=false时保持安静，禁止重复说还在等。最多3次等待提示，完成只简短播报一次；不表示真机实验完成。',
    inputSchema: { type: 'object', properties: { newExperiment: { type: 'boolean', description: '仅当用户明确要求另开新实验时为 true，普通补充和修改保持 false。' }, message: { type: 'string', minLength: 1, maxLength: 8000, description: '用户提出的完整任务和已知实验条件。' } }, required: ['message'], additionalProperties: false },
  },
  {
    name: 'moss_task_status',
    description: '持续观察MOSS任务。只在speech.speak=true时朗读speech.text一次；false时不要说等待、处理中或任何同义句，静默继续查询。遇followJobId改查最新任务。用户改口可立即moss_delegate。completed/error后停止自动查询，只说指定短句，不读JSON或复述方案。仅用户主动问进度时userQuery=true。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 128 }, userQuery: { type: 'boolean', description: '只有用户明确询问当前进度才为true，自动观察必须false。' } }, required: ['jobId'], additionalProperties: false },
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
export async function handleMessage(message, store, sessionId, delegation, context = {}) {
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
    let live = null
    try { live = typeof context.liveControl === 'function' ? context.liveControl() : context.liveControl } catch { live = null }
    const liveControl = live?.configured ? live?.allowLive ? 'approval_required' : 'disabled' : 'unavailable'
    const supportedTasks = ['experiment_protocol_authoring', 'local_analysis', '3d_preview', 'same_experiment_revision']
    if (delegation && liveControl === 'approval_required') supportedTasks.push('gated_real_robot_run')
    return response(id, text({
      experiment_store: 'available',
      delegation: Boolean(delegation),
      supported_tasks: delegation ? supportedTasks : [],
      device_status: 'not_checked',
      live_control: liveControl,
      note: liveControl === 'approval_required'
        ? '真机运行由电脑端实验助手执行，须协议分析通过并在网页上由现场操作员确认；语音端不能直接启动机器人，也不能代替确认。'
        : '这是电脑端 MOSS。可在此生成与修改实验协议并显示预览；当前语音桥不能启动真机运行。',
    }))
  }
  if (name === 'moss_delegate' || name === 'moss_task_status') {
    const key = name === 'moss_delegate' ? 'message' : 'jobId'
    if ((name === 'moss_delegate' ? Object.keys(args).some(key => !['message', 'newExperiment'].includes(key)) || (args.newExperiment !== undefined && typeof args.newExperiment !== 'boolean') : Object.keys(args).some(key => !['jobId', 'userQuery'].includes(key)) || args.userQuery !== undefined && typeof args.userQuery !== 'boolean') || typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (name === 'moss_delegate' ? 8000 : 128)) return failure(id, -32602, 'Invalid tool arguments')
    if (!delegation) return response(id, text({ error: '委派服务不可用。' }, true))
    try {
      if (name === 'moss_delegate') {
        const accepted = await delegation.submit(args.message, { newExperiment: args.newExperiment ?? false })
        return response(id, text(delegation.voiceReceipt ? { ...accepted, ...delegation.voiceReceipt(accepted.jobId) } : accepted))
      }
      return response(id, text(delegation.voiceStatus ? await delegation.voiceStatus(args.jobId, { userQuery: args.userQuery ?? false, signal: context.signal }) : delegation.get(args.jobId)))
    } catch (error) {
      return response(id, text({ error: String(error.message).slice(0, 300) }, true))
    }
  }
  if (name !== 'moss_experiment_status') return failure(id, -32602, 'Unknown tool')
  if (Object.keys(args).length !== 1 || typeof args.id !== 'string' || !args.id.trim() || args.id.length > 128) return failure(id, -32602, 'Invalid tool arguments')
  sessionId = delegation?.activeSessionId?.() ?? sessionId
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

/** Supervise one outbound MCP endpoint without replaying accepted Agent turns.
 * @param {object} options Endpoint, store, delegation and configurable transport budgets.
 * @returns {Function} Async disposer with a credential-free snapshot method.
 */
export function connectBridge({ url, sessionId, store, delegation, liveControl = null, WebSocketClass = WebSocket, onState = () => {}, reconnectMinMs = 1000, reconnectMaxMs = 30000, connectTimeoutMs = 10000, heartbeatMs = 20000 }) {
  if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim())) throw new Error('xiaozhi requires a fixed session ID or null')
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('xiaozhi endpoint is invalid') }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash) throw new Error('xiaozhi endpoint must be a secure WebSocket URL without userinfo or fragment')
  if (!store || typeof store.getForSession !== 'function' || typeof store.getChecksForSession !== 'function') throw new Error('xiaozhi requires the session-scoped experiment store')
  if (![reconnectMinMs, reconnectMaxMs, connectTimeoutMs, heartbeatMs].every(value => Number.isSafeInteger(value) && value > 0) || reconnectMaxMs < reconnectMinMs) throw new Error('xiaozhi transport budgets must be positive, with reconnectMaxMs >= reconnectMinMs')
  let socket, retryTimer, heartbeatTimer
  let attempts = 0
  let disposed = false
  let state = { status: 'connecting', reconnects: 0, registered: false, lastCall: null, updatedAt: Date.now() }
  const pending = new Set()
  const snapshot = () => ({ ...state, lastCall: state.lastCall === null ? null : { ...state.lastCall } })
  const notify = (status, extra = {}) => {
    state = { ...state, ...extra, status, updatedAt: Date.now() }
    try { onState(status, snapshot()) } catch { console.warn('xiaozhi status observer failed') }
  }
  const connect = () => {
    if (disposed) return
    notify('connecting', { registered: false })
    let current
    try { current = new WebSocketClass(parsed.href, { handshakeTimeout: connectTimeoutMs, maxPayload: 65536 }) }
    catch { scheduleRetry(); return }
    socket = current
    let alive = true
    const requests = new Map()
    current.on?.('pong', () => { alive = true })
    current.addEventListener('open', () => {
      if (disposed || socket !== current) return
      notify('connected')
      if (typeof current.ping === 'function') heartbeatTimer = setInterval(() => {
        if (!alive) { current.terminate(); return }
        alive = false
        try { current.ping() } catch { current.terminate() }
      }, heartbeatMs)
    })
    current.addEventListener('error', () => { if (!disposed && socket === current) notify('connection_error', { registered: false }) })
    current.addEventListener('close', () => {
      if (socket !== current) return
      for (const request of requests.values()) request.abort()
      clearInterval(heartbeatTimer)
      if (!disposed) scheduleRetry()
    })
    current.addEventListener('message', event => {
      if (disposed || socket !== current) return
      const controller = new AbortController()
      const operation = (async () => {
        let answer, message
        if (typeof event.data !== 'string' || event.data.length > 65536) answer = failure(null, -32600, 'Invalid Request')
        else {
          try { message = JSON.parse(event.data) } catch { answer = failure(null, -32700, 'Parse error') }
          if (message?.method === 'notifications/cancelled') { requests.get(JSON.stringify(message.params?.requestId))?.abort(); return }
          if (message && message.method === undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return
          if (message?.id !== undefined && requests.has(JSON.stringify(message.id))) return
          if (message?.id !== undefined) requests.set(JSON.stringify(message.id), controller)
          if (message !== undefined) {
            const name = message.method === 'tools/call' && tools.some(tool => tool.name === message.params?.name) ? message.params.name : null
            const receivedAt = Date.now()
            if (name !== null) notify(state.status, { lastCall: { name, status: 'received', receivedAt, source: 'xiaozhi-mcp' } })
            try { answer = await handleMessage(message, store, sessionId, delegation, { signal: controller.signal, liveControl }) }
            catch { answer = failure(message?.id ?? null, -32603, 'Internal error') }
            if (name !== null && !disposed && socket === current && !controller.signal.aborted) notify(state.status, { lastCall: { name, status: answer?.error || answer?.result?.isError ? 'error' : 'replied', receivedAt, source: 'xiaozhi-mcp' } })
          }
        }
        if (!disposed && !controller.signal.aborted && socket === current && answer && current.readyState === 1) {
          try {
            current.send(JSON.stringify(answer))
            if (message?.method === 'tools/list' && answer.result) {
              attempts = 0
              notify('ready', { registered: true })
            }
          } catch { if (!disposed) { notify('connection_error', { registered: false }); current.terminate?.() } }
        }
        if (message?.id !== undefined && requests.get(JSON.stringify(message.id)) === controller) requests.delete(JSON.stringify(message.id))
      })()
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => { pending.delete(operation); if (!disposed && socket === current) { notify('connection_error', { registered: false }); current.terminate?.() } })
    })
  }
  const scheduleRetry = () => {
    if (disposed) return
    clearTimeout(retryTimer)
    const wait = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(attempts++, 20))
    notify('retrying', { registered: false, reconnects: state.reconnects + 1 })
    retryTimer = setTimeout(connect, wait)
  }
  connect()
  const dispose = async () => {
    if (!disposed) {
      disposed = true
      clearTimeout(retryTimer); clearInterval(heartbeatTimer)
      if (socket && socket.readyState !== 3) {
        const current = socket
        if (typeof current.terminate === 'function') {
          await new Promise(resolve => { current.addEventListener('close', resolve, { once: true }); current.terminate() })
        } else current.close()
      }
    }
    await Promise.allSettled(pending)
    notify('stopped', { registered: false })
  }
  dispose.snapshot = snapshot
  return dispose
}
