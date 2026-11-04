import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { connectBridge } from './bridge.mjs'

const store = { getForSession() {}, getChecksForSession() {} }
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })

test('a real transport reconnects and re-registers without replaying an accepted delegation', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const local = 'ws://127.0.0.1:' + server.address().port
  class LocalSocket extends WebSocket { constructor(_url, options) { super(local, options) } }
  let calls = 0, peer, connections = 0
  const replies = new Map()
  const waiting = new Map()
  const nextReply = id => {
    if (replies.has(id)) return Promise.resolve(replies.get(id))
    return new Promise(resolve => waiting.set(id, resolve))
  }
  server.on('connection', socket => {
    peer = socket; connections++
    socket.on('message', bytes => { const reply = JSON.parse(bytes); replies.set(reply.id, reply); waiting.get(reply.id)?.(reply) })
    socket.send(JSON.stringify(rpc(connections * 10, 'initialize', { protocolVersion: '2025-03-26' })))
    socket.send(JSON.stringify(rpc(connections * 10 + 1, 'tools/list')))
  })
  const stop = connectBridge({ url: 'wss://example.invalid/?token=must-not-leak', sessionId: 's', store, WebSocketClass: LocalSocket,
    reconnectMinMs: 5, reconnectMaxMs: 10, heartbeatMs: 20, connectTimeoutMs: 1000,
    delegation: { submit: async () => { calls++; return { jobId: 'j', sessionId: 's', status: 'running' } }, get: () => ({ jobId: 'j', status: 'completed', result: 'done' }) } })
  try {
    await nextReply(11)
    peer.send(JSON.stringify(rpc(12, 'tools/call', { name: 'moss_delegate', arguments: { message: 'private user message' } })))
    assert.equal(JSON.parse((await nextReply(12)).result.content[0].text).jobId, 'j')
    peer.close()
    await nextReply(21)
    assert.equal(calls, 1)
    assert.equal(stop.snapshot().registered, true)
    assert.equal(stop.snapshot().reconnects, 1)
    peer.send(JSON.stringify(rpc(22, 'tools/call', { name: 'moss_task_status', arguments: { jobId: 'j' } })))
    assert.equal(JSON.parse((await nextReply(22)).result.content[0].text).result, 'done')
    assert.equal(stop.snapshot().lastCall.source, 'xiaozhi-mcp')
    assert.equal(JSON.stringify(stop.snapshot()).includes('must-not-leak'), false)
    assert.equal(JSON.stringify(stop.snapshot()).includes('private user message'), false)
  } finally { await stop(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)) }
  assert.equal(stop.snapshot().status, 'stopped')
})

test('disposal cancels a scheduled reconnect even when construction failed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  class Unavailable { constructor() { calls++; throw new Error('sensitive endpoint') } }
  const stop = connectBridge({ url: 'wss://example.invalid/?token=private', sessionId: null, store, WebSocketClass: Unavailable })
  assert.equal(stop.snapshot().status, 'retrying')
  await stop()
  t.mock.timers.tick(60000)
  assert.equal(calls, 1)
  assert.equal(stop.snapshot().status, 'stopped')
})

test('late replies cannot be sent to a replacement socket or overwrite its call status', async () => {
  class Socket extends EventTarget {
    static sockets = []
    constructor() { super(); this.readyState = 1; this.sent = []; Socket.sockets.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
    deliver(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  }
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const stop = connectBridge({ url: 'wss://example.invalid/', sessionId: 's', store, WebSocketClass: Socket, reconnectMinMs: 1, reconnectMaxMs: 1,
    delegation: { submit: () => pending } })
  try {
    Socket.sockets[0].deliver(rpc(1, 'tools/call', { name: 'moss_delegate', arguments: { message: 'first' } }))
    Socket.sockets[0].close()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(Socket.sockets.length, 2)
    Socket.sockets[1].deliver(rpc(2, 'tools/list'))
    Socket.sockets[1].deliver(rpc(3, 'tools/call', { name: 'moss_status', arguments: {} }))
    await new Promise(resolve => setImmediate(resolve))
    const currentCall = stop.snapshot().lastCall
    assert.equal(currentCall.name, 'moss_status')
    const sent = Socket.sockets[1].sent.length
    complete({ jobId: 'j', status: 'running' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(Socket.sockets[1].sent.length, sent)
    assert.equal(stop.snapshot().status, 'ready')
    assert.deepEqual(stop.snapshot().lastCall, currentCall)
  } finally { complete({ jobId: 'j' }); await stop() }
})
