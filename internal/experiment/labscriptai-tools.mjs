/** Discover the pinned MCP tools in the experiment assistant's registration scope. */
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ExperimentError } from './index.mjs'
import { approveRobotAction, startOwnedRobotRun } from './robot-tools.mjs'

export const name = 'labscriptai-tools'
export const inject = ['tools', 'systemPrompt', 'experimentStore', 'labscriptaiRuntime', 'robotControl']

const localTools = new Set([
  'labware_lookup', 'estimate_tip_budget', 'record_liquid_source_map', 'apply_liquid_probe_results', 'liquid_source_map',
  'validate_virtual_lab_state_steps', 'list_recovery_playbooks', 'runtime_alerts', 'runtime_recovery_self_test',
  'liquid_source_substitution',
  'simulate_protocol', 'protocol_artifacts', 'logicpass_check', 'flex3d_preflight_check', 'flex3d_open_viewer',
])
const robotQueryTools = new Set([
  'robot_status', 'get_protocols', 'deck_slots', 'tip_wells', 'is_home_safe', 'reconcile_state', 'suggest_recovery_action',
  'data_files', 'live_readiness_check', 'preflight_run_setup', 'parse_error',
  'live_liquid_recovery_gate', 'generate_continuation_protocol',
])
const deviceActionTools = new Set([
  'load_pipette', 'load_labware', 'load_module', 'control_module', 'move_labware', 'cleanup_motion', 'drop_attached_tip',
  'execute_protocol_recovery', 'recover_tip_pickup',
])
const guidanceTopics = ['workflows', 'error-response', 'safety-policy']

function operation(name, args) {
  switch (name) {
    case 'runtime_outbox': return args.action === 'deliver' ? 'unconfigured' : 'local'
    case 'camera_settings': return args.action === 'status' ? 'robot' : 'approve'
    case 'capture_image': return args.mode === 'preview' ? 'robot' : 'approve'
    case 'deck_vision_check': return args.mode === 'local' ? 'local' : 'robot'
    case 'robot_authoring_context': return args.refresh === true ? 'robot' : 'optional_robot'
    case 'safe_next_action': return 'optional_robot'
    case 'health_check': return args.scope === 'robot' ? 'robot' : 'optional_robot'
    case 'probe_wells': return args.execute_on_robot === true ? 'approve' : 'optional_robot'
    case 'query_history': return args.scope === 'experiment_logs' ? 'local' : 'robot'
    case 'runtime_watch': return 'watch'
    case 'runtime_recovery_monitor': return 'monitor'
    case 'run_protocol': return 'start'
    case 'control_run': return 'control'
    default:
      if (localTools.has(name)) return 'local'
      if (robotQueryTools.has(name)) return 'robot'
      if (deviceActionTools.has(name)) return 'approve'
      return 'unconfigured'
  }
}

function response(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function requireActiveRun(control, sessionId, runId) {
  const row = control.activeRunForMcp(sessionId, runId)
  if (row.cancel_requested) throw new ExperimentError('ROBOT_RUN_INACTIVE', 'This run has a pending stop request.')
  return row
}

function sameProtocol(store, sessionId, row) {
  return store.getForSession(sessionId, row.experiment_id, row.revision).snapshot.protocol
}

function checkRequestedRobot(address, target) {
  if (address === undefined || address === target?.origin) return
  throw new ExperimentError('ROBOT_TARGET_CHANGED', 'Use the configured robot address or omit robot_ip.')
}

async function invoke(ctx, tool, args, exec) {
  const sessionId = exec.agent.session.id
  const runtime = ctx.labscriptaiRuntime
  const control = ctx.robotControl
  const store = ctx.experimentStore
  const kind = operation(tool, args)
  if (kind === 'unconfigured') throw new ExperimentError('PLUGIN_OPERATION_UNCONFIGURED', 'This LabscriptAI operation has no workbench policy.')
  const target = kind === 'local' ? null : control.target()
  checkRequestedRobot(args.robot_ip, target)
  if (kind === 'start') {
    const experiment = store.latestForSession(sessionId)
    if (!experiment || args.file_path !== 'current_protocol.py' || args.auto_play === false || args.skip_logicpass_gate || args.skip_preflight || args.skip_preflight_deck_diff) {
      throw new ExperimentError('PLUGIN_ARGUMENT_INVALID', 'Use current_protocol.py for the saved, analyzed experiment and request a normal run.')
    }
    const result = await startOwnedRobotRun(ctx, { experimentId: experiment.id, revision: experiment.revision }, exec)
    return response({ ...result, run_id: result.runId ?? null })
  }
  if (kind === 'control') {
    const row = control.activeRunForMcp(sessionId, args.run_id)
    const action = args.action === 'play' ? 'resume' : args.action
    if (!['pause', 'resume', 'stop'].includes(action)) throw new ExperimentError('PLUGIN_ARGUMENT_INVALID', 'Use pause, play, or stop for this run.')
    const intent = action === 'stop' ? null : ctx.get('mossVoiceIntent')?.captureIntent(sessionId)
    if (action !== 'stop') await approveRobotAction(ctx, exec, `Confirm ${action} for robot run ${args.run_id}.`, `确认在机器人上${action === 'pause' ? '暂停' : '继续'}运行 ${args.run_id}？`)
    return response(await control.controlRun({ sessionId, id: row.id, action, signal: exec.signal, approved: row.id, intent }))
  }
  if (kind !== 'local' && kind !== 'optional_robot' && !target) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'Configure the robot address first.')
  if ((kind === 'approve' || kind === 'watch') && !control.allowLive) throw new ExperimentError('ROBOT_CONTROL_DISABLED', 'Live robot control is disabled.')
  const forwarded = { ...args, session_id: sessionId }
  // The workbench selects the target and external communications for the process.
  delete forwarded.robot_ip
  if (target) forwarded.robot_ip = target.origin
  if (tool === 'deck_vision_check' && args.mode === 'preflight') forwarded.vlm_provider = 'off'
  let protocol = store.latestForSession(sessionId)?.snapshot.protocol
  let beforeDispatch
  if (kind === 'watch' || ['execute_protocol_recovery', 'recover_tip_pickup'].includes(tool)) {
    const row = requireActiveRun(control, sessionId, args.run_id)
    const device = await control.status()
    if (device.serial !== row.robot_serial || device.robotType !== row.robot_type) {
      throw new ExperimentError('ROBOT_TARGET_CHANGED', 'The configured robot does not match the original run.')
    }
    protocol = sameProtocol(store, sessionId, row)
    delete forwarded.file_path
    delete forwarded.protocol_path
    forwarded.protocol_source = protocol
    beforeDispatch = () => { requireActiveRun(control, sessionId, row.robot_run_id) }
    if (kind === 'watch') {
      if (!(await runtime.recoveryGranted(row.id))) throw new ExperimentError('ROBOT_RECOVERY_NOT_APPROVED', 'This run has no automatic recovery approval. Use query_history to check it.')
      Object.assign(forwarded, { self_fix_mode: 'l0', allow_l4_execution: true, operator_opt_in: true })
    }
  }
  if (kind === 'monitor') {
    forwarded.self_fix_mode = 'observe'
    forwarded.allow_l4_execution = false
    forwarded.operator_opt_in = false
  }
  if (kind === 'approve') {
    const { serial } = await control.status()
    if (!serial) throw new ExperimentError('ROBOT_NOT_READY', 'The device identity could not be verified.')
    const intent = ctx.get('mossVoiceIntent')?.captureIntent(sessionId)
    await approveRobotAction(ctx, exec, `Allow ${tool} on robot ${serial}? Review the requested action and stay at the robot.`,
      `允许在机器人 ${serial} 上执行 ${tool}？请核对操作并留在设备旁。`)
    if ((await control.status()).serial !== serial) throw new ExperimentError('ROBOT_TARGET_CHANGED', 'The configured robot changed. Review the device again.')
    const verifyRun = beforeDispatch
    beforeDispatch = () => { intent?.assertCurrent(); verifyRun?.() }
  }
  const dispatch = signal => runtime.experiment(target, tool, forwarded, { sessionId, signal, protocol, beforeDispatch })
  return kind === 'watch' ? control.watchRun(sessionId, forwarded.run_id, exec.signal, dispatch) : dispatch(exec.signal)
}

/** Expose the upstream schemas, original guidance, and session-owned dispatch. */
export async function apply(ctx, config) {
  if (typeof config?.prefix !== 'string' || !config.prefix.trim()) throw new Error('LabscriptAI tools require experiment assistant instructions.')
  const [workflow, tools] = await Promise.all([ctx.labscriptaiRuntime.workflow(), ctx.labscriptaiRuntime.catalog()])
  const definitions = tools.map(tool => createMcpToolDefinition(ctx, {
    name: `mcp__labscriptai__${tool.name}`, rawName: tool.name, description: tool.description ?? '',
    inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, taskRequired: tool.execution?.taskSupport === 'required',
    call: (args, exec) => invoke(ctx, tool.name, args, exec),
  }))
  definitions.push(defineTool({
    name: 'read_labscriptai_guidance',
    description: 'Read the pinned LabscriptAI workflow, recovery rules, or operating policy when the experiment needs that detail.',
    parameters: { topic: { type: 'string', enum: guidanceTopics, required: true } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: ({ topic }) => ctx.labscriptaiRuntime.guidance(topic),
  }))
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition), `labscriptai.${definition.name}`)
  ctx.effect(() => ctx.systemPrompt.suppressRuntimeContext(), 'labscriptai.runtime-context')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'labscriptai:experiment-assistant', order: 0, complete: true, interpolate: false,
    text: `${config.prefix}\n\n${workflow}`,
  }), 'labscriptai.experiment-assistant')
}
