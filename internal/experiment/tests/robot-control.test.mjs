import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentStore } from '../index.mjs'
import * as robotControl from '../robot-control-plugin.mjs'
import * as robotTools from '../robot-tools.mjs'

function setup(t, model, allowLive = true) {
  const directory = mkdtempSync(join(tmpdir(), 'moss-run-'))
  const db = join(directory, 'experiments.sqlite')
  let store = new ExperimentStore({ path: db, create: true })
  t.after(() => { store.close(); rmSync(directory, { force: true, recursive: true }) })
  const sessionId = 'owner'
  const protocol = 'def run(protocol): pass'
  const { experiment } = store.createForSession(sessionId, { creationKey: 'original', snapshot: { protocol } })
  const analysis = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
  store.finishCheck({ ...analysis, status: 'passed', result: { robotType: model } })
  const input = { experimentId: experiment.id, revision: 1, sessionId }
  const calls = []
  const tools = {}
  const state = { approval: 'allowed-once', model, serial: 'robot-1', run: 'idle', dropPlay: false, onPrepare: () => {}, beforePlay: () => {}, preparationLost: false }
  let control
  let intent = 0
  function mount(enabled = allowLive) {
    const ctx = {
      experimentStore: store, effect(fn) { fn() }, provide(_, service) { control = service },
      get(name) {
        if (name === 'approval') return { async request(request, options) { state.request = request; state.approvalPolicy = options?.policy; return typeof state.approval === 'function' ? state.approval() : state.approval } }
        if (name === 'mossVoiceIntent') return { captureIntent() {
          const captured = intent
          return { assertCurrent() { if (intent !== captured) throw new Error('superseded') } }
        } }
      },
      tools: { register(tool) { tools[tool.name] = tool } },
      labscriptaiRuntime: { async grantRecovery(id) { state.recoveryApproved = id }, async robot(target, name, args, source, beforeDispatch) {
        assert.equal(target.origin, 'http://127.0.0.1:31950')
        assert.equal(args.robot_ip, target.origin)
        if (name === 'control_run' && args.action === 'play') state.beforePlay()
        beforeDispatch?.()
        calls.push({ name, args, source })
        if (name === 'robot_status') return { authoring_context: { robot_type: state.model }, health_summary: { robot_serial: state.serial } }
        if (name === 'get_protocols') return { protocols: { data: state.preparationLost ? [{ id: 'protocol-1', key: state.key }] : [] } }
        if (name === 'run_protocol') {
          assert.equal(source, protocol)
          assert.equal(args.auto_play, false)
          assert.equal(args.expected_robot_type, model)
          state.key = args.key
          state.onPrepare()
          if (state.preparationLost) throw new Error('lost preparation acknowledgement')
          return { created_run: { data: { id: 'actual-run' } }, preflight_gate: { allowed_to_play: true } }
        }
        if (name === 'query_history') return args.scope === 'robot_runs'
          ? { runs: { data: [{ id: 'actual-run', protocolId: 'protocol-1' }] } }
          : { status: state.run }
        assert.equal(name, 'control_run')
        if (args.expected_run_status) assert.ok(args.expected_run_status.includes(state.run))
        state.run = { play: 'running', pause: 'paused', stop: 'stopped' }[args.action]
        if (state.dropPlay && args.action === 'play') throw new Error('lost acknowledgement')
        return {}
      } },
    }
    robotControl.apply(ctx, { url: 'http://127.0.0.1:31950', allowLive: enabled })
    robotTools.apply({ ...ctx, robotControl: control })
  }
  mount()
  const exec = { agent: { session: { id: sessionId } }, name: 'start_robot_run', callId: 'call', signal: new AbortController().signal }
  return { input, state, calls, exec, tools, get control() { return control },
    supersede() { intent++ },
    restart(enabled) { store.close(); store = new ExperimentStore({ path: db, create: false }); mount(enabled) },
  }
}

for (const model of ['Flex', 'OT-2']) {
  test(`${model} approval, start, pause, resume and stop use the owned physical run`, async t => {
    const f = setup(t, model)
    f.state.approval = 'rejected'
    await assert.rejects(f.tools.start_robot_run.execute(f.input, f.exec), /did not approve/)
    assert.ok(f.calls.every(call => call.name === 'robot_status'))
    assert.equal(f.state.recoveryApproved, undefined)
    assert.equal(f.state.approvalPolicy, 'ask')
    f.state.approval = 'allowed-once'
    const run = await f.tools.start_robot_run.execute(f.input, f.exec)
    assert.match(f.state.request.displayReason.en, new RegExp(model))
    assert.match(f.state.request.displayReason.en, /revision 1.*robot-1/)
    assert.equal(run.status, 'start_acknowledged')
    assert.equal((await f.tools.get_robot_run.execute({}, f.exec)).status, 'running')
    await assert.rejects(f.tools.start_robot_run.execute(f.input, f.exec), { code: 'ROBOT_RUN_ACTIVE' })
    const change = action => f.tools.control_robot_run.execute({ id: run.id, action }, f.exec)
    assert.equal((await change('pause')).status, 'action_acknowledged')
    assert.equal((await change('resume')).status, 'action_acknowledged')
    await assert.rejects(f.control.controlRun({ sessionId: 'another', id: run.id, action: 'stop' }), { code: 'ROBOT_RUN_NOT_FOUND' })
    f.restart(false)
    f.state.approval = 'rejected'
    assert.equal((await change('stop')).status, 'action_acknowledged')
    assert.equal((await f.tools.get_robot_run.execute({}, f.exec)).status, 'stopped')
    assert.equal(f.control.activeRun('owner'), null)
  })
}

test('stopping the run cancels its automatic recovery watcher', async t => {
  const f = setup(t, 'Flex')
  const result = await f.tools.start_robot_run.execute(f.input, f.exec)
  const started = Promise.withResolvers()
  const watcher = f.control.watchRun(f.input.sessionId, result.runId, f.exec.signal, signal => {
    started.resolve()
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(signal.aborted), { once: true }))
  })
  await started.promise
  await assert.rejects(f.control.watchRun(f.input.sessionId, result.runId, f.exec.signal, () => {}), { code: 'ROBOT_WATCH_UNAVAILABLE' })
  assert.equal((await f.control.controlRun({ sessionId: f.input.sessionId, id: result.id, action: 'stop' })).status, 'action_acknowledged')
  assert.equal(await watcher, true)
})

test('mismatched devices and superseded intents do not play a protocol', async t => {
  const f = setup(t, 'Flex')
  f.state.model = 'OT-2'
  await assert.rejects(f.tools.start_robot_run.execute(f.input, f.exec), { code: 'ROBOT_NOT_READY' })
  f.state.model = 'Flex'
  f.state.onPrepare = () => f.supersede()
  const result = await f.tools.start_robot_run.execute(f.input, f.exec)
  assert.equal(result.status, 'prepared_not_started')
  assert.ok(f.calls.every(call => call.name !== 'control_run'))
})

test('lost play acknowledgement retains the receipt across restart and prevents duplicate starts', async t => {
  const f = setup(t, 'OT-2')
  f.state.dropPlay = true
  const result = await f.tools.start_robot_run.execute(f.input, f.exec)
  assert.equal(result.status, 'start_unconfirmed')
  f.restart(true)
  assert.equal((await f.tools.get_robot_run.execute({}, f.exec)).status, 'running')
  await assert.rejects(f.tools.start_robot_run.execute(f.input, f.exec), { code: 'ROBOT_RUN_ACTIVE' })
  assert.equal(f.calls.filter(call => call.name === 'run_protocol').length, 1)
})

test('a voice amendment while approval is open invalidates that approval', async t => {
  const f = setup(t, 'Flex')
  f.state.approval = () => {
    f.supersede()
    return 'allowed-once'
  }
  await assert.rejects(f.tools.start_robot_run.execute(f.input, f.exec), /superseded/)
  assert.ok(f.calls.every(call => call.name === 'robot_status'))
})

test('stop during preparation preserves ownership and stops the returned physical run', async t => {
  const f = setup(t, 'Flex')
  let cancellation
  f.state.onPrepare = () => {
    const id = f.control.activeRun('owner')
    cancellation = f.control.controlRun({ sessionId: 'owner', id, action: 'stop' })
  }
  const run = await f.tools.start_robot_run.execute(f.input, f.exec)
  assert.ok(['cancellation_requested', 'action_acknowledged'].includes((await cancellation).status))
  assert.equal(run.status, 'stop_acknowledged')
  assert.equal(f.calls.filter(call => call.name === 'control_run')[0].args.action, 'stop')
  assert.equal((await f.control.getRun('owner', run.id)).status, 'stopped')
})

test('stop after the physical ID is saved invalidates a pending play dispatch', async t => {
  const f = setup(t, 'OT-2')
  let stopped
  f.state.beforePlay = () => {
    const id = f.control.activeRun('owner')
    stopped = f.control.controlRun({ sessionId: 'owner', id, action: 'stop' })
  }
  const result = await f.tools.start_robot_run.execute(f.input, f.exec)
  assert.equal((await stopped).status, 'action_acknowledged')
  assert.notEqual(result.status, 'start_acknowledged')
  assert.deepEqual(f.calls.filter(call => call.name === 'control_run').map(call => call.args.action), ['stop'])
})

test('recovers the exact prepared run from its unique upload key after a lost preparation reply', async t => {
  const f = setup(t, 'Flex')
  f.state.preparationLost = true
  const initial = await f.tools.start_robot_run.execute(f.input, f.exec)
  assert.equal(initial.status, 'preparation_unconfirmed')
  f.restart(true)
  const recovered = await f.tools.get_robot_run.execute({}, f.exec)
  assert.equal(recovered.runId, 'actual-run')
  assert.equal(recovered.status, 'idle')
  assert.equal((await f.tools.control_robot_run.execute({ id: initial.id, action: 'stop' }, f.exec)).status, 'action_acknowledged')
  assert.equal((await f.tools.get_robot_run.execute({}, f.exec)).status, 'stopped')
  assert.equal(f.control.activeRun('owner'), null)
})
