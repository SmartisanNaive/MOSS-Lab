import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../robot-control-plugin.mjs'
import { healthyRobot, startFakeRobot } from './fake-robot.mjs'

const protocol = 'metadata = {}\n\ndef run(protocol):\n    pass\n'
const passedCheck = { name: 'protocol-analysis', status: 'passed', protocolHash: 'hash-2' }

function fakeStore({ revision = 2, protocolHash = 'hash-2', checks = [passedCheck] } = {}) {
  const calls = []
  return {
    calls,
    getForSession: () => ({ id: 'exp-1', revision, snapshot: { protocol }, protocolHash }),
    getChecksForSession: () => checks,
    startCheck: input => { calls.push({ method: 'startCheck', input }); return { ...input, taskId: 'task-1' } },
    finishCheck: input => { calls.push({ method: 'finishCheck', input }); return input },
  }
}

async function setup({ store = fakeStore(), url, allowLive = true } = {}) {
  const ctx = new Context()
  ctx.provide('experimentStore', store)
  const fiber = ctx.plugin(plugin, { url, allowLive, timeoutMs: 2000, maxBytes: 65536, maxProtocolBytes: 65536 })
  await fiber.await()
  return { ctx, fiber, store, service: ctx.robotControl }
}

function robotRoutes(extra = {}) {
  const base = healthyRobot()
  return request => {
    if (request.method === 'POST' && request.path === '/protocols') return { status: 201, body: { data: { id: 'protocol-1' } } }
    if (request.method === 'POST' && request.path === '/runs') return { status: 201, body: { data: { id: 'run-1' } } }
    if (request.method === 'POST' && request.path === '/runs/run-1/actions') return { status: 201, body: { data: { actionType: 'play' } } }
    if (request.method === 'GET' && request.path === '/runs/run-1') return { body: { data: { id: 'run-1', status: 'running', current: true } } }
    if (request.method === 'GET' && request.path === '/runs/run-1/commands') return { body: { data: [{ id: 'c1', commandType: 'home', status: 'succeeded' }] } }
    return { ...base(request), ...(extra[request.path] ?? {}) }
  }
}

test('starts a gated run and records the accepted run as a passed check', async () => {
  const robot = await startFakeRobot(robotRoutes())
  const { ctx, fiber, store, service } = await setup({ url: robot.url })
  try {
    const result = await service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 })
    assert.equal(result.runId, 'run-1')
    assert.equal(result.protocolId, 'protocol-1')
    assert.equal(result.status, 'started')
    assert.deepEqual(store.calls.map(call => call.method), ['startCheck', 'finishCheck'])
    assert.deepEqual(store.calls[0].input.name, 'robot-run')
    assert.equal(store.calls[1].input.status, 'passed')
    assert.equal(store.calls[1].input.result.runId, 'run-1')
    assert.ok(robot.requests.some(request => request.method === 'POST' && request.path === '/protocols'))
    assert.ok(robot.requests.some(request => request.method === 'POST' && request.path === '/runs/run-1/actions'))
  } finally { await robot.close(); await ctx.fiber.dispose() }
})

test('refuses motion without a passing analysis for the exact revision', async () => {
  const robot = await startFakeRobot(robotRoutes())
  try {
    for (const checks of [[], [{ ...passedCheck, status: 'failed' }], [{ ...passedCheck, protocolHash: 'old-hash' }]]) {
      const { ctx, service } = await setup({ store: fakeStore({ checks }), url: robot.url })
      try {
        await assert.rejects(service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 }), error => error.code === 'SIMULATION_REQUIRED')
      } finally { await ctx.fiber.dispose() }
    }
    assert.equal(robot.requests.filter(request => request.method === 'POST').length, 0)
  } finally { await robot.close() }
})

test('rejects a stale revision and a disabled live switch before contacting the robot', async () => {
  const robot = await startFakeRobot(robotRoutes())
  try {
    const stale = await setup({ url: robot.url })
    await assert.rejects(stale.service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 1 }), error => error.code === 'REVISION_CONFLICT')
    await stale.ctx.fiber.dispose()
    const disabled = await setup({ url: robot.url, allowLive: false })
    await assert.rejects(disabled.service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 }), error => error.code === 'ROBOT_CONTROL_DISABLED')
    await disabled.ctx.fiber.dispose()
    assert.equal(robot.requests.length, 0)
  } finally { await robot.close() }
})

test('blocks motion when the door is open, and reports an unconfigured robot', async () => {
  const openDoor = await startFakeRobot(robotRoutes({ '/robot/door/status': { body: { data: { status: 'open' } } } }))
  try {
    const { ctx, service } = await setup({ url: openDoor.url })
    await assert.rejects(service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 }), error => error.code === 'ROBOT_NOT_READY')
    await ctx.fiber.dispose()
  } finally { await openDoor.close() }
  const unconfigured = await setup({ url: '' })
  assert.equal((await unconfigured.service.status()).status, 'not_configured')
  await assert.rejects(unconfigured.service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 }), error => error.code === 'ROBOT_NOT_CONFIGURED')
  await unconfigured.ctx.fiber.dispose()
})

test('records a failed check when the robot rejects the upload, and allows stop without live control', async () => {
  const robot = await startFakeRobot(request => request.path === '/protocols' ? { status: 500, body: { error: 'upload failed' } } : robotRoutes()(request))
  try {
    const { ctx, store, service } = await setup({ url: robot.url })
    await assert.rejects(service.startRun({ sessionId: 'session-1', experimentId: 'exp-1', revision: 2 }), error => error.code === 'ROBOT_HTTP_ERROR')
    assert.equal(store.calls.at(-1).input.status, 'error')
    await ctx.fiber.dispose()
    const disabled = await setup({ url: robot.url, allowLive: false })
    try {
      await disabled.service.controlRun({ runId: 'run-1', action: 'stop' })
      assert.equal((await disabled.service.getRun('run-1')).status, 'running')
      await assert.rejects(disabled.service.controlRun({ runId: 'run-1', action: 'pause' }), error => error.code === 'ROBOT_CONTROL_DISABLED')
    } finally { await disabled.ctx.fiber.dispose() }
  } finally { await robot.close() }
})

test('reads run status and recent commands', async () => {
  const robot = await startFakeRobot(robotRoutes())
  try {
    const { ctx, service } = await setup({ url: robot.url })
    assert.equal((await service.getRun('run-1')).status, 'running')
    assert.deepEqual(await service.getCommands('run-1'), [{ id: 'c1', commandType: 'home', status: 'succeeded', error: null }])
    await ctx.fiber.dispose()
  } finally { await robot.close() }
})
