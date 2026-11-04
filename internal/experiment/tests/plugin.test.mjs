import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../plugin.mjs'

test('opt-in service persists operations and withdraws on disposal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'experiment-plugin-'))
  const ctx = new Context()
  try {
    assert.equal(ctx.get('experimentStore'), undefined)
    const path = join(dir, 'experiments.sqlite')
    const fiber = await ctx.plugin(plugin, { path, create: true })
    const store = ctx.get('experimentStore')
    const scoped = store.createForSession('session', { creationKey: 'one', snapshot: { protocol: 'protocol' } }).experiment
    assert.equal(store.getForSession('session', scoped.id).id, scoped.id)
    assert.deepEqual(store.getChecksForSession('session', scoped.id, 1), [])
    assert.throws(() => store.getForSession('other', scoped.id), { code: 'SESSION_MISMATCH' })
    assert.equal(store.updateForSession('session', { id: scoped.id, expectedRevision: 1, snapshot: { protocol: 'new', sessionId: 'session' } }).revision, 2)
    const created = store.create({ creationKey: 'one', snapshot: { protocol: 'protocol' } }).experiment
    const task = store.startCheck({ id: created.id, revision: 1, protocolHash: created.protocolHash, name: 'check' })
    store.finishCheck({ ...task, status: 'passed', result: { ok: true } })
    assert.equal(store.getChecks(created.id, 1)[0].status, 'passed')
    const updated = store.update({ id: created.id, expectedRevision: 1, snapshot: { protocol: 'new' } })
    const backup = store.backup({ directory: dir, retain: 1 })
    await fiber.dispose()
    const backupPath = await backup
    assert.equal(ctx.get('experimentStore'), undefined)
    assert.throws(() => store.get(created.id), { code: 'STORE_CLOSED' })
    const reopened = await ctx.plugin(plugin, { path, create: false })
    assert.equal(ctx.get('experimentStore').get(created.id).revision, updated.revision)
    await reopened.dispose()
    const restored = await ctx.plugin(plugin, { path: backupPath, create: false })
    assert.equal(ctx.get('experimentStore').get(created.id).revision, updated.revision)
    await restored.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('configuration requires an explicit absolute path and creation mode', async () => {
  const ctx = new Context()
  try {
    for (const config of [{}, { path: 'relative', create: false }, { path: '/tmp/experiment.sqlite' }]) {
      await assert.rejects(Promise.resolve().then(() => ctx.plugin(plugin, config)))
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
