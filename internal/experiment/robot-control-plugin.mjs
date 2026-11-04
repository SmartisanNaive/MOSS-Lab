import { ExperimentError } from './index.mjs'
import { createRobotClient, RobotError } from './robot-client.mjs'

export const name = 'robot-control'
export const inject = ['experimentStore']

function failure(error) {
  if (error instanceof ExperimentError || error instanceof RobotError) throw error
  throw new ExperimentError('ROBOT_FAILURE', String(error?.message ?? 'robot operation failed').slice(0, 500))
}

function notConfigured() {
  return {
    status: 'not_configured',
    queriedAt: new Date().toISOString(),
    health: { available: false, reason: 'OPENTRONS_URL is not configured' },
    instruments: null,
    door: null,
    estop: null,
  }
}

/**
 * Provide operator-gated live control of the configured Opentrons robot.
 * The robot URL is fixed at load time from configuration. Motion requires a
 * passing analysis check for the exact experiment revision and protocol hash,
 * an operator approval enforced by the tool layer, and a reachable robot whose
 * door and emergency stop readings are not in a blocking state.
 * @param {object} ctx Cordis context with the experiment store.
 * @param {object} config Robot URL, limits, and live-control switch.
 */
export function apply(ctx, config) {
  if (!config || typeof config.url !== 'string' || typeof config.allowLive !== 'boolean'
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0
    || !Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0
    || !Number.isSafeInteger(config.maxProtocolBytes) || config.maxProtocolBytes <= 0) {
    throw new Error('robot-control requires a url, allowLive, and positive timeoutMs, maxBytes, and maxProtocolBytes')
  }
  const url = config.url.trim()
  const configured = url !== ''
  const client = configured
    ? createRobotClient({ url, timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, maxProtocolBytes: config.maxProtocolBytes })
    : null

  function requireLive() {
    if (!client) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'OPENTRONS_URL is not configured')
    if (!config.allowLive) throw new ExperimentError('ROBOT_CONTROL_DISABLED', 'live robot control is disabled in this deployment')
  }

  function assertRunnable(sessionId, experimentId, revision) {
    const experiment = ctx.experimentStore.getForSession(sessionId, experimentId)
    if (experiment.revision !== revision) {
      throw new ExperimentError('REVISION_CONFLICT', 'experiment revision changed', { currentRevision: experiment.revision })
    }
    const protocol = experiment.snapshot?.protocol
    if (typeof protocol !== 'string' || !protocol.trim()) throw new ExperimentError('INVALID_INPUT', 'experiment has no protocol')
    const checks = ctx.experimentStore.getChecksForSession(sessionId, experimentId, revision)
    const analysis = checks.filter(check => check.name === 'protocol-analysis').at(-1)
    if (!analysis || analysis.status !== 'passed' || analysis.protocolHash !== experiment.protocolHash) {
      throw new ExperimentError('SIMULATION_REQUIRED', 'the current experiment revision has no passing protocol analysis')
    }
    return { experiment, protocol }
  }

  async function readiness() {
    const status = await client.status()
    if (!status.health?.available) throw new ExperimentError('ROBOT_UNREACHABLE', 'the configured robot did not answer a health check')
    if (status.door?.status && status.door.status !== 'closed') throw new ExperimentError('ROBOT_NOT_READY', `the robot door is ${status.door.status}`)
    if (status.estop?.status && status.estop.status !== 'disengaged') throw new ExperimentError('ROBOT_NOT_READY', `the emergency stop is ${status.estop.status}`)
    return status
  }

  async function startRun({ sessionId, experimentId, revision }) {
    try {
      requireLive()
      const { experiment, protocol } = assertRunnable(sessionId, experimentId, revision)
      const robot = await readiness()
      const task = ctx.experimentStore.startCheck({ id: experimentId, revision, protocolHash: experiment.protocolHash, name: 'robot-run' })
      try {
        const uploaded = await client.uploadProtocol(protocol, `experiment-${experimentId}-r${revision}.py`)
        const created = await client.createRun(uploaded.protocolId)
        await client.runAction(created.runId, 'play')
        const startedAt = new Date().toISOString()
        ctx.experimentStore.finishCheck({ ...task, status: 'passed', result: { phase: 'started', runId: created.runId, protocolId: uploaded.protocolId, startedAt, robot: robot.health } })
        return { runId: created.runId, protocolId: uploaded.protocolId, status: 'started', startedAt, robot, note: 'The robot accepted the run; completion and physical results require polling the run status.' }
      } catch (error) {
        try { ctx.experimentStore.finishCheck({ ...task, status: 'error', result: { message: String(error?.message ?? 'robot run failed').slice(0, 1000) } }) } catch { /* The revision may have changed while the run was being prepared; the transport error remains the actionable failure. */ }
        throw error
      }
    } catch (error) {
      failure(error)
    }
  }

  async function getRun(runId) {
    if (!client) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'OPENTRONS_URL is not configured')
    try { return await client.getRun(runId) } catch (error) { failure(error) }
  }

  async function getCommands(runId) {
    if (!client) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'OPENTRONS_URL is not configured')
    try { return await client.getCommands(runId) } catch (error) { failure(error) }
  }

  function checkRunnable(sessionId, experimentId, revision) {
    requireLive()
    assertRunnable(sessionId, experimentId, revision)
  }

  async function controlRun({ runId, action }) {
    try {
      if (!client) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'OPENTRONS_URL is not configured')
      if (action !== 'stop') requireLive()
      await client.runAction(runId, action)
      return { runId, action, accepted: true }
    } catch (error) {
      failure(error)
    }
  }

  ctx.effect(() => ctx.provide('robotControl', {
    configured,
    allowLive: config.allowLive,
    async status() {
      if (!client) return notConfigured()
      try { return { status: 'ready', ...(await client.status()) } } catch (error) {
        if (error instanceof RobotError) return { status: 'unreachable', queriedAt: new Date().toISOString(), reason: error.message, health: null, instruments: null, door: null, estop: null }
        throw error
      }
    },
    startRun,
    getRun,
    getCommands,
    controlRun,
    checkRunnable,
  }), 'robot-control.service')
}
