import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectBridge, handleMessage } from './bridge.mjs'

let ExperimentStore
try { ({ ExperimentStore } = await import('../experiment/index.mjs')) } catch { ExperimentStore = undefined }

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })
const payload = result => JSON.parse(result.result.content[0].text)

function store() {
  const checks = [{ name: 'simulation', status: 'passed', result: { private: 'secret result' } }]
  return {
    async getForSession(session, id) {
      assert.equal(session, 'owner')
      return { id, revision: 1, createdAt: 1, snapshot: { privateNote: 'secret note' } }
    },
    async getChecksForSession(session, id, revision) {
      assert.equal(session, 'owner')
      assert.equal(revision, 1)
      return checks
    },
  }
}

const delegation = {
  async submit(message, options) {
    assert.equal(message.trim().length > 0, true)
    return { jobId: options.newTask ? 'job-new' : 'job-1', sessionId: options.newTask ? 'session-2' : 'session-1', status: 'running', generation: 1, currentGeneration: 1 }
  },
  get(jobId) {
    assert.equal(jobId, 'job-1')
    return { jobId, sessionId: 'session-1', status: 'completed', result: '完成', awaitingConfirmation: true, question: '每孔体积？', speech: { speak: true, text: '每孔体积？', reason: 'needs_input' }, supersededBy: null, followJobId: null }
  },
  activeSessionId() { return 'session-1' },
}

test('tool calls are restricted to an operator-selected session and omit snapshots', async () => {
  const listing = await handleMessage(request(1, 'tools/list'), store(), 'owner')
  assert.deepEqual(listing.result.tools.map(tool => tool.name), ['moss_status', 'moss_experiment_status', 'moss_delegate', 'moss_task_status'])
  const result = await handleMessage(request(2, 'tools/call', { name: 'moss_experiment_status', arguments: { id: 'experiment-1' } }), store(), 'owner')
  assert.equal(payload(result).revision, 1)
  assert.deepEqual(payload(result).checks, [{ name: 'simulation', status: 'passed' }])
  assert.equal(JSON.stringify(result).includes('secret'), false)
  const unbound = await handleMessage(request(6, 'tools/call', { name: 'moss_experiment_status', arguments: { id: 'experiment-1' } }), store(), null)
  assert.equal(unbound.result.isError, true)
  const denied = await handleMessage(request(3, 'tools/call', { name: 'moss_experiment_status', arguments: { id: 'experiment-1' } }), {
    async getForSession() { throw new Error('denied') },
    async getChecksForSession() { throw new Error('denied') },
  }, 'other')
  assert.equal(denied.result.isError, true)
  assert.equal((await handleMessage(request(4, 'tools/call', { name: 'run_protocol', arguments: {} }), store(), 'owner')).error.code, -32602)
  assert.equal((await handleMessage(request(5, 'tools/call', { name: 'moss_experiment_status', arguments: { id: 'experiment-1', sessionId: 'owner' } }), store(), 'other')).error.code, -32602)
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, store(), 'owner'), null)
})

test('delegate accepts newTask and task status exposes the confirmation decision', async () => {
  const call = (id, name, args) => handleMessage(request(id, 'tools/call', { name, arguments: args }), store(), 'owner', delegation)
  const first = payload(await call(1, 'moss_delegate', { message: '设计实验' }))
  assert.equal(first.jobId, 'job-1')
  const newTask = payload(await call(2, 'moss_delegate', { message: '另一实验', newTask: true }))
  assert.equal(newTask.sessionId, 'session-2')
  assert.equal((await call(3, 'moss_delegate', { message: 'x', newTask: 'yes' })).error.code, -32602)
  assert.equal((await call(4, 'moss_delegate', { message: 'x', sessionId: 'other' })).error.code, -32602)
  const status = payload(await call(5, 'moss_task_status', { jobId: 'job-1' }))
  assert.equal(status.awaitingConfirmation, true)
  assert.equal(status.speech.speak, true)
  assert.equal(status.speech.text, '每孔体积？')
  assert.equal(payload(await call(6, 'moss_task_status', { jobId: 'job-1', userQuery: true })).jobId, 'job-1')
  assert.equal((await call(8, 'moss_task_status', { jobId: 'job-1', userQuery: 'yes' })).error.code, -32602)
  const seen = []
  const activeStore = {
    async getForSession(session, id) { seen.push(session); return { id, revision: 2, createdAt: 1 } },
    async getChecksForSession() { return [] },
  }
  const active = payload(await handleMessage(request(7, 'tools/call', { name: 'moss_experiment_status', arguments: { id: 'experiment-2' } }), activeStore, null, delegation))
  assert.equal(active.revision, 2)
  assert.deepEqual(seen, ['session-1'])
})

test('reads experiment status through the real session-scoped store when its SQLite backend is available', { skip: ExperimentStore === undefined ? 'node:sqlite backend requires Node 24.9+' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiaozhi-store-'))
  const store = new ExperimentStore({ path: join(dir, 'experiments.sqlite'), create: true })
  try {
    const { experiment } = store.createForSession('owner', { creationKey: 'one', snapshot: { protocol: 'secret protocol', privateNote: 'secret note' } })
    const task = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'simulation' })
    store.finishCheck({ ...task, status: 'passed', result: { private: 'secret result' } })
    const result = await handleMessage(request(1, 'tools/call', { name: 'moss_experiment_status', arguments: { id: experiment.id } }), store, 'owner')
    assert.equal(payload(result).revision, 1)
    assert.deepEqual(payload(result).checks, [{ name: 'simulation', status: 'passed' }])
    assert.equal(JSON.stringify(result).includes('secret'), false)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('outbound socket sends only replies and is closed on disposal', async () => {
  class FakeSocket extends EventTarget {
    static last
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeSocket.last = this }
    send(message) { this.sent.push(JSON.parse(message)) }
    close() { this.readyState = 3 }
    deliver(data) { this.dispatchEvent(new MessageEvent('message', { data })) }
  }
  const socketStore = { getForSession() {}, getChecksForSession() {} }
  const dispose = connectBridge({ url: 'wss://example.invalid/path?token=private', sessionId: 'owner', store: socketStore, WebSocketClass: FakeSocket })
  const socket = FakeSocket.last
  assert.equal(socket.sent.length, 0)
  socket.deliver(JSON.stringify(request(1, 'initialize', { protocolVersion: '2024-11-05' })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(socket.sent[0].result.protocolVersion, '2024-11-05')
  socket.deliver('{')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(socket.sent[1].error.code, -32700)
  dispose()
  socket.deliver(JSON.stringify(request(2, 'ping')))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(socket.readyState, 3)
  assert.equal(socket.sent.length, 2)
  assert.throws(() => connectBridge({ url: 'ws://example.invalid', sessionId: 'owner', store: socketStore, WebSocketClass: FakeSocket }), /secure WebSocket/)
})
