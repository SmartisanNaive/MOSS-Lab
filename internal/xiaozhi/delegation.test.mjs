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

test('timeout retains observation until the matching turn completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50 })
  try {
    const accepted = await f.delegation.submit('long task')
    t.mock.timers.tick(50)
    assert.equal(f.delegation.get(accepted.jobId).status, 'timeout')
    assert.equal(f.listeners.size, 3)
    claimAndEnd(f, f.request)
    assert.equal(f.delegation.get(accepted.jobId).status, 'completed')
    assert.equal(f.delegation.get(accepted.jobId).result, '完成')
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


test('a stopped turn reports its outcome in plain language', async () => {
  const f = fixture()
  try {
    const receipt = await f.delegation.submit('read-only explanation')
    claimAndEnd(f, f.request, 'aborted')
    const result = f.delegation.get(receipt.jobId)
    assert.equal(result.status, 'error')
    assert.equal(result.result, '本次生成已停止')
    assert.equal(f.listeners.size, 0)
  } finally { f.delegation.close() }
})
