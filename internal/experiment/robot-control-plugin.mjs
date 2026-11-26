import { ExperimentError } from './index.mjs'

export const name = 'robot-control'
export const inject = ['experimentStore', 'labscriptaiRuntime']

const terminal = new Set(['succeeded', 'failed', 'stopped'])
const identifier = value => typeof value === 'string' && /^[a-z0-9_-]{1,120}$/i.test(value)

/** Connect the session-owned experiment record to the configured physical robot. */
export function apply(ctx, config) {
  if (typeof config?.url !== 'string' || typeof config.allowLive !== 'boolean') throw new Error('robot-control requires url and allowLive')
  let target = null
  if (config.url.trim()) {
    const url = new URL(config.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error('OPENTRONS_URL must be an HTTP(S) origin')
    const authorization = url.username || url.password
      ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64')
      : null
    target = { origin: url.origin, authorization }
  }
  const store = ctx.experimentStore
  const pendingWatches = new Map()
  const call = (tool, args, protocol, beforeDispatch, sessionId) => {
    if (!target) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'Configure the robot address first.')
    return ctx.labscriptaiRuntime.robot(target, tool, { ...args, ...(sessionId ? { session_id: sessionId } : {}), robot_ip: target.origin }, protocol, beforeDispatch, sessionId)
  }
  function requireLive() {
    if (!config.allowLive) throw new ExperimentError('ROBOT_CONTROL_DISABLED', 'Live robot control is disabled. Set MOSS_ALLOW_LIVE_ROBOT=1 to enable it.')
    if (!target) throw new ExperimentError('ROBOT_NOT_CONFIGURED', 'Configure the robot address first.')
  }

  function checkRunnable(sessionId, experimentId, revision) {
    requireLive()
    const experiment = store.getForSession(sessionId, experimentId)
    if (experiment.revision !== revision) throw new ExperimentError('REVISION_CONFLICT', 'The experiment revision changed.')
    const analysis = store.getChecksForSession(sessionId, experimentId, revision).findLast(check => check.name === 'protocol-analysis')
    if (analysis?.status !== 'passed' || analysis.protocolHash !== experiment.protocolHash) {
      throw new ExperimentError('SIMULATION_REQUIRED', 'Analyze the current protocol revision first.')
    }
    const robotType = analysis.result?.robotType
    if (robotType !== 'Flex' && robotType !== 'OT-2') throw new ExperimentError('SIMULATION_REQUIRED', 'Analyze this revision again to verify its robot type.')
    return { experiment, analysis, robotType }
  }

  async function status() {
    const value = await call('robot_status', { include_modules: true })
    return {
      robotType: value.authoring_context?.robot_type ?? null,
      serial: value.health_summary?.robot_serial ?? null,
      name: value.health_summary?.name ?? null,
      blockers: value.blockers ?? [],
      unchecked: value.not_checked ?? [],
      authoringContext: value.authoring_context ?? null,
      deckConfiguration: value.deck_configuration ?? null,
      modules: value.modules?.modules ?? [],
    }
  }

  function run(sessionId, id) {
    const row = store.robotRun(sessionId, id)
    if (row.target !== target?.origin) throw new ExperimentError('ROBOT_TARGET_CHANGED', 'Restore the original robot address before controlling this run.')
    return row
  }

  function identity(row) {
    return { expected_robot_type: row.robot_type, expected_robot_serial: row.robot_serial }
  }

  function sendRunAction(row, action, expectedStatus, beforeDispatch) {
    return call('control_run', {
      run_id: row.robot_run_id, action, return_after_action: true, ...identity(row),
      ...(expectedStatus ? { expected_run_status: expectedStatus } : {}),
    }, undefined, beforeDispatch, row.session_id)
  }

  async function reconcilePreparedRun(row) {
    const robot = await status()
    if (robot.serial !== row.robot_serial || robot.robotType !== row.robot_type) {
      throw new ExperimentError('ROBOT_TARGET_CHANGED', 'The configured robot does not match this run receipt.')
    }
    const protocols = (await call('get_protocols', {})).protocols?.data
    const protocolIds = new Set((Array.isArray(protocols) ? protocols : [])
      .filter(protocol => protocol.key === row.id).map(protocol => protocol.id))
    if (protocolIds.size === 0) return null
    const runs = (await call('query_history', { scope: 'robot_runs' })).runs?.data
    const candidates = (Array.isArray(runs) ? runs : []).filter(run => protocolIds.has(run.protocolId))
    const candidate = candidates.length === 1 ? candidates[0].id : null
    if (!identifier(candidate)) return null
    store.recordRobotRun(row.session_id, row.id, candidate)
    return candidate
  }

  async function getRun(sessionId, id) {
    let row = run(sessionId, id)
    if (row.active && !row.robot_run_id && await reconcilePreparedRun(row)) row = run(sessionId, id)
    if (!row.robot_run_id) return { id, status: row.active ? (row.cancel_requested ? 'cancellation_requested' : 'preparation_unconfirmed') : 'blocked', revision: row.revision }
    const info = await call('query_history', { scope: 'run_commands', run_id: row.robot_run_id, ...identity(row) })
    if (terminal.has(info.status)) store.finishRobotRun(sessionId, id)
    return { id, runId: row.robot_run_id, status: info.status ?? 'unknown', revision: row.revision, commands: info.recent_commands ?? [] }
  }

  async function verifyStart(sessionId, experimentId, revision) {
    const saved = checkRunnable(sessionId, experimentId, revision)
    const robot = await status()
    if (!identifier(robot.serial) || robot.robotType !== saved.robotType || robot.blockers.length) {
      throw new ExperimentError('ROBOT_NOT_READY', 'The configured robot must match the analyzed protocol and report no device blockers.')
    }
    return { ...saved, robot }
  }

  async function startRun({ sessionId, experimentId, revision, signal, approved }) {
    const intent = approved?.intent ?? ctx.get('mossVoiceIntent')?.captureIntent(sessionId)
    intent?.assertCurrent()
    const { experiment, analysis, robotType, robot } = await verifyStart(sessionId, experimentId, revision)
    if (approved?.serial !== robot.serial || approved.robotType !== robotType || approved.taskId !== analysis.taskId) {
      throw new ExperimentError('ROBOT_APPROVAL_STALE', 'The approved device or protocol analysis changed. Review it again.')
    }
    const assertCurrent = () => {
      signal?.throwIfAborted()
      try { intent?.assertCurrent() } catch {
        throw new ExperimentError('ROBOT_APPROVAL_STALE', 'The experiment request changed. Review it again.')
      }
      if (checkRunnable(sessionId, experimentId, revision).analysis.taskId !== analysis.taskId) {
        throw new ExperimentError('ROBOT_APPROVAL_STALE', 'The protocol analysis changed. Review it again.')
      }
    }
    assertCurrent()
    const id = store.reserveRobotRun({ sessionId, experimentId, revision, target: target.origin, robotSerial: robot.serial, robotType })
    const row = run(sessionId, id)
    let dispatchingPreparation = false
    const beforePrepare = () => {
      assertCurrent()
      if (run(sessionId, id).cancel_requested) throw new ExperimentError('ROBOT_RUN_INACTIVE', 'Robot preparation was cancelled.')
      dispatchingPreparation = true
    }
    let physicalId = null
    try {
      if (approved.automaticRecovery) await ctx.labscriptaiRuntime.grantRecovery(id)
      const result = await call('run_protocol', {
        key: id, auto_play: false, return_after_prepare: true, ...identity(row),
      }, experiment.snapshot.protocol, beforePrepare, sessionId)
      physicalId = result.created_run?.data?.id ?? result.created_run?.id
      if (!identifier(physicalId)) throw new ExperimentError('ROBOT_PREPARATION_INVALID', 'OT did not return a usable run ID.')
      store.recordRobotRun(sessionId, id, physicalId)
      const prepared = run(sessionId, id)
      if (prepared.cancel_requested) {
        const stopped = await controlRun({ sessionId, id, action: 'stop' })
        return { id, runId: physicalId, status: stopped.status === 'action_acknowledged' ? 'stop_acknowledged' : 'stop_unconfirmed', revision }
      }
      if (result.preflight_gate?.allowed_to_play !== true) throw new ExperimentError('ROBOT_PREFLIGHT_BLOCKED', 'The robot did not pass its setup checks.')
      await sendRunAction(prepared, 'play', ['idle'], () => {
        assertCurrent()
        const current = run(sessionId, id)
        if (!current.active || current.cancel_requested) throw new ExperimentError('ROBOT_RUN_INACTIVE', 'Robot preparation was cancelled.')
      })
      return { id, runId: physicalId, status: 'start_acknowledged', revision }
    } catch (error) {
      if (!physicalId) {
        if (identifier(error.details?.runId)) {
          store.recordRobotRun(sessionId, id, error.details.runId)
          return { id, runId: error.details.runId, status: 'prepared_not_started', revision, note: 'OT blocked preparation. Check or stop the saved robot run.' }
        }
        if (!dispatchingPreparation || (error.code === 'ROBOT_PREFLIGHT_BLOCKED' && error.details?.stage !== 'preflight_run_setup')) {
          store.finishRobotRun(sessionId, id)
          throw error
        }
        return { id, status: 'preparation_unconfirmed', revision, note: 'Check the robot locally before any replacement run. This reservation remains active.' }
      }
      if (error.code === 'ROBOT_PREFLIGHT_BLOCKED' || error.code === 'ROBOT_APPROVAL_STALE' || signal?.aborted && error === signal.reason) {
        return { id, runId: physicalId, status: 'prepared_not_started', revision, note: 'Stop this prepared run before starting a replacement.' }
      }
      return { id, runId: physicalId, status: 'start_unconfirmed', revision, note: 'Check the robot state before sending any further action.' }
    }
  }

  function activeRunForMcp(sessionId, runId) {
    const id = target && store.activeRobotRun(sessionId, target.origin)
    if (!id) throw new ExperimentError('ROBOT_RUN_NOT_FOUND', 'There is no active robot run in this conversation.')
    const row = run(sessionId, id)
    if (!row.robot_run_id || row.robot_run_id !== runId) throw new ExperimentError('ROBOT_RUN_NOT_FOUND', 'This run does not belong to the active experiment.')
    return row
  }

  async function watchRun(sessionId, runId, signal, watch) {
    const row = activeRunForMcp(sessionId, runId)
    if (row.cancel_requested || pendingWatches.has(row.id)) throw new ExperimentError('ROBOT_WATCH_UNAVAILABLE', 'This run is stopping or already has a watcher.')
    const controller = new AbortController()
    pendingWatches.set(row.id, controller)
    try {
      return await watch(AbortSignal.any([signal, controller.signal]))
    } finally {
      pendingWatches.delete(row.id)
    }
  }

  async function controlRun({ sessionId, id, action, signal, approved, intent }) {
    let row = run(sessionId, id)
    if (action === 'stop') {
      store.requestRobotStop(sessionId, id)
      pendingWatches.get(id)?.abort()
      row = run(sessionId, id)
      if (row.active && !row.robot_run_id) {
        try { await reconcilePreparedRun(row) } catch { /* Cancellation is already durable. */ }
        row = run(sessionId, id)
        if (!row.robot_run_id) return { id, action, status: 'cancellation_requested' }
      }
    }
    if (!row.active) throw new ExperimentError('ROBOT_RUN_INACTIVE', 'This robot run is not active.')
    if (!row.robot_run_id) throw new ExperimentError('ROBOT_RUN_UNCONFIRMED', 'Read the current run again before controlling it.')
    const expectedStatus = action === 'pause' ? ['running'] : action === 'resume' ? ['paused'] : null
    if (expectedStatus) {
      requireLive()
      if (approved !== id) throw new ExperimentError('ROBOT_APPROVAL_STALE', 'Review this action in the workbench.')
    } else if (action !== 'stop') throw new ExperimentError('INVALID_INPUT', 'Unknown robot action.')
    try {
      await sendRunAction(row, action === 'resume' ? 'play' : action, expectedStatus, () => {
        signal?.throwIfAborted()
        intent?.assertCurrent()
        const current = run(sessionId, id)
        if (!current.active || (action !== 'stop' && current.cancel_requested)) {
          throw new ExperimentError('ROBOT_RUN_INACTIVE', 'This robot run is no longer active or has been stopped.')
        }
      })
      return { id, action, status: 'action_acknowledged' }
    } catch (error) {
      if (error.code === 'ROBOT_PREFLIGHT_BLOCKED') throw error
      return { id, action, status: 'action_unconfirmed', note: 'Check the robot state before retrying. If there is an immediate hazard, stop the robot locally.' }
    }
  }

  ctx.effect(() => {
    ctx.provide('robotControl', {
      configured: target !== null, allowLive: config.allowLive,
      verifyStart, status, startRun, getRun, controlRun, activeRunForMcp, watchRun,
      target: () => target,
      activeRun: sessionId => target ? store.activeRobotRun(sessionId, target.origin) : null,
    })
    return () => { for (const watcher of pendingWatches.values()) watcher.abort() }
  }, 'robot-control.service')
}
