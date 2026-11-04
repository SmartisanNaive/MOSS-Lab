import { createHash } from 'node:crypto'
import { ExperimentError } from './index.mjs'
import { generateTransfer } from './transfer-template.mjs'

const MAX_PROTOCOL = 256 * 1024

/** Session-scoped experiment operations; analyzer and preview are trusted internal services. */
export function createWorkflow({ store, analyzer, preview, captureIntent = () => ({ assertCurrent() {}, previewReady() {} }) }) {
  const running = new Set()
  const pending = new Set()
  let closing = false
  const requireOpen = () => { if (closing) throw new ExperimentError('WORKFLOW_CLOSED', 'experiment workflow is closing') }
  const validateProtocol = protocol => {
    if (protocol !== null && (typeof protocol !== 'string' || !protocol.trim() || Buffer.byteLength(protocol) > MAX_PROTOCOL)) throw new ExperimentError('INVALID_INPUT', 'protocol must be null or a nonempty bounded string')
  }
  return {
    create({ sessionId, creationKey, requirement, parameters, protocol }) {
      requireOpen()
      captureIntent(sessionId).assertCurrent()
      if (typeof requirement !== 'string' || !requirement.trim() || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new ExperimentError('INVALID_INPUT', 'requirement and parameters are required')
      protocol = protocol === undefined ? generateTransfer(parameters) : protocol
      validateProtocol(protocol)
      if (protocol === null) throw new ExperimentError('INVALID_INPUT', 'protocol is required')
      return store.createForSession(sessionId, { creationKey, snapshot: { requirement, parameters, protocol } })
    },
    get({ sessionId, id }) {
      requireOpen()
      const experiment = store.getForSession(sessionId, id)
      const checks = store.getChecksForSession(sessionId, id, experiment.revision).map(check => {
        if (check.name !== 'protocol-analysis' || !check.result || typeof check.result !== 'object') return check
        const { analysisBase64, ...result } = check.result
        return { ...check, result }
      })
      return { experiment, checks }
    },
    update({ sessionId, id, expectedRevision, requirement, parameters, protocol }) {
      requireOpen()
      captureIntent(sessionId).assertCurrent()
      if (typeof requirement !== 'string' || !requirement.trim() || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new ExperimentError('INVALID_INPUT', 'requirement and parameters are required')
      protocol = protocol === undefined ? generateTransfer(parameters) : protocol
      validateProtocol(protocol)
      if (protocol === null) throw new ExperimentError('INVALID_INPUT', 'protocol is required')
      const current = store.getForSession(sessionId, id)
      return store.updateForSession(sessionId, { id, expectedRevision, snapshot: { ...current.snapshot, requirement, parameters, protocol, sessionId } })
    },
    async analyze({ sessionId, id, revision }) {
      requireOpen()
      const intent = captureIntent(sessionId)
      const { assertCurrent } = intent
      assertCurrent()
      if (running.has(id)) throw new ExperimentError('CHECK_IN_PROGRESS', 'analysis already in progress')
      const experiment = store.getForSession(sessionId, id)
      if (experiment.revision !== revision) throw new ExperimentError('REVISION_CONFLICT', 'experiment revision changed', { currentRevision: experiment.revision })
      validateProtocol(experiment.snapshot.protocol)
      if (experiment.snapshot.protocol === null) throw new ExperimentError('INVALID_INPUT', 'experiment has no protocol')
      running.add(id)
      const operation = (async () => {
        const task = store.startCheck({ id, revision, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
        let analysis
        try {
          analysis = await analyzer.analyze(experiment.snapshot.protocol)
          assertCurrent()
          if (!Buffer.isBuffer(analysis) || !analysis.length) throw new ExperimentError('ANALYSIS_FAILED', 'analysis returned no data')
          store.finishCheck({ ...task, status: 'passed', result: { analysisSha256: createHash('sha256').update(analysis).digest('hex'), analysisBase64: analysis.toString('base64') } })
        } catch (error) {
          const status = error?.code === 'ANALYSIS_BLOCKED' ? 'blocked' : 'error'
          try { store.finishCheck({ ...task, status, result: { message: String(error?.message ?? 'analysis failed').slice(0, 2000) } }) } catch (finishError) {
            if (finishError?.code !== 'STALE_TASK') throw finishError
          }
          throw error
        }
        if (closing) throw new ExperimentError('WORKFLOW_CLOSED', 'experiment workflow is closing')
        await preview.prepare({ id, revision, sessionId, analysis, assertCurrent })
        intent.previewReady({ id, revision })
        return { id, revision, status: 'preview_ready', note: 'Local simulation only; device readiness and experimental safety were not checked.' }
      })()
      pending.add(operation)
      try { return await operation } finally { running.delete(id); pending.delete(operation) }
    },
    async close() { closing = true; await Promise.allSettled([...pending]) },
  }
}
