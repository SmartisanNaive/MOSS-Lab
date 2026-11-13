import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegation } from './delegation.mjs'

function fixture({ timeoutMs = 10000, overrides = {}, failListener, sessionId = null } = {}) {
  const listeners = new Map()
  const events = {
    on(name, fn) {
      if (name === failListener) throw new Error('listener registration failed')
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
  }
  const requests = []
  const cancels = []
  let created = 0
  const { prompt: promptOverride, cancel: cancelOverride, ...otherOverrides } = overrides
  const controller = {
    async create() { return { sessionId: `session-${++created}` } },
    async rename() {},
    async prompt(input) { requests.push(input); if (promptOverride) await promptOverride(input) },
    async cancel(input) { cancels.push(input); if (cancelOverride) await cancelOverride(input) },
    ...otherOverrides,
  }
  const delegation = createDelegation({
    controller,
    workspaces: { list: () => [{ id: 'workspace' }] },
    events,
    timeoutMs,
    sessionId,
  })
  const emit = (name, ...args) => { for (const listener of [...listeners.get(name) ?? []]) listener(...args) }
  const request = index => requests[index]
  return {
    delegation,
    listeners,
    requests,
    cancels,
    get created() { return created },
    request,
    claim(index, turn = 1) {
      const input = request(index)
      emit('agent/inbox/claimed', { agent: { id: input.sessionId }, message: { source: { rpcId: input.requestId } }, turn })
    },
    end(index, text = '', turn = 1, reason = 'completed') {
      const input = request(index)
      if (text) emit('session/event', { id: input.sessionId }, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
      emit('session/event', { id: input.sessionId }, { type: 'turn/end', data: { turn, reason: { kind: reason } } })
    },
    ask(index, question, turn = 1, callId = 'ask-1') {
      const input = request(index)
      emit('session/event', { id: input.sessionId }, {
        type: 'tool/call',
        data: { turn, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question }] }) },
      })
    },
    answer(index, turn = 1, callId = 'ask-1') {
      const input = request(index)
      emit('session/event', { id: input.sessionId }, {
        type: 'tool/result',
        data: { turn, step: 1, callId, name: 'ask_user_question', result: JSON.stringify({ answers: [] }) },
      })
    },
  }
}

test('first delegate creates one session and reports only its completed turn', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('分析我的实验')
    assert.equal(accepted.sessionId, 'session-1')
    assert.equal(accepted.generation, 1)
    assert.equal(f.created, 1)
    assert.match(f.request(0).content[0].text, /来自小智的委派：\n分析我的实验/)
    f.claim(0, 3)
    f.end(0, '模拟完成', 3)
    const result = f.delegation.get(accepted.jobId)
    assert.equal(result.status, 'completed')
    assert.equal(result.result, '模拟完成')
    assert.equal(f.listeners.get('session/event').size, 0)
  } finally { f.delegation.close() }
})

test('a deployer-selected session is the first delegated conversation and is not recreated', async () => {
  const f = fixture({ sessionId: 'configured' })
  try {
    assert.equal(f.delegation.activeSessionId(), 'configured')
    const accepted = await f.delegation.submit('继续当前实验')
    assert.equal(accepted.sessionId, 'configured')
    assert.equal(f.created, 0)
    assert.equal(f.request(0).mode, 'queue')
  } finally { f.delegation.close() }
})

test('a missing initial session fails once and lets the next message start a new experiment', async () => {
  const missing = Object.assign(new Error('session not found'), { code: 'session/not-found' })
  const f = fixture({ sessionId: 'missing', overrides: { async prompt() { throw missing } } })
  try {
    const failed = await f.delegation.submit('继续')
    assert.equal(failed.status, 'error')
    assert.match(f.delegation.get(failed.jobId).result, /会话不存在/)
    assert.equal(f.delegation.activeSessionId(), null)
    assert.equal(f.created, 0)
  } finally { f.delegation.close() }
})

test('a follow-up while running revises the same session instead of opening a new experiment', async () => {
  const f = fixture()
  try {
    const first = await f.delegation.submit('每组 3 个重复')
    f.claim(0, 1)
    const second = await f.delegation.submit('每组 4 个重复')
    assert.equal(second.jobId, first.jobId)
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(second.generation, 2)
    assert.equal(f.created, 1)
    assert.equal(f.request(1).mode, 'steer')
    assert.match(f.request(1).content[0].text, /第 2 版）/)
    f.end(0, '旧结果', 1)
    assert.equal(f.delegation.get(first.jobId).status, 'running')
    f.claim(1, 2)
    f.end(1, '新结果', 2)
    const result = f.delegation.get(first.jobId)
    assert.equal(result.status, 'completed')
    assert.equal(result.result, '新结果')
  } finally { f.delegation.close() }
})

test('a follow-up after completion continues the same session as a new receipt', async () => {
  const f = fixture()
  try {
    const first = await f.delegation.submit('设计一个梯度稀释实验')
    f.claim(0, 1)
    f.end(0, '请确认每孔体积？', 1)
    const firstResult = f.delegation.get(first.jobId)
    assert.equal(firstResult.status, 'completed')
    assert.equal(firstResult.awaitingConfirmation, true)
    assert.equal(firstResult.speech.text, '请确认每孔体积？')
    const second = await f.delegation.submit('每孔 100 微升')
    assert.equal(second.sessionId, first.sessionId)
    assert.notEqual(second.jobId, first.jobId)
    assert.equal(second.generation, 1)
    assert.equal(f.created, 1)
    assert.equal(f.request(1).mode, 'queue')
    assert.match(f.request(1).content[0].text, /后续消息/)
    assert.equal(f.delegation.get(first.jobId).followJobId, second.jobId)
    assert.equal(f.delegation.get(first.jobId).speech.speak, false)
    f.claim(1, 2)
    f.end(1, '已更新', 2)
    assert.equal(f.delegation.get(second.jobId).result, '已更新')
  } finally { f.delegation.close() }
})

test('a mis-set newTask flag still answers the waiting experiment unless the wording asks for a new one', async () => {
  const f = fixture()
  try {
    const first = await f.delegation.submit('设计实验')
    f.claim(0, 1)
    f.end(0, '请确认每孔体积？', 1)
    const answer = await f.delegation.submit('每孔 100 微升', { newTask: true })
    assert.equal(answer.sessionId, first.sessionId)
    assert.equal(f.created, 1)
    f.claim(1, 2)
    f.end(1, '已更新', 2)
    const requested = await f.delegation.submit('新开一个实验', { newTask: true })
    assert.equal(f.created, 2)
    assert.notEqual(requested.sessionId, first.sessionId)
  } finally { f.delegation.close() }
})

test('newTask creates another session and supersedes the active task without losing the old receipt', async () => {
  const f = fixture()
  try {
    const first = await f.delegation.submit('第一组实验')
    f.claim(0, 1)
    const second = await f.delegation.submit('另一个新实验', { newTask: true })
    assert.equal(f.created, 2)
    assert.notEqual(second.sessionId, first.sessionId)
    assert.equal(f.delegation.get(first.jobId).status, 'error')
    assert.equal(f.delegation.get(first.jobId).supersededBy, second.jobId)
    assert.deepEqual(f.cancels, [{ sessionId: 'session-1' }])
    assert.equal(f.request(1).mode, 'queue')
    f.claim(1, 1)
    f.end(1, '新实验完成', 1)
    assert.equal(f.delegation.get(second.jobId).result, '新实验完成')
  } finally { f.delegation.close() }
})

test('a pending ask_user_question is surfaced, then answered by cancelling the blocked turn and continuing', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('设计实验')
    f.claim(0, 1)
    f.ask(0, '每孔最终体积是多少？', 1)
    const waiting = f.delegation.get(accepted.jobId)
    assert.equal(waiting.status, 'running')
    assert.equal(waiting.awaitingConfirmation, true)
    assert.equal(waiting.question, '每孔最终体积是多少？')
    assert.equal(waiting.speech.speak, true)
    assert.equal(waiting.speech.reason, 'needs_input')
    assert.equal(waiting.speech.text, '每孔最终体积是多少？')
    const again = f.delegation.get(accepted.jobId)
    assert.equal(again.speech.speak, false)
    const answer = await f.delegation.submit('每孔 100 微升')
    assert.equal(answer.sessionId, accepted.sessionId)
    assert.equal(answer.generation, 2)
    assert.equal(f.created, 1)
    assert.deepEqual(f.cancels, [{ sessionId: 'session-1' }])
    assert.equal(f.request(1).mode, 'queue')
    assert.match(f.request(1).content[0].text, /用户对确认的回复/)
    f.end(0, '已取消', 1, 'aborted')
    assert.equal(f.delegation.get(accepted.jobId).status, 'running')
    f.claim(1, 2)
    f.end(1, '按 100 微升生成', 2)
    const done = f.delegation.get(accepted.jobId)
    assert.equal(done.status, 'completed')
    assert.equal(done.result, '按 100 微升生成')
  } finally { f.delegation.close() }
})

test('a confirmation is not spoken twice when the running status already read it', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('设计实验')
    f.claim(0, 1)
    f.ask(0, '每孔最终体积是多少？', 1)
    assert.equal(f.delegation.get(accepted.jobId).speech.text, '每孔最终体积是多少？')
    f.end(0, '每孔最终体积是多少？', 1)
    const finished = f.delegation.get(accepted.jobId)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.awaitingConfirmation, true)
    assert.equal(finished.speech.speak, false)
  } finally { f.delegation.close() }
})

test('an explicit progress question bypasses the waiting budget and repeats the pending question', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('设计实验')
    f.claim(0, 1)
    f.ask(0, '每孔最终体积是多少？', 1)
    assert.equal(f.delegation.get(accepted.jobId).speech.speak, true)
    assert.equal(f.delegation.get(accepted.jobId).speech.speak, false)
    const asked = f.delegation.get(accepted.jobId, { userQuery: true })
    assert.equal(asked.speech.speak, true)
    assert.equal(asked.speech.reason, 'needs_input')
    assert.equal(asked.speech.text, '每孔最终体积是多少？')
    f.answer(0, 1)
    const progress = f.delegation.get(accepted.jobId, { userQuery: true })
    assert.equal(progress.speech.speak, true)
    assert.equal(progress.speech.reason, 'user_query')
  } finally { f.delegation.close() }
})

test('timeout keeps observing and accepts a same-session revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50 })
  try {
    const first = await f.delegation.submit('long task')
    t.mock.timers.tick(50)
    assert.equal(f.delegation.get(first.jobId).status, 'timeout')
    const second = await f.delegation.submit('changed conditions')
    assert.equal(second.jobId, first.jobId)
    assert.equal(f.request(1).mode, 'steer')
    f.claim(1, 2)
    f.end(1, '完成', 2)
    assert.equal(f.delegation.get(first.jobId).status, 'completed')
    assert.equal(f.listeners.get('session/event').size, 0)
  } finally { f.delegation.close() }
})

test('setup errors and close after timeout clean up listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failed = fixture({ overrides: { async rename() { throw new Error('rename failed') } } })
  try {
    await assert.rejects(failed.delegation.submit('task'), /rename failed/)
    assert.equal(failed.listeners.get('session/event')?.size ?? 0, 0)
  } finally { failed.delegation.close() }
  const timed = fixture({ timeoutMs: 50 })
  const accepted = await timed.delegation.submit('task')
  t.mock.timers.tick(50)
  timed.delegation.close()
  assert.equal(timed.listeners.get('session/event').size, 0)
  assert.match(timed.delegation.get(accepted.jobId).result, /可能仍在网页中运行/)
})

test('close during prompt admission reports an unknown outcome and removes listeners', async () => {
  let entered
  const gate = new Promise(resolve => { entered = resolve })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const f = fixture({ overrides: { async prompt() { entered(); await blocked } } })
  const pending = f.delegation.submit('task')
  await gate
  f.delegation.close()
  assert.equal(f.listeners.get('session/event').size, 0)
  release()
  const accepted = await pending
  assert.equal(accepted.status, 'error')
  assert.match(accepted.note, /可能仍在网页中运行/)
  assert.match(f.delegation.get(accepted.jobId).result, /可能仍在网页中运行/)
})

test('an ambiguous prompt error keeps the task observable until its turn completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ timeoutMs: 50, overrides: { async prompt() { throw new Error('admission failed') } } })
  try {
    const accepted = await f.delegation.submit('task')
    assert.match(f.delegation.get(accepted.jobId).result, /提交结果未知/)
    f.claim(0, 1)
    f.end(0, 'completed anyway', 1)
    assert.equal(f.delegation.get(accepted.jobId).status, 'completed')
  } finally { f.delegation.close() }
})

test('a terminal event wins over a later prompt error', async () => {
  let entered
  const gate = new Promise(resolve => { entered = resolve })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let request
  const f = fixture({ overrides: { async prompt(input) { request = input; entered(); await blocked } } })
  const pending = f.delegation.submit('task')
  await gate
  f.claim(0, 1)
  f.end(0, '完成', 1)
  release()
  const accepted = await pending
  assert.equal(accepted.status, 'completed')
  assert.equal(f.delegation.get(accepted.jobId).result, '完成')
  assert.equal(f.listeners.get('session/event').size, 0)
  void request
})

test('a turn without a completed reason is reported as an actionable error', async () => {
  const f = fixture()
  try {
    const accepted = await f.delegation.submit('task')
    f.claim(0, 1)
    f.end(0, 'partial', 1, 'aborted')
    const result = f.delegation.get(accepted.jobId)
    assert.equal(result.status, 'error')
    assert.match(result.result, /aborted/)
    assert.equal(result.speech.speak, true)
    assert.match(result.speech.text, /未正常完成/)
  } finally { f.delegation.close() }
})
