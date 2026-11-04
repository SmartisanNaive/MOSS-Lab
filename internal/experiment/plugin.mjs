import { ExperimentError, ExperimentStore } from './index.mjs'

/** Internal host service for an explicitly configured experiment database. */
export const name = 'experiment-store'

/**
 * Provide `experimentStore` until the plugin is disposed. All backups settle
 * before the database closes. Store and filesystem errors propagate to callers.
 * @param {object} ctx Cordis plugin context.
 * @param {{ path: string, create: boolean }} config Absolute database path and explicit creation mode.
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const store = new ExperimentStore(config ?? {})
    let closing = false
    const backups = new Set()
    const requireOpen = () => {
      if (closing) throw new ExperimentError('STORE_CLOSED', 'experiment store is closed')
    }
    const service = {
      create(input) { requireOpen(); return store.create(input) },
      get(id, revision) { requireOpen(); return store.get(id, revision) },
      update(input) { requireOpen(); return store.update(input) },
      startCheck(input) { requireOpen(); return store.startCheck(input) },
      finishCheck(input) { requireOpen(); return store.finishCheck(input) },
      getChecks(id, revision) { requireOpen(); return store.getChecks(id, revision) },
      createForSession(sessionId, input) { requireOpen(); return store.createForSession(sessionId, input) },
      latestForSession(sessionId) { requireOpen(); return store.latestForSession(sessionId) },
      getForSession(sessionId, id, revision) { requireOpen(); return store.getForSession(sessionId, id, revision) },
      updateForSession(sessionId, input) { requireOpen(); return store.updateForSession(sessionId, input) },
      getChecksForSession(sessionId, id, revision) { requireOpen(); return store.getChecksForSession(sessionId, id, revision) },
      backup(options) {
        requireOpen()
        const pending = store.backup(options)
        backups.add(pending)
        void pending.then(() => backups.delete(pending), () => backups.delete(pending))
        return pending
      },
    }
    ctx.effect(() => async () => {
      closing = true
      await Promise.allSettled(backups)
      store.close()
    }, 'experiment-store.close')
    ctx.provide('experimentStore', service)
  }, 'experiment-store.lifecycle')
}
