import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ExperimentStore } from './index.mjs'
import { buildPreview } from './preview.mjs'
import { PreviewResources } from './preview-resources.mjs'

export const name = 'experiment-demo'
export const inject = ['connection', 'protocolAnalyzer']

/** Provide a clearly marked, disposable simulation without touching user experiments. */
export function apply(ctx, config) {
  if (!config || typeof config.flexRoot !== 'string' || typeof config.python !== 'string' || typeof config.temporaryRoot !== 'string' || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('experiment-demo requires scene paths and timeout')
  let closing = false
  let resources
  let directory
  let store
  const start = (async () => {
    directory = await mkdtemp(join(config.temporaryRoot, 'demo-'))
    store = new ExperimentStore({ path: join(directory, 'demo.sqlite'), create: true })
    const protocol = await readFile(new URL('./example_transfer.py', import.meta.url), 'utf8')
    const analysis = await ctx.protocolAnalyzer.analyze(protocol)
    const experiment = store.createForSession('demo', { creationKey: 'demo', snapshot: { protocol } }).experiment
    const task = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
    store.finishCheck({ ...task, status: 'passed', result: { analysisSha256: createHash('sha256').update(analysis).digest('hex') } })
    const preview = await buildPreview({ store, id: experiment.id, revision: 1, sessionId: 'demo', analysis, python: config.python, flexRoot: config.flexRoot, temporaryRoot: directory, timeoutMs: config.timeoutMs })
    if (!closing) {
      resources = new PreviewResources(store, config.flexRoot, '/api/experiment-demo')
      resources.publish(preview)
      resources.select(experiment.id)
    }
  })()
  // The route reports unavailable when startup fails; cleanup still owns the task.
  start.catch(error => console.error('Experiment demo generation failed:', error))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/experiment-demo', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try { await start } catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
      if (closing || !resources) return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      const url = new URL(request.url)
      if (url.searchParams.get('resource') === 'status') url.searchParams.set('session', 'demo')
      return resources.fetch(new Request(url, { method: request.method }))
    },
  }), 'experiment-demo.route')
  ctx.effect(() => async () => {
    closing = true
    await start.catch(() => {})
    if (store) store.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  }, 'experiment-demo.cleanup')
}
