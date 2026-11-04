import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentStore } from '../index.mjs'
import { createWorkflow } from '../workflow.mjs'
import { generateTransfer } from '../transfer-template.mjs'

test('rejects invalid transfer parameters before generating code', () => {
  const valid = { source: 'A1', destinations: ['B1'], volumeUl: 50 }
  for (const parameters of [
    { ...valid, source: 'A1\"; import os' },
    { ...valid, destinations: ['A1', 'A1'] },
    { ...valid, destinations: ['I1'] },
    { ...valid, volumeUl: 201 },
    { ...valid, extra: 'x' },
  ]) assert.throws(() => generateTransfer(parameters), { code: 'INVALID_INPUT' })
  assert.match(generateTransfer(valid), /source\["A1"\]/)
})

test('stores and analyzes the exact generated source for the current revision', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-source-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  let analyzed
  const workflow = createWorkflow({ store, analyzer: { async analyze(source) { analyzed = source; return Buffer.from('{"commands":[]}') } }, preview: { async prepare() {} } })
  t.after(async () => { await workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const protocol = 'def run(protocol):\n    protocol.comment("custom")\n'
  const { experiment } = workflow.create({ sessionId: 'owner', creationKey: 'custom', requirement: 'simulate', parameters: { assumptions: 'none' }, protocol })
  assert.equal(experiment.snapshot.protocol, protocol)
  await workflow.analyze({ sessionId: 'owner', id: experiment.id, revision: 1 })
  assert.equal(analyzed, protocol)
  const storedCheck = store.getChecksForSession('owner', experiment.id, 1)[0]
  assert.equal(Buffer.from(storedCheck.result.analysisBase64, 'base64').toString(), '{"commands":[]}')
  const visibleCheck = workflow.get({ sessionId: 'owner', id: experiment.id }).checks[0]
  assert.equal(Object.hasOwn(visibleCheck.result, 'analysisBase64'), false)
  assert.equal(visibleCheck.result.analysisSha256, storedCheck.result.analysisSha256)
  assert.throws(() => workflow.create({ sessionId: 'owner', creationKey: 'empty', requirement: 'simulate', parameters: {}, protocol: '' }), { code: 'INVALID_INPUT' })
  assert.throws(() => workflow.create({ sessionId: 'owner', creationKey: 'large', requirement: 'simulate', parameters: {}, protocol: 'x'.repeat(256 * 1024 + 1) }), { code: 'INVALID_INPUT' })
})

test('publishes only a current analyzed revision and rejects another session', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  const published = []
  let complete
  const analyzer = { analyze: () => new Promise(resolve => { complete = resolve }) }
  const workflow = createWorkflow({ store, analyzer, preview: { async prepare(value) { published.push(value) } } })
  t.after(async () => { await workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const parameters = { source: 'A1', destinations: ['A1', 'A2'], volumeUl: 50 }
  const { experiment } = workflow.create({ sessionId: 'a', creationKey: 'request', requirement: 'transfer', parameters })
  assert.throws(() => workflow.get({ sessionId: 'b', id: experiment.id }), { code: 'SESSION_MISMATCH' })
  const revision = workflow.update({ sessionId: 'a', id: experiment.id, expectedRevision: 1, requirement: 'transfer', parameters })
  const result = workflow.analyze({ sessionId: 'a', id: experiment.id, revision: revision.revision })
  await assert.rejects(workflow.analyze({ sessionId: 'a', id: experiment.id, revision: revision.revision }), { code: 'CHECK_IN_PROGRESS' })
  complete(Buffer.from('{"commands":[]}'))
  assert.equal((await result).status, 'preview_ready')
  assert.equal(published[0].sessionId, 'a')
  assert.equal(store.getChecksForSession('a', experiment.id, 2)[0].status, 'passed')
  const late = workflow.analyze({ sessionId: 'a', id: experiment.id, revision: 2 })
  workflow.update({ sessionId: 'a', id: experiment.id, expectedRevision: 2, requirement: 'changed', parameters: { ...parameters, volumeUl: 100 } })
  complete(Buffer.from('{"commands":[]}'))
  await assert.rejects(late, { code: 'STALE_TASK' })
  assert.equal(published.length, 1)
})

test('a voice amendment blocks an older analysis before it can pass or publish a preview', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-voice-intent-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  let generation = 1, complete, published = 0
  const workflow = createWorkflow({ store,
    captureIntent: () => {
      const captured = generation
      return { assertCurrent() { if (captured !== generation) { const error = new Error('latest voice requirement changed'); error.code = 'VOICE_SUPERSEDED'; throw error } }, previewReady() {} }
    },
    analyzer: { analyze: () => new Promise(resolve => { complete = resolve }) },
    preview: { prepare: async () => { published++ } },
  })
  t.after(async () => { await workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const { experiment } = workflow.create({ sessionId: 's', creationKey: 'voice', requirement: 'three repeats', parameters: { source: 'A1', destinations: ['B1'], volumeUl: 50 } })
  const pending = workflow.analyze({ sessionId: 's', id: experiment.id, revision: 1 })
  generation++
  complete(Buffer.from('{"commands":[]}'))
  await assert.rejects(pending, { code: 'VOICE_SUPERSEDED' })
  assert.equal(published, 0)
  assert.equal(store.getChecks(experiment.id, 1).some(check => check.status === 'passed'), false)
})
