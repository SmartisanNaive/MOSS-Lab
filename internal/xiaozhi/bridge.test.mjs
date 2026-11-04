import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentStore } from '../experiment/index.mjs'
import { connectBridge, handleMessage } from './bridge.mjs'

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })
const payload = result => JSON.parse(result.result.content[0].text)

test('tool calls are restricted to an operator-selected session and omit snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiaozhi-test-'))
  const store = new ExperimentStore({ path: join(dir, 'experiments.sqlite'), create: true })
  try {
    const { experiment } = store.createForSession('owner', { creationKey: 'one', snapshot: { protocol: 'secret protocol', privateNote: 'secret note' } })
    const task = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'simulation' })
    store.finishCheck({ ...task, status: 'passed', result: { private: 'secret result' } })
    const listing = await handleMessage(request(1, 'tools/list'), store, 'owner')
    assert.deepEqual(listing.result.tools.map(tool => tool.name), ['moss_status', 'moss_experiment_status', 'moss_delegate', 'moss_task_status'])
    const result = await handleMessage(request(2, 'tools/call', { name: 'moss_experiment_status', arguments: { id: experiment.id } }), store, 'owner')
    assert.equal(payload(result).revision, 1)
    assert.deepEqual(payload(result).checks, [{ name: 'simulation', status: 'passed' }])
    assert.equal(JSON.stringify(result).includes('secret'), false)
    const unbound = await handleMessage(request(6, 'tools/call', { name: 'moss_experiment_status', arguments: { id: experiment.id } }), store, null)
    assert.equal(unbound.result.isError, true)
    const denied = await handleMessage(request(3, 'tools/call', { name: 'moss_experiment_status', arguments: { id: experiment.id } }), store, 'other')
    assert.equal(denied.result.isError, true)
    assert.equal((await handleMessage(request(4, 'tools/call', { name: 'run_protocol', arguments: {} }), store, 'owner')).error.code, -32602)
    assert.equal((await handleMessage(request(5, 'tools/call', { name: 'moss_experiment_status', arguments: { id: experiment.id, sessionId: 'owner' } }), store, 'other')).error.code, -32602)
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, store, 'owner'), null)
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
  const store = { getForSession() {}, getChecksForSession() {} }
  const dispose = connectBridge({ url: 'wss://example.invalid/path?token=private', sessionId: 'owner', store, WebSocketClass: FakeSocket })
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
  assert.throws(() => connectBridge({ url: 'ws://example.invalid', sessionId: 'owner', store, WebSocketClass: FakeSocket }), /secure WebSocket/)
})
