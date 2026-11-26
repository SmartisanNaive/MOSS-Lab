/** Provide a frozen external plugin client; unloading waits for all owned MCP calls. */
import { createPluginClient } from './plugin-client.mjs'

export const name = 'labscriptai-runtime'
export const inject = ['sandbox']

/** Mount the confined plugin adapter in the MOSS profile. */
export function apply(ctx, config) {
  const client = createPluginClient({ ...config, sandbox: ctx.sandbox })
  const pending = new Set()
  let closing = false
  const service = Object.fromEntries(['analyze', 'documents', 'robot', 'catalog', 'workflow', 'guidance', 'experiment', 'grantRecovery', 'recoveryGranted'].map(method => [method, async (...args) => {
    if (closing) throw new Error('LabscriptAI runtime is closing')
    const operation = client[method](...args)
    pending.add(operation)
    try { return await operation } finally { pending.delete(operation) }
  }]))
  const catalog = service.catalog
  let discovery
  service.catalog = () => discovery ??= catalog().catch(error => { discovery = undefined; throw error })
  ctx.effect(() => {
    ctx.provide('labscriptaiRuntime', service)
    return async () => { closing = true; await Promise.allSettled([...pending]) }
  }, 'labscriptai-runtime.service')
}
