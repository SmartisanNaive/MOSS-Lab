import { createWorkflow } from './workflow.mjs'

export const name = 'experiment-workflow'
export const inject = ['experimentStore', 'experimentPreview', 'protocolAnalyzer']

/** Mount the session-scoped experiment workflow. */
export function apply(ctx) {
  ctx.effect(() => {
    const service = createWorkflow({ store: ctx.experimentStore, preview: ctx.experimentPreview, analyzer: ctx.protocolAnalyzer, captureIntent: id => ctx.get('mossVoiceIntent')?.captureIntent(id) ?? { assertCurrent() {}, previewReady() {} } })
    ctx.provide('experimentWorkflow', service)
    return () => service.close()
  }, 'experiment-workflow.service')
}
