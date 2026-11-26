import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'robot-tools'
export const inject = ['tools', 'robotControl']
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const experimentId = { type: 'string', required: true, description: 'Experiment identifier in this conversation.' }
const revision = { type: 'integer', required: true, description: 'Current analyzed protocol revision.' }
const id = { type: 'string', description: 'MOSS robot run receipt, not the raw robot run ID.' }

function sessionId(exec) {
  const id = exec.agent?.session?.id
  if (!id) throw new Error('Robot operations require an experiment conversation.')
  return id
}

/** Ask the workbench for a one-shot device decision independent of file access. */
export async function approveRobotAction(ctx, exec, en, zh) {
  const approval = ctx.get('approval')
  if (!approval) throw new Error('Open the MOSS workbench to confirm physical robot operations.')
  const outcome = await approval.request({
    agent: exec.agent, toolName: exec.name, callId: exec.callId,
    reason: en, displayReason: { en, zh }, signal: exec.signal,
  }, { policy: 'ask' })
  if (outcome !== 'allowed-once') throw new Error('The operator did not approve this robot action.')
  exec.signal.throwIfAborted()
}

/** Start the saved revision through the device confirmation and run receipt. */
export async function startOwnedRobotRun(ctx, args, exec) {
  const control = ctx.robotControl
  const session = sessionId(exec)
  const intent = ctx.get('mossVoiceIntent')?.captureIntent(session)
  const { robot, analysis } = await control.verifyStart(session, args.experimentId, args.revision)
  intent?.assertCurrent()
  await approveRobotAction(ctx, exec,
    `Run experiment ${args.experimentId} revision ${args.revision} on ${robot.robotType} (${robot.serial})? This includes LabscriptAI automatic recovery for supported minor issues. Confirm the physical deck and stay at the robot.`,
    `在 ${robot.robotType}（${robot.serial}）运行实验 ${args.experimentId} 的第 ${args.revision} 版？本次运行允许 LabscriptAI 自动处理它支持的小故障。请核对台面并留在设备旁。`)
  return control.startRun({ ...args, sessionId: session, signal: exec.signal, approved: { ...robot, taskId: analysis.taskId, intent, automaticRecovery: true } })
}

/** Expose physical robot operations in the experiment assistant preset. */
export function apply(ctx) {
  const control = ctx.robotControl
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_robot_status',
    description: 'Read the configured robot identity and device blockers. Makes no robot motion.',
    parameters: {},
    output,
    execute: () => control.status(),
  })), 'robot-tools.status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'start_robot_run',
    description: 'Run the analyzed experiment on the physical robot only when explicitly requested. The workbench requests operator approval for the exact device and protocol revision. The acknowledgement does not establish completion.',
    parameters: { experimentId, revision },
    output,
    execute: (args, exec) => startOwnedRobotRun(ctx, args, exec),
  })), 'robot-tools.start')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_robot_run',
    description: 'Read actual status and recent commands. If id is omitted, find the active run owned by this conversation.',
    parameters: { id },
    output,
    execute(args, exec) {
      const session = sessionId(exec)
      const receipt = args.id ?? control.activeRun(session)
      return receipt ? control.getRun(session, receipt) : { status: 'no_active_run' }
    },
  })), 'robot-tools.run-status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'control_robot_run',
    description: 'Pause, resume, or stop a run owned by this conversation. Pause and resume request confirmation. Stop can be sent immediately.',
    parameters: { id: { ...id, required: true }, action: { type: 'string', required: true, enum: ['pause', 'resume', 'stop'], description: 'Physical run action.' } },
    output,
    async execute(args, exec) {
      const session = sessionId(exec)
      const intent = args.action === 'stop' ? null : ctx.get('mossVoiceIntent')?.captureIntent(session)
      if (args.action !== 'stop') {
        if (!control.allowLive) throw new Error('Live robot control is disabled.')
        await approveRobotAction(ctx, exec, `Confirm ${args.action} for robot run ${args.id}.`,
          `确认${args.action === 'pause' ? '暂停' : '继续'}真机运行 ${args.id}？`)
      }
      return control.controlRun({ ...args, sessionId: session, signal: exec.signal, approved: args.id, intent })
    },
  })), 'robot-tools.control')
}
