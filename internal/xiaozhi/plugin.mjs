import { appendFileSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { connectBridge } from './bridge.mjs'
import { createDelegation } from './delegation.mjs'
import { registerWorkbench } from './workbench-route.mjs'
import { createWorkbenchWakeup } from './workbench-wakeup.mjs'
import { createVoiceFeedback } from './voice-feedback.mjs'

export const name = 'xiaozhi-readonly'
export const inject = ['experimentStore', 'sessionController', 'workspaceRegistry', 'connection', 'sessionPersistence', 'webServer', 'agents']

/** Mount an opt-in connection for one explicitly selected session.
 * @param {object} ctx Cordis context with the experiment store.
 * @param {{ sessionId: string }} config Session authorized by the operator for this endpoint.
 */
export function apply(ctx, config) {
  if (!config || (config.sessionId !== null && (typeof config.sessionId !== 'string' || !config.sessionId.trim()))) throw new Error('xiaozhi-readonly requires a sessionId or null')
  ctx.effect(() => {
    let endpoint = process.env.XIAOZHI_WSS_URL
    if (endpoint === undefined) {
      try { endpoint = parseEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8')).XIAOZHI_WSS_URL }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('xiaozhi could not read the project .env') }
    }
    const wakeup = createWorkbenchWakeup({ ...config.wakeup, url: () => {
      const port = ctx.webServer.port
      if (port === undefined) throw new Error('网页服务尚未监听')
      return ctx.connection.authenticatedUrl('http://127.0.0.1:' + port + '/')
    } })
    const delegation = createDelegation({ controller: ctx.sessionController, workspaces: ctx.workspaceRegistry, events: ctx, sessionId: config.sessionId, bindingPath: config.bindingPath ?? null, workspacePath: config.workspacePath ?? null, agentPreset: config.agentPreset ?? 'standard',
      cancelSession: async id => { ctx.agents.get(id)?.cancel({ kind: 'user' }, { keepInbox: true }) },
      removePendingVoice: async (id, requestId) => {
        const agent = ctx.agents.get(id)
        if (!agent) return
        for (const item of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
          if (item.source?.rpcId === requestId) agent.inbox.remove(item.id)
        }
      }, validateSession: async (id, preset) => {
        const saved = await ctx.sessionPersistence.stat(id)
        if (!saved) throw new Error('原实验会话不存在，请检查记录或明确开始新实验。')
        if ((saved.header.agentPreset ?? 'standard') !== preset) throw new Error('旧会话的模式与实验助手不一致，请明确开始新实验；旧对话记录会保留。')
      } })
    const feedback = createVoiceFeedback({ delegation, ...config.feedback })
    ctx.provide('mossVoiceIntent', delegation)
    let seenFocus = 0
    const reportWake = state => { if (state.status === 'error') console.warn('xiaozhi workbench window:', state.reason) }
    const stopChanges = delegation.subscribe(() => {
      const current = delegation.workbench()
      if (current.focusSequence > seenFocus) { seenFocus = current.focusSequence; void wakeup.wake().then(reportWake) }
    })
    let disconnect, unregister
    const record = value => {
      if (!config.diagnosticsPath) return
      try { appendFileSync(config.diagnosticsPath, JSON.stringify(value) + '\n', { mode: 0o600 }) }
      catch { console.warn('xiaozhi diagnostics could not be saved') }
    }
    const recordSpeech = result => { record({ kind: 'speech_decision', jobId: result.jobId, cycleId: result.cycleId, phase: result.phase, speak: result.speech.speak, reason: result.speech.reason, waitingCount: result.speech.waitingCount, at: Date.now() }); return result }
    const workbench = {
      ...delegation,
      async submit(message, options) {
        const receipt = await delegation.submit(message, options)
        void wakeup.ensureOpen().then(reportWake)
        return receipt
      },
      voiceReceipt: id => recordSpeech(feedback.receipt(id)),
      voiceStatus: async (id, options) => recordSpeech(await feedback.status(id, options)),
      workbench() {
        return { ...delegation.workbench(), connection: disconnect?.snapshot() ?? { status: 'not_configured', registered: false, reconnects: 0, lastCall: null }, wakeup: wakeup.state(), speechPolicy: feedback.snapshot() }
      },
    }
    let reportedConnectionStatus
    try {
      unregister = registerWorkbench(ctx.connection, workbench)
      if (endpoint) disconnect = connectBridge({ url: endpoint, sessionId: config.sessionId, store: ctx.experimentStore, delegation: workbench,
        liveControl: () => {
          const control = ctx.get('robotControl')
          return control ? { configured: control.configured, allowLive: control.allowLive } : null
        },
        ...config.transport,
        onState: (status, state) => {
          record({ ...state, source: 'xiaozhi-mcp' })
          if (status !== reportedConnectionStatus && ['ready', 'retrying', 'connection_error'].includes(status)) console.info('xiaozhi MCP:', status)
          reportedConnectionStatus = status
        } })
    } catch (error) {
      stopChanges(); feedback.close(); void unregister?.(); void wakeup.close(); delegation.close(); throw error
    }
    return async () => { stopChanges(); feedback.close(); delegation.close(); const stoppedWake = wakeup.close(); await unregister?.(); await disconnect?.(); await stoppedWake }
  }, 'xiaozhi-readonly.connection')
}
