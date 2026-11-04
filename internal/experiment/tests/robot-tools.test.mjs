import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../vendor/cordis/src/index.ts'
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts'
import ToolsService from '../../../packages/core/tools/src/index.ts'
import * as plugin from '../robot-tools.mjs'

const session = id => ({ agent: { session: { id } } })

async function setup({ allowLive = true, checkRunnable = () => {} } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  const calls = []
  ctx.provide('robotControl', {
    allowLive,
    checkRunnable,
    status: async () => ({ status: 'ready', health: { available: true } }),
    startRun: async input => { calls.push({ method: 'startRun', input }); return { runId: 'run-1', status: 'started' } },
    getRun: async runId => ({ runId, status: 'running' }),
    getCommands: async () => [{ id: 'c1', commandType: 'home', status: 'succeeded' }],
    controlRun: async input => { calls.push({ method: 'controlRun', input }); return { accepted: true } },
  })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const tools = Object.fromEntries(ctx.tools.definitions().map(tool => [tool.name, tool]))
  return { ctx, fiber, tools, calls }
}

test('registers the robot tools inside the preset and removes them on disposal', async () => {
  const { ctx, fiber, tools } = await setup()
  try {
    assert.deepEqual(Object.keys(tools).sort(), ['control_robot_run', 'get_robot_run', 'get_robot_status', 'start_robot_run'])
    assert.ok(ctx.tools.schemas().every(schema => !Object.hasOwn(schema.parameters.properties, 'sessionId')))
    await fiber.dispose()
    assert.deepEqual(ctx.tools.definitions(), [])
  } finally { await ctx.fiber.dispose() }
})

test('forwards the executing session and maps operator actions to robot actions', async () => {
  const { ctx, tools, calls } = await setup()
  try {
    assert.deepEqual(await tools.get_robot_status.execute({}, session('owner')), { status: 'ready', health: { available: true } })
    assert.deepEqual(await tools.start_robot_run.execute({ experimentId: 'exp-1', revision: 2 }, session('owner')), { runId: 'run-1', status: 'started' })
    assert.deepEqual(calls[0], { method: 'startRun', input: { sessionId: 'owner', experimentId: 'exp-1', revision: 2 } })
    await tools.control_robot_run.execute({ runId: 'run-1', action: 'resume' }, session('owner'))
    assert.deepEqual(calls[1], { method: 'controlRun', input: { runId: 'run-1', action: 'resume-from-recovery' } })
    assert.deepEqual(await tools.control_robot_run.execute({ runId: 'run-1', action: 'stop' }, session('owner')), { runId: 'run-1', action: 'stop', accepted: true })
    const read = await tools.get_robot_run.execute({ runId: 'run-1' }, session('owner'))
    assert.equal(read.run.status, 'running')
    assert.equal(read.commands.length, 1)
  } finally { await ctx.fiber.dispose() }
})

test('rejects motion without a session identity', async () => {
  const { ctx, tools } = await setup()
  try {
    for (const exec of [undefined, {}, session('')]) {
      await assert.rejects(tools.start_robot_run.execute({ experimentId: 'exp-1', revision: 2 }, exec), /session identity/)
    }
  } finally { await ctx.fiber.dispose() }
})

test('asks for approval before motion and lets stop through', async () => {
  const { ctx } = await setup()
  try {
    const next = () => Promise.resolve({ kind: 'allow' })
    assert.equal((await ctx.waterfall('tools/pre-execute', { name: 'start_robot_run', arguments: { experimentId: 'exp-1', revision: 2 }, ...session('owner') }, next)).kind, 'ask')
    assert.equal((await ctx.waterfall('tools/pre-execute', { name: 'control_robot_run', arguments: { action: 'pause' } }, next)).kind, 'ask')
    assert.equal((await ctx.waterfall('tools/pre-execute', { name: 'control_robot_run', arguments: { action: 'stop' } }, next)).kind, 'allow')
    assert.equal((await ctx.waterfall('tools/pre-execute', { name: 'get_robot_status', arguments: {} }, next)).kind, 'allow')
  } finally { await ctx.fiber.dispose() }
})

test('denies before approval when the run prerequisites are not met', async () => {
  const { ctx } = await setup({ checkRunnable: () => { throw new Error('the current experiment revision has no passing protocol analysis') } })
  try {
    const next = () => Promise.resolve({ kind: 'allow' })
    const decision = await ctx.waterfall('tools/pre-execute', { name: 'start_robot_run', arguments: { experimentId: 'exp-1', revision: 1 }, ...session('owner') }, next)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /no passing protocol analysis/)
  } finally { await ctx.fiber.dispose() }
})
