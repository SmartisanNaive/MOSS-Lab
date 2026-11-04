import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../vendor/cordis/src/index.ts'
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts'
import ToolsService from '../../../packages/core/tools/src/index.ts'
import * as plugin from '../agent-tools.mjs'

const parameters = { assumptions: 'sample setup' }
const protocol = 'def run(protocol):\n    pass\n'
const session = id => ({ agent: { session: { id } } })

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  ctx.tools.setExecutor({ describe: () => ({ schemas: [], knownNames: [] }), execute: async () => { throw new Error('unexpected execution') } })
  const calls = []
  ctx.provide('experimentWorkflow', Object.fromEntries(['create', 'get', 'update', 'analyze'].map(method => [method, input => {
    calls.push({ method, input })
    return { method, input }
  }])))
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const tools = Object.fromEntries(ctx.tools.definitions().map(tool => [tool.name, tool]))
  return { ctx, fiber, tools, calls }
}

test('registers scoped experiment tools and removes them on disposal', async () => {
  const { ctx, fiber, tools } = await setup()
  try {
    assert.deepEqual(Object.keys(tools).sort(), ['analyze_experiment', 'create_experiment', 'get_experiment', 'request_experiment_input', 'update_experiment'])
    assert.ok(ctx.tools.schemas().every(schema => !Object.hasOwn(schema.parameters.properties, 'sessionId')))
    assert.ok(Object.hasOwn(tools.update_experiment.parameters.properties, 'protocol'))
    const prompt = await ctx.systemPrompt.assemble()
    const guidance = prompt.sections.find(section => section.name === 'labscriptai:experiment-workflow')
    assert.match(guidance.text, /Use only the configured project uv virtual environment/)
    assert.match(guidance.text, /uv run --active --no-project/)
    assert.match(guidance.text, /Report only results supported by tool output/)
    assert.match(guidance.text, /simulation does not observe physical results/)
    assert.match(guidance.text, /relative delay does not schedule an absolute time/)
    assert.match(guidance.text, /only steps actually present in the protocol/)
    assert.match(guidance.text, /source volume must cover all transfers plus any applicable dead volume/)
    assert.match(guidance.text, /tip reuse policy and any cross-contamination risk/)
    await fiber.dispose()
    assert.deepEqual(ctx.tools.definitions(), [])
    assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'labscriptai:experiment-workflow'), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('forwards only supported arguments with the executing session identity', async () => {
  const { ctx, tools, calls } = await setup()
  try {
    const create = { creationKey: 'request', requirement: 'transfer', parameters, protocol, sessionId: 'forged' }
    assert.deepEqual(await tools.create_experiment.execute(create, session('owner')), {
      method: 'create', input: { sessionId: 'owner', creationKey: 'request', requirement: 'transfer', parameters, protocol },
    })
    await tools.get_experiment.execute({ id: 'exp', sessionId: 'forged' }, session('owner'))
    await tools.update_experiment.execute({ id: 'exp', expectedRevision: 1, requirement: 'transfer', parameters, protocol, sessionId: 'forged' }, session('owner'))
    await tools.analyze_experiment.execute({ id: 'exp', revision: 2, protocol: 'arbitrary code' }, session('other'))
    assert.deepEqual(calls, [
      { method: 'create', input: { sessionId: 'owner', creationKey: 'request', requirement: 'transfer', parameters, protocol } },
      { method: 'get', input: { sessionId: 'owner', id: 'exp' } },
      { method: 'update', input: { sessionId: 'owner', id: 'exp', expectedRevision: 1, requirement: 'transfer', parameters, protocol } },
      { method: 'analyze', input: { sessionId: 'other', id: 'exp', revision: 2 } },
    ])
    assert.deepEqual(tools.create_experiment.output.render({}, { id: 'exp', revision: 1 }), [{ type: 'text', text: '{"id":"exp","revision":1}' }])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rejects missing identity and invalid tool arguments before calling workflow', async () => {
  const { ctx, tools, calls } = await setup()
  try {
    const args = { creationKey: 'request', requirement: 'transfer', parameters, protocol }
    const attempts = [
      [tools.create_experiment, args],
      [tools.get_experiment, { id: 'exp' }],
      [tools.update_experiment, { id: 'exp', expectedRevision: 1, requirement: 'transfer', parameters, protocol }],
      [tools.analyze_experiment, { id: 'exp', revision: 1 }],
    ]
    for (const [tool, input] of attempts) {
      for (const exec of [undefined, {}, session(''), session('  ')]) {
        await assert.rejects(tool.execute(input, exec), /session identity/)
      }
    }
    await assert.rejects(tools.create_experiment.execute({ ...args, parameters: { extra: 'unexpected' } }, session('owner')))
    await assert.rejects(tools.create_experiment.execute({ ...args, protocol: 12 }, session('owner')))
    await assert.rejects(tools.update_experiment.execute({ id: 'exp', expectedRevision: 1, requirement: 'transfer' }, session('owner')))
    await assert.rejects(tools.analyze_experiment.execute({ id: 'exp', revision: '1' }, session('owner')))
    assert.deepEqual(calls, [])
  } finally {
    await ctx.fiber.dispose()
  }
})
