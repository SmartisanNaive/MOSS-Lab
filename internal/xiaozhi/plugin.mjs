import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { connectBridge } from './bridge.mjs'
import { createDelegation } from './delegation.mjs'

export const name = 'xiaozhi-readonly'
export const inject = ['experimentStore', 'sessionController', 'workspaceRegistry']

/** Mount an opt-in connection for one explicitly selected session.
 * @param {object} ctx Cordis context with the experiment store.
 * @param {{ sessionId: string }} config Session authorized by the operator for this endpoint.
 */
export function apply(ctx, config) {
  if (!config || (config.sessionId !== null && (typeof config.sessionId !== 'string' || !config.sessionId.trim()))) throw new Error('xiaozhi-readonly requires a sessionId or null')
  ctx.effect(() => {
    let endpoint
    try {
      const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
      endpoint = parseEnv(readFileSync(envPath, 'utf8')).XIAOZHI_WSS_URL
    } catch {
      throw new Error('xiaozhi-readonly could not read the project root .env')
    }
    if (!endpoint) throw new Error('xiaozhi-readonly requires XIAOZHI_WSS_URL in the project root .env')
    const delegation = createDelegation({ controller: ctx.sessionController, workspaces: ctx.workspaceRegistry, events: ctx, sessionId: config.sessionId })
    const disconnect = connectBridge({ url: endpoint, sessionId: config.sessionId, store: ctx.experimentStore, delegation })
    return () => { disconnect(); delegation.close() }
  }, 'xiaozhi-readonly.connection')
}
