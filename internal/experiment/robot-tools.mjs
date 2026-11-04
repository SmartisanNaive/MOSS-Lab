import { defineTool } from '../../packages/core/tools/src/schema.ts'

/** Physical-robot tools for the experiment assistant; this plugin is mounted only in that preset. */
export const name = 'robot-tools'
export const inject = ['tools', 'robotControl']

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const runId = { type: 'string', required: true, description: 'Run id returned by start_robot_run.' }
const action = {
  type: 'string', required: true,
  enum: ['pause', 'resume', 'stop'],
  description: 'pause suspends a running protocol; resume continues it; stop ends it and is always allowed, even without approval.',
}
const robotActions = { pause: 'pause', resume: 'resume-from-recovery', stop: 'stop' }

function sessionId(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || !id.trim()) throw new Error('A session identity is required for robot operations.')
  return id
}

/**
 * Register live-robot tools for the enclosing experiment-assistant preset.
 * Motion tools require a passing analysis check for the exact experiment revision,
 * a configured and enabled robot, and an operator approval requested before dispatch.
 * @param {object} ctx Cordis context for the preset with tools and robotControl.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name === 'start_robot_run' && !ctx.robotControl.allowLive) return 'Live robot execution is disabled in this deployment.'
    if (exec.name === 'control_robot_run' && exec.arguments?.action !== 'stop' && !ctx.robotControl.allowLive) return 'Live robot execution is disabled in this deployment.'
    return undefined
  }), 'robot-tools.guard')

  ctx.on('tools/pre-execute', async (exec, next) => {
    const motion = exec.name === 'start_robot_run'
      || exec.name === 'control_robot_run' && exec.arguments?.action !== 'stop'
    if (!motion) return next()
    if (exec.name === 'start_robot_run') {
      try {
        ctx.robotControl.checkRunnable(exec.agent?.session?.id, exec.arguments?.experimentId, exec.arguments?.revision)
      } catch (error) {
        return { kind: 'deny', reason: String(error?.message ?? 'the robot run prerequisites are not met') }
      }
    }
    return {
      kind: 'ask',
      reason: exec.name === 'start_robot_run'
        ? 'Start the analyzed protocol on the physical robot.'
        : 'Change the state of the physical robot run.',
      displayReason: exec.name === 'start_robot_run'
        ? { en: 'Run this protocol on the physical robot?', zh: '要在真机机器人上运行这个协议吗？' }
        : { en: 'Control the physical robot run?', zh: '要控制真机上的这次运行吗？' },
    }
  })

  ctx.tools.register(defineTool({
    name: 'get_robot_status',
    description: 'Read the configured robot identity, pipettes, door state, and emergency-stop state. This makes no robot motion. Use it before proposing a live run.',
    parameters: {},
    output,
    execute: async () => ctx.robotControl.status(),
  }))

  ctx.tools.register(defineTool({
    name: 'start_robot_run',
    description: 'Upload the current experiment revision and start it on the physical robot. Requires a passing analysis check for that exact revision, a reachable robot with a closed door and an untouched emergency stop, and explicit operator approval; the operator must be at the robot. Never call it unless the user asked to run on the real robot. Prefer a small first run and explain that physical results are not verified by simulation.',
    parameters: {
      experimentId: { type: 'string', required: true, description: 'Experiment id returned by create_experiment.' },
      revision: { type: 'integer', required: true, description: 'Current positive experiment revision whose analysis passed.' },
    },
    output,
    async execute(args, exec) {
      return ctx.robotControl.startRun({ sessionId: sessionId(exec), experimentId: args.experimentId, revision: args.revision })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_robot_run',
    description: 'Read the current status and recent commands of a robot run started by start_robot_run. This makes no robot motion.',
    parameters: { runId },
    output,
    async execute(args) {
      const run = await ctx.robotControl.getRun(args.runId)
      const commands = await ctx.robotControl.getCommands(args.runId).catch(() => null)
      return { run, commands }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'control_robot_run',
    description: 'Pause, resume, or stop a robot run. Stop is always allowed and should be used immediately when the user reports a problem. Pause and resume require operator approval.',
    parameters: { runId, action },
    output,
    async execute(args) {
      const result = await ctx.robotControl.controlRun({ runId: args.runId, action: robotActions[args.action] })
      return { runId: args.runId, action: args.action, accepted: result.accepted }
    },
  }))
}
