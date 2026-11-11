import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegation } from './delegation.mjs'
import { handleMessage } from './bridge.mjs'

function fixture({ timeoutMs = 10000, overrides = {}, failListener } = {}) {
  const listeners = new Map()
  const events = { on(name, fn) { if (name === failListener) throw new Error('listener registration failed'); listeners.set(name, fn); return () => listeners.delete(name) } }
  let request
  const controller = {
    async create(input) { assert.deepEqual(input, { workspaceId: 'workspace', agentPreset: 'standard' }); return { sessionId: 'session-1' } },
    async rename() {},
    async prompt(input) { request = input },
    ...overrides,
  }
  const delegation = createDelegation({ controller, workspaces: { list: () => [{ id: 'workspace' }] }, events, timeoutMs })
  return { delegation, listeners, get request() { return request } }
}

test('delegate appears in a workspace session and returns only its own completed turn', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('分析我的实验')
    assert.equal(accepted.sessionId, 'session-1')
    assert.match(f.request.content[0].text, /来自小智的委派：\n分析我的实验/)
    const claim = f.listeners.get('agent/inbox/claimed')
    const event = f.listeners.get('session/event')
    claim({ agent: { id: 'other' }, message: { source: { rpcId: f.request.requestId } }, turn: 3 })
    event({ id: 'session-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    assert.equal(f.delegation.get(accepted.jobId).status, 'running')
    claim({ agent: { id: 'session-1' }, message: { source: { rpcId: f.request.requestId } }, turn: 4 })
    event({ id: 'session-1' }, { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '模拟完成' }] } } })
    event({ id: 'session-1' }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    assert.equal(f.delegation.get(accepted.jobId).result, '模拟完成')
    assert.equal(f.delegation.get(accepted.jobId).status, 'completed')
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
})

test('MCP polling shares three waiting replies across timeout and announces completion once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50 })
  try {
    const accepted = await f.delegation.submit('task')
    const poll = async () => {
      const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'moss_task_status', arguments: { jobId: accepted.jobId } } }, {}, null, f.delegation)
      return JSON.parse(reply.result.content[0].text)
    }
    assert.equal((await poll()).speech.speak, true)
    t.mock.timers.tick(50)
    for (let i = 0; i < 2; i++) {
      const waiting = await poll()
      assert.equal(waiting.status, 'timeout')
      assert.equal(waiting.speech.speak, true)
      assert.match(waiting.speech.text, /网页会话/)
    }
    for (let i = 0; i < 10; i++) {
      const silent = await poll()
      assert.equal(silent.status, 'timeout')
      assert.match(silent.result, /超时/)
      assert.deepEqual(silent.speech, { speak: false, text: null })
    }
    claimAndEnd(f, f.request)
    const completed = await poll()
    assert.equal(completed.result, '完成')
    assert.deepEqual(completed.speech, { speak: true, text: '任务已完成，请在网页会话中查看结果。' })
    for (let i = 0; i < 10; i++) {
      const silent = await poll()
      assert.equal(silent.status, 'completed')
      assert.equal(silent.result, completed.result)
      assert.deepEqual(silent.speech, { speak: false, text: null })
    }
    const next = await f.delegation.submit('next')
    assert.equal(f.delegation.get(next.jobId).speech.speak, true)
  } finally { f.delegation.close() }
})

test('completion before polling preserves multiline result and emits only one fixed sentence', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('task')
    f.listeners.get('agent/inbox/claimed')({ agent: { id: 'session-1' }, message: { source: { rpcId: f.request.requestId } }, turn: 2 })
    const event = f.listeners.get('session/event')
    const result = '第一行。\n第二行！\n第三行？'
    event({ id: 'session-1' }, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: result }] } } })
    event({ id: 'session-1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    const first = f.delegation.get(accepted.jobId)
    assert.equal(first.result, result)
    assert.equal(first.speech.text, '任务已完成，请在网页会话中查看结果。')
    assert.deepEqual(f.delegation.get(accepted.jobId).speech, { speak: false, text: null })
  } finally { f.delegation.close() }
})

test('failed jobs give one actionable speech reply and retain error details', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('task')
    claimAndEnd(f, f.request, 'aborted')
    const failed = f.delegation.get(accepted.jobId)
    assert.equal(failed.status, 'error')
    assert.match(failed.result, /aborted/)
    assert.deepEqual(failed.speech, { speak: true, text: '任务未正常完成，请在网页会话中核查状态后再决定下一步。' })
    assert.deepEqual(f.delegation.get(accepted.jobId).speech, { speak: false, text: null })
    assert.throws(() => f.delegation.get('unknown'), /网页会话.*确认结果后再委派/)
  } finally { f.delegation.close() }
})

test('A to B to C revisions reuse one session and budget and ignore superseded turns', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests = []
  let creates = 0
  const f = fixture({ timeoutMs: 50, overrides: {
    async create() { creates++; return { sessionId: 'session-1' } },
    async prompt(input) { requests.push(input) },
  } })
  try {
    const a = await f.delegation.submit('A')
    const claim = f.listeners.get('agent/inbox/claimed')
    const event = f.listeners.get('session/event')
    const claimed = (request, turn) => claim({ agent: { id: 'session-1' }, message: { source: { rpcId: request.requestId } }, turn })
    const answer = (turn, text) => event({ id: 'session-1' }, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    const end = turn => event({ id: 'session-1' }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    claimed(requests[0], 1)
    answer(1, 'old A preview')
    for (let i = 0; i < 3; i++) assert.equal(f.delegation.get(a.jobId).speech.speak, true)
    t.mock.timers.tick(50)
    const b = await f.delegation.submit('B')
    claimed(requests[1], 1)
    answer(1, 'old B preview')
    const c = await f.delegation.submit('C')
    assert.equal(creates, 1)
    assert.equal(b.jobId, a.jobId)
    assert.equal(c.jobId, a.jobId)
    assert.equal(c.sessionId, a.sessionId)
    assert.equal(c.generation, 3)
    assert.deepEqual(requests.map(request => request.mode), ['queue', 'steer', 'steer'])
    assert.match(requests[2].content[0].text, /第 3 版.*\nC\n/)
    assert.match(requests[2].content[0].text, /此前要求冲突的分析和预览均已失效/)
    claimed(requests[0], 1)
    answer(1, 'late A')
    end(1)
    f.listeners.get('agent/inbox/discarded')({ agent: { id: 'session-1' }, message: { source: { rpcId: requests[1].requestId } } })
    const waiting = f.delegation.get(a.jobId)
    assert.equal(waiting.status, 'timeout')
    assert.equal(waiting.result, null)
    assert.deepEqual(waiting.speech, { speak: false, text: null })
    claimed(requests[2], 2)
    answer(1, 'late old turn')
    end(1)
    assert.equal(f.delegation.get(a.jobId).status, 'timeout')
    answer(2, 'latest C preview')
    end(2)
    const completed = f.delegation.get(a.jobId)
    assert.equal(completed.result, 'latest C preview')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.generation, 3)
    assert.equal(completed.speech.speak, true)
    assert.equal(f.delegation.get(a.jobId).speech.speak, false)
  } finally { f.delegation.close() }
})

test('revisions claimed within the same turn clear earlier answer text', async () => {
  const f = fixture()
  try {
    const a = await f.delegation.submit('A')
    const oldRequest = f.request
    const claim = f.listeners.get('agent/inbox/claimed')
    const event = f.listeners.get('session/event')
    claim({ agent: { id: 'session-1' }, message: { source: { rpcId: oldRequest.requestId } }, turn: 1 })
    event({ id: 'session-1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'A' }] } } })
    await f.delegation.submit('B')
    claim({ agent: { id: 'session-1' }, message: { source: { rpcId: f.request.requestId } }, turn: 1 })
    event({ id: 'session-1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'B' }] } } })
    event({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(f.delegation.get(a.jobId).result, 'B')
  } finally { f.delegation.close() }
})

test('revisions during setup coalesce to the latest requirement without a second session', async () => {
  const gate = deferred()
  const entered = deferred()
  const requests = []
  let creates = 0
  const f = fixture({ overrides: {
    async create() { creates++; entered.resolve(); await gate.promise; return { sessionId: 'session-1' } },
    async prompt(input) { requests.push(input) },
  } })
  const a = f.delegation.submit('A')
  await entered.promise
  const b = f.delegation.submit('B')
  const c = f.delegation.submit('C')
  try {
    gate.resolve()
    const replies = await Promise.all([a, b, c])
    assert.equal(creates, 1)
    assert.equal(new Set(replies.map(reply => reply.jobId)).size, 1)
    assert.equal(requests.length, 1)
    assert.match(requests[0].content[0].text, /第 3 版.*\nC\n/)
    assert.deepEqual(replies.map(reply => reply.currentGeneration), [3, 3, 3])
  } finally { gate.resolve(); f.delegation.close() }
})

test('late old admission failure cannot overwrite the latest revision result', async () => {
  const gate = deferred()
  const entered = deferred()
  const requests = []
  const f = fixture({ overrides: { async prompt(input) {
    requests.push(input)
    if (requests.length === 1) { entered.resolve(); await gate.promise }
    else throw new Error('latest admission uncertain')
  } } })
  const a = f.delegation.submit('A')
  await entered.promise
  const c = f.delegation.submit('C')
  try {
    gate.reject(new Error('old admission uncertain'))
    const [old, latest] = await Promise.all([a, c])
    assert.equal(old.jobId, latest.jobId)
    const waiting = f.delegation.get(latest.jobId)
    assert.equal(waiting.generation, 2)
    assert.match(waiting.result, /latest admission uncertain/)
    assert.doesNotMatch(waiting.result, /old admission uncertain/)
    claimAndEnd(f, requests[1])
    assert.equal(f.delegation.get(latest.jobId).result, '完成')
  } finally { gate.resolve(); f.delegation.close() }
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function claimAndEnd(f, request, reason = 'completed') {
  f.listeners.get('agent/inbox/claimed')({ agent: { id: 'session-1' }, message: { source: { rpcId: request.requestId } }, turn: 2 })
  const event = f.listeners.get('session/event')
  event({ id: 'session-1' }, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '完成' }] } } })
  event({ id: 'session-1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: reason } } })
}

test('timeout retains observation and concurrency until the matching turn completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50 })
  try {
    const accepted = await f.delegation.submit('long task')
    t.mock.timers.tick(50)
    assert.equal(f.delegation.get(accepted.jobId).status, 'timeout')
    assert.equal(f.listeners.size, 3)
    claimAndEnd(f, f.request)
    assert.deepEqual(f.delegation.get(accepted.jobId), { jobId: accepted.jobId, sessionId: accepted.sessionId, status: 'completed', generation: 1, result: '完成', speech: { speak: true, text: '任务已完成，请在网页会话中查看结果。' } })
    assert.equal(f.listeners.size, 0)
    assert.equal((await f.delegation.submit('second')).status, 'running')
  } finally { f.delegation.close() }
  assert.equal(f.listeners.size, 0)
})

test('discard and failed turns after timeout release listeners and the concurrency slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50 })
  try {
    const discarded = await f.delegation.submit('discard')
    t.mock.timers.tick(50)
    f.listeners.get('agent/inbox/discarded')({ agent: { id: 'session-1' }, message: { source: { rpcId: f.request.requestId } } })
    assert.equal(f.delegation.get(discarded.jobId).status, 'error')
    assert.equal(f.listeners.size, 0)
    const failed = await f.delegation.submit('fail')
    t.mock.timers.tick(50)
    claimAndEnd(f, f.request, 'aborted')
    assert.equal(f.delegation.get(failed.jobId).status, 'error')
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
})

for (const phase of ['create', 'rename']) {
  test(`close during ${phase} prevents prompt submission`, async () => {
    const gate = deferred()
    const entered = deferred()
    let prompts = 0
    const overrides = {
      [phase]: async () => { entered.resolve(); return gate.promise },
      async prompt() { prompts++ },
    }
    const f = fixture({ overrides })
    const pending = f.delegation.submit('task')
    try {
      await entered.promise
      f.delegation.close()
      gate.resolve(phase === 'create' ? { sessionId: 'session-1' } : undefined)
      await assert.rejects(pending, /已关闭/)
      assert.equal(prompts, 0)
      assert.equal(f.listeners.size, 0)
      await assert.rejects(f.delegation.submit('second'), /已关闭/)
    } finally { gate.resolve(); f.delegation.close() }
  })
}

test('close during prompt admission reports unknown outcome and removes listeners', async () => {
  const gate = deferred()
  const entered = deferred()
  const f = fixture({ overrides: { async prompt() { entered.resolve(); await gate.promise } } })
  const pending = f.delegation.submit('task')
  try {
    await entered.promise
    assert.equal(f.listeners.size, 3)
    f.delegation.close()
    assert.equal(f.listeners.size, 0)
    gate.resolve()
    const accepted = await pending
    assert.equal(accepted.status, 'error')
    assert.match(accepted.note, /可能仍在网页中运行/)
    assert.match(f.delegation.get(accepted.jobId).result, /可能仍在网页中运行/)
  } finally { gate.resolve(); f.delegation.close() }
})

test('an ambiguous prompt error keeps the job active and observable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let request
  const f = fixture({ timeoutMs: 50, overrides: { async prompt(input) { request = input; throw new Error('admission failed') } } })
  try {
    const accepted = await f.delegation.submit('task')
    assert.equal(accepted.status, 'running')
    assert.match(f.delegation.get(accepted.jobId).result, /提交结果未知/)
    t.mock.timers.tick(50)
    assert.equal(f.delegation.get(accepted.jobId).status, 'timeout')
    claimAndEnd(f, request)
    assert.equal(f.delegation.get(accepted.jobId).status, 'completed')
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
})

test('setup errors and close after timeout clean up listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ overrides: { async rename() { throw new Error('rename failed') } } })
  try {
    await assert.rejects(f.delegation.submit('task'), /rename failed/)
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
  const timed = fixture({ timeoutMs: 50 })
  const accepted = await timed.delegation.submit('task')
  t.mock.timers.tick(50)
  timed.delegation.close()
  assert.equal(timed.listeners.size, 0)
  assert.match(timed.delegation.get(accepted.jobId).result, /可能仍在网页中运行/)
})

test('partial listener registration errors release already registered listeners', async () => {
  const f = fixture({ failListener: 'session/event' })
  try {
    await assert.rejects(f.delegation.submit('task'), /listener registration failed/)
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
})

test('a terminal event wins over a later prompt error', async () => {
  const gate = deferred()
  const entered = deferred()
  let request
  const f = fixture({ overrides: { async prompt(input) { request = input; entered.resolve(); await gate.promise } } })
  const pending = f.delegation.submit('task')
  try {
    await entered.promise
    claimAndEnd(f, request)
    gate.reject(new Error('late error'))
    const accepted = await pending
    assert.equal(accepted.status, 'completed')
    assert.equal(f.delegation.get(accepted.jobId).result, '完成')
    assert.equal(f.listeners.size, 0)
  } finally { gate.resolve(); f.delegation.close() }
})

test('MCP delegates and reports task errors without accepting a session argument', async () => {
  const f = fixture()
  const store = { getForSession() {}, getChecksForSession() {} }
  try {
    const call = (id, name, args) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, store, null, f.delegation)
    const reply = await call(1, 'moss_delegate', { message: '模拟实验' })
    const accepted = JSON.parse(reply.result.content[0].text)
    assert.equal(accepted.sessionId, 'session-1')
    assert.equal((await call(2, 'moss_delegate', { message: 'x', sessionId: 'other' })).error.code, -32602)
    const error = await call(3, 'moss_task_status', { jobId: 'unknown' })
    assert.equal(error.result.isError, true)
  } finally { f.delegation.close() }
})
