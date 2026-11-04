import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { buildPreview } from './preview.mjs'
import { PreviewResources } from './preview-resources.mjs'

export const name = 'experiment-preview'
export const inject = ['connection', 'experimentStore']

/** Mount preview resources on the authenticated Connection carrier. */
export function apply(ctx, config) {
  if (!config || typeof config.flexRoot !== 'string' || typeof config.python !== 'string' || typeof config.temporaryRoot !== 'string' || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('experiment-preview requires flexRoot, python, temporaryRoot, and a positive timeoutMs')
  const resources = new PreviewResources(ctx.experimentStore, config.flexRoot)
  // Rebuild a preview from the analysis persisted with its passed check after a restart.
  // Each completed analysis is attempted at most once per process.
  const recover = sessionId => {
    if (closing || recovering.has(sessionId)) return
    let experiment
    try { experiment = ctx.experimentStore.latestForSession(sessionId) } catch { return }
    if (!experiment) return
    const last = ctx.experimentStore.getChecks(experiment.id, experiment.revision).filter(check => check.name === 'protocol-analysis').at(-1)
    if (!last || last.status !== 'passed' || last.protocolHash !== experiment.protocolHash || typeof last.result?.analysisBase64 !== 'string') return
    const key = JSON.stringify([sessionId, experiment.id, experiment.revision, last.taskId])
    if (attempted.has(key) || preparing.has(experiment.id)) return
    attempted.add(key)
    const bytes = Buffer.from(last.result.analysisBase64, 'base64')
    if (bytes.length === 0 || createHash('sha256').update(bytes).digest('hex') !== last.result.analysisSha256) return
    let operation
    try { operation = service.prepare({ id: experiment.id, revision: experiment.revision, sessionId, analysis: bytes }) } catch { return }
    recovering.add(sessionId)
    void operation.catch(() => {}).finally(() => recovering.delete(sessionId))
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/experiment-preview',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session')
      if (url.searchParams.get('resource') !== 'status' || !sessionId) return resources.fetch(request)
      const response = await resources.fetch(request)
      const value = await response.json().catch(() => null)
      if (value?.status === 'ready') return Response.json(value, { headers: { 'Cache-Control': 'private, no-store' } })
      recover(sessionId)
      return Response.json(recovering.has(sessionId) ? { status: 'checking' } : { status: 'waiting' }, { headers: { 'Cache-Control': 'private, no-store' } })
    },
  }), 'experiment-preview.route')
  const pending = new Set()
  const preparing = new Set()
  const recovering = new Set()
  const attempted = new Set()
  let closing = false
  const service = {
    async prepare(input) {
      if (closing) throw new Error('experiment preview is closing')
      if (preparing.has(input.id)) throw new Error('experiment preview is already being prepared')
      preparing.add(input.id)
      const operation = (async () => {
        const preview = await buildPreview({ ...input, store: ctx.experimentStore, flexRoot: config.flexRoot, python: config.python, temporaryRoot: config.temporaryRoot, timeoutMs: config.timeoutMs })
        try { input.assertCurrent?.() } catch (error) { await rm(preview.directory, { recursive: true, force: true }); throw error }
        if (closing) {
          await rm(preview.directory, { recursive: true, force: true })
          throw new Error('experiment preview is closing')
        }
        const old = resources.previews.get(preview.id)
        if (old) {
          resources.withdraw(preview.id)
          try {
            await rm(old.directory, { recursive: true, force: true })
          } catch (error) {
            await rm(preview.directory, { recursive: true, force: true })
            throw error
          }
        }
        if (!resources.isCurrent(preview)) {
          await rm(preview.directory, { recursive: true, force: true })
          throw new Error('experiment changed before preview publication')
        }
        try { input.assertCurrent?.() } catch (error) { await rm(preview.directory, { recursive: true, force: true }); throw error }
        resources.publish(preview)
        resources.select(preview.id)
        return { id: preview.id, revision: preview.revision }
      })()
      pending.add(operation)
      try {
        return await operation
      } finally {
        pending.delete(operation)
        preparing.delete(input.id)
      }
    },
  }
  ctx.effect(() => {
    ctx.provide('experimentPreview', service)
    return async () => {
      closing = true
      await Promise.allSettled([...pending])
      await Promise.all([...resources.previews.values()].map(preview => rm(preview.directory, { recursive: true, force: true })))
    }
  }, 'experiment-preview.service')
}
