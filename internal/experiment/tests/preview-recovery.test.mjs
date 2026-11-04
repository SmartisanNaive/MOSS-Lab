import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../../../vendor/cordis/src/index.ts'
import { ExperimentStore } from '../index.mjs'
import * as previewPlugin from '../preview-plugin.mjs'

const lab = resolve(import.meta.dirname, '../../../labscriptai-ot')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const analysisFixture = () => Buffer.from(JSON.stringify({ robotType: 'OT-3 Standard', metadata: { protocolName: 'recovery' }, commands: [{ id: 'home', commandType: 'home', params: {}, status: 'succeeded' }] }))

// A preview exists only in process memory; after a restart only the stored passed
// check remains. Polling the status of its session must rebuild the scene from
// the persisted analysis bytes and report it ready again.
test('status polling rebuilds a preview from the analysis persisted with its passed check', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-recovery-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  const ctx = new Context()
  let route
  ctx.provide('experimentStore', store)
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => {} } } })
  const seed = (sessionId, creationKey, analysis, sha256) => {
    const { experiment } = store.createForSession(sessionId, { creationKey, snapshot: { protocol: 'print(1)' } })
    const task = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
    store.finishCheck({ ...task, status: 'passed', result: { analysisSha256: sha256, analysisBase64: analysis.toString('base64') } })
    return experiment
  }
  const analysis = analysisFixture()
  const experiment = seed('s1', 'one', analysis, sha256(analysis))
  const { experiment: late } = store.createForSession('late', { creationKey: 'one', snapshot: { protocol: 'print(1)' } })
  const lateTask = store.startCheck({ id: late.id, revision: 1, protocolHash: late.protocolHash, name: 'protocol-analysis' })
  // s2's stored digest does not match its stored bytes, so the persisted result is untrusted.
  seed('s2', 'one', analysis, sha256(Buffer.from('tampered')))
  const plugin = ctx.plugin(previewPlugin, { flexRoot: join(lab, 'automation/flex3d'), python: join(lab, '.venv/bin/python'), temporaryRoot: dir, timeoutMs: 60000 })
  const status = async session => (await route.fetch(new Request(`http://localhost/api/experiment-preview?resource=status&session=${session}`))).json()
  try {
    await plugin.await()
    const statuses = new Set(['checking', 'waiting'])
    assert.ok(statuses.has((await status('s1')).status))
    let ready
    for (let i = 0; i < 40 && (ready = await status('s1')).status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(ready.status, 'ready')
    assert.equal(ready.id, experiment.id)
    assert.equal(ready.revision, 1)
    assert.equal((await status('s1')).status, 'ready')
    assert.equal((await status('late')).status, 'waiting')
    store.finishCheck({ ...lateTask, status: 'passed', result: { analysisSha256: sha256(analysis), analysisBase64: analysis.toString('base64') } })
    let lateStatus
    for (let i = 0; i < 40 && (lateStatus = await status('late')).status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(lateStatus.status, 'ready')
    assert.equal(lateStatus.id, late.id)
    for (let i = 0; i < 3; i++) assert.equal((await status('s2')).status, 'waiting')
  } finally {
    await plugin.dispose()
    await ctx.fiber.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('sessions without a recoverable latest experiment keep waiting', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-recovery-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  const ctx = new Context()
  let route
  ctx.provide('experimentStore', store)
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => {} } } })
  // No experiment at all; an experiment whose analysis never passed; a legacy passed check without persisted bytes.
  const { experiment: failed } = store.createForSession('s1', { creationKey: 'one', snapshot: { protocol: 'print(1)' } })
  const failedTask = store.startCheck({ id: failed.id, revision: 1, protocolHash: failed.protocolHash, name: 'protocol-analysis' })
  store.finishCheck({ ...failedTask, status: 'error', result: { message: 'boom' } })
  const { experiment: legacy } = store.createForSession('s2', { creationKey: 'one', snapshot: { protocol: 'print(1)' } })
  const legacyTask = store.startCheck({ id: legacy.id, revision: 1, protocolHash: legacy.protocolHash, name: 'protocol-analysis' })
  store.finishCheck({ ...legacyTask, status: 'passed', result: { analysisSha256: sha256(analysisFixture()) } })
  const plugin = ctx.plugin(previewPlugin, { flexRoot: join(lab, 'automation/flex3d'), python: join(lab, '.venv/bin/python'), temporaryRoot: dir, timeoutMs: 60000 })
  const status = async session => (await route.fetch(new Request(`http://localhost/api/experiment-preview?resource=status&session=${session}`))).json()
  try {
    await plugin.await()
    assert.equal((await status('unknown')).status, 'waiting')
    assert.equal((await status('s1')).status, 'waiting')
    assert.equal((await status('s2')).status, 'waiting')
  } finally {
    await plugin.dispose()
    await ctx.fiber.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
