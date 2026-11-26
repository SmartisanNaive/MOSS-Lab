import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginClient } from '../plugin-client.mjs'
import { apply } from '../labscriptai-tools.mjs'

const schema = { type: 'object', properties: {} }
const target = { origin: 'http://127.0.0.1:31950' }
const row = { id: 'receipt', robot_run_id: 'physical', robot_serial: 'Flex-1', robot_type: 'Flex', experiment_id: 'experiment', revision: 1 }
const experiment = { id: row.experiment_id, revision: row.revision, snapshot: { protocol: 'owned protocol' } }

test('discovers tools, scopes calls, and reuses only the approved run for automatic recovery', async () => {
  const calls = []
  const tools = new Map()
  const sections = []
  const approvals = []
  let granted = false
  let cancelled = false
  const ctx = {
    get(key) { if (key === 'approval') return { async request(request, options) { approvals.push({ request, options }); return 'allowed-once' } } },
    effect(fn) { fn() },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    systemPrompt: { suppressRuntimeContext() {}, section(section) { sections.push(section) } },
    experimentStore: { latestForSession: () => experiment, getForSession: () => experiment },
    labscriptaiRuntime: {
      catalog: async () => ['robot_status', 'run_protocol', 'runtime_watch', 'runtime_recovery_monitor', 'capture_image', 'deck_vision_check', 'new_operation'].map(name => ({ name, inputSchema: schema })),
      workflow: async () => 'upstream workflow',
      recoveryGranted: async id => granted && id === row.id,
      experiment(robot, name, args, options) {
        options.beforeDispatch?.()
        calls.push({ robot, name, args, options })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
    robotControl: {
      target: () => target, allowLive: true,
      status: async () => ({ serial: row.robot_serial, robotType: row.robot_type }),
      watchRun: (_sessionId, _runId, signal, watch) => watch(signal),
      activeRunForMcp(sessionId, runId) {
        assert.equal(sessionId, 'owner')
        assert.equal(runId, row.robot_run_id)
        return { ...row, cancel_requested: cancelled }
      },
      verifyStart: async () => ({ robot: { serial: 'Flex-1', robotType: 'Flex' }, analysis: { taskId: 'analysis' } }),
      startRun: async input => {
        assert.equal(input.sessionId, 'owner')
        assert.equal(input.approved.automaticRecovery, true)
        granted = true
        return { runId: row.robot_run_id, status: 'start_acknowledged' }
      },
    },
  }
  await apply(ctx, { prefix: 'host' })
  assert.equal(sections[0].text, 'host\n\nupstream workflow')
  const exec = { agent: { session: { id: 'owner' } }, name: 'tool', signal: new AbortController().signal }
  const call = (name, args, invocation = exec) => tools.get(`mcp__labscriptai__${name}`).execute(args, { ...invocation })
  await assert.rejects(call('robot_status', { robot_ip: 'https://other.invalid' }), { code: 'ROBOT_TARGET_CHANGED' })
  await call('robot_status', { session_id: 'other', include_modules: true })
  assert.deepEqual(calls[0].args, { robot_ip: target.origin, session_id: 'owner', include_modules: true })
  await call('capture_image', { mode: 'preview' })
  await call('deck_vision_check', { mode: 'local' })
  assert.equal(calls[1].robot, target)
  assert.equal(calls[2].robot, null)
  assert.equal(approvals.length, 0)
  await assert.rejects(call('new_operation', {}), { code: 'PLUGIN_OPERATION_UNCONFIGURED' })
  const watch = { mode: 'poll', run_id: row.robot_run_id, protocol_source: 'untrusted' }
  await assert.rejects(call('runtime_watch', watch), { code: 'ROBOT_RECOVERY_NOT_APPROVED' })
  await call('runtime_recovery_monitor', { run_id: row.robot_run_id, operator_opt_in: true, self_fix_mode: 'l0', allow_l4_execution: true })
  assert.equal(calls.at(-1).args.operator_opt_in, false)
  assert.equal(calls.at(-1).args.self_fix_mode, 'observe')
  const result = await call('run_protocol', { file_path: 'current_protocol.py' })
  assert.equal(JSON.parse(result.content[0].text).run_id, row.robot_run_id)
  assert.equal(approvals[0].options.policy, 'ask')
  assert.match(approvals[0].request.reason, /automatic recovery/)
  await call('runtime_watch', watch)
  assert.equal(calls.at(-1).args.protocol_source, 'owned protocol')
  assert.equal(calls.at(-1).args.operator_opt_in, true)
  await assert.rejects(call('runtime_watch', { ...watch, run_id: 'other' }))
  await assert.rejects(call('runtime_watch', watch, { ...exec, agent: { session: { id: 'other' } } }))
  cancelled = true
  await assert.rejects(call('runtime_watch', watch), { code: 'ROBOT_RUN_INACTIVE' })
})

test('discovers the stdio catalog and preserves plugin photos only within the owning session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-mcp-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = join(root, 'servers', 'opentrons-mcp')
  await mkdir(server, { recursive: true })
  await writeFile(join(server, 'index.js'), `
const { createInterface } = require('node:readline')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const tool = name => ({ name, inputSchema: { type: 'object' } })
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-labscriptai', version: '0.1.5' } }
  if (request.method === 'tools/list') result = request.params?.cursor ? { tools: [tool('deck_vision_check')] } : { tools: [tool('capture_image')], nextCursor: 'next' }
  if (request.method === 'tools/call') {
    const input = request.params.arguments
    let data
    if (request.params.name === 'deck_vision_check') {
      data = { image_path: input.image_path, python: process.env.OPENTRONS_PYTHON }
    } else {
      const saved_to = input.output_path ?? join(process.env.PLUGIN_DATA, 'photo.jpg')
      writeFileSync(saved_to, Buffer.from([255, 216, 255, 1]))
      data = { saved_to }
    }
    result = { content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
`)
  const runtime = createPluginClient({ root, data: root, state: join(root, 'state'), dependencyHome: root, version: '0.1.5', timeoutMs: 150000, visionPython: process.execPath,
    sandbox: { async confine(argv) { return { argv } } } })
  assert.deepEqual((await runtime.catalog()).map(tool => tool.name), ['capture_image', 'deck_vision_check'])
  const first = await runtime.experiment(target, 'capture_image', { mode: 'preview' }, { sessionId: 'first' })
  assert.deepEqual(first.content[1], { type: 'image', mimeType: 'image/jpeg', data: '/9j/AQ==' })
  const { saved_to } = JSON.parse(first.content[0].text).data
  await assert.rejects(runtime.experiment(target, 'capture_image', { output_path: saved_to }, { sessionId: 'second' }), { code: 'PLUGIN_ARGUMENT_FORBIDDEN' })
  const reused = await runtime.experiment(null, 'deck_vision_check', { mode: 'local', image_path: saved_to }, { sessionId: 'first' })
  assert.equal(JSON.parse(reused.content[0].text).data.python, process.execPath)
  assert.equal(reused.content[1].type, 'image')
  assert.equal(await runtime.recoveryGranted('receipt'), false)
  await runtime.grantRecovery('receipt')
  assert.equal(await runtime.recoveryGranted('receipt'), true)
  assert.equal(await runtime.recoveryGranted('other-receipt'), false)
})
