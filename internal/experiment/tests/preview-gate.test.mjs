import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentStore } from '../index.mjs'
import { buildPreview } from '../preview.mjs'

test('refuses missing, mismatched, superseded, and old analysis before starting a scene process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'preview-gate-'))
  const store = new ExperimentStore({ path: join(directory, 'experiments.sqlite'), create: true })
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const experiment = store.create({ creationKey: 'gate', snapshot: { protocol: 'protocol', sessionId: 'session' } }).experiment
  const analysis = Buffer.from('{"commands":[]}')
  const digest = createHash('sha256').update(analysis).digest('hex')
  const input = { store, id: experiment.id, revision: 1, sessionId: 'session', analysis, python: '/no/such/python', flexRoot: directory, temporaryRoot: directory, timeoutMs: 1000 }
  await assert.rejects(buildPreview(input), { code: 'PREVIEW_NOT_READY' })
  const request = { id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'protocol-analysis' }
  const first = store.startCheck(request)
  store.finishCheck({ ...first, status: 'passed', result: { analysisSha256: digest } })
  await assert.rejects(buildPreview({ ...input, analysis: Buffer.from('{}') }), { code: 'PREVIEW_NOT_READY' })
  store.startCheck(request)
  await assert.rejects(buildPreview(input), { code: 'PREVIEW_NOT_READY' })
  store.update({ id: experiment.id, expectedRevision: 1, snapshot: { protocol: 'new protocol', sessionId: 'session' } })
  await assert.rejects(buildPreview(input), { code: 'STALE_TASK' })
})
