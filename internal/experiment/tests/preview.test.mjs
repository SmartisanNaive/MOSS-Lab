import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ExperimentStore } from '../index.mjs'
import { buildPreview } from '../preview.mjs'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as previewPlugin from '../preview-plugin.mjs'

const project = resolve(import.meta.dirname, '../../..')
const lab = join(project, 'labscriptai-ot')
const analysis = Buffer.from(JSON.stringify({ robotType: 'OT-3 Standard', metadata: { protocolName: 'test analysis' }, commands: [{ id: 'home', commandType: 'home', params: {}, status: 'succeeded' }] }))
const digest = createHash('sha256').update(analysis).digest('hex')

test('scene generation requires the latest matching analysis for the current revision', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'experiment-preview-test-'))
  const store = new ExperimentStore({ path: join(dir, 'experiment.sqlite'), create: true })
  try {
    const { experiment } = store.create({ creationKey: 'preview-test', snapshot: { protocol: 'test protocol', sessionId: 'session' } })
    const input = { store, id: experiment.id, revision: experiment.revision, sessionId: 'session', analysis, python: join(lab, '.venv/bin/python'), flexRoot: join(lab, 'automation/flex3d'), temporaryRoot: dir, timeoutMs: 60000 }
    await assert.rejects(buildPreview(input), { code: 'PREVIEW_NOT_READY' })
    const task = store.startCheck({ id: experiment.id, revision: experiment.revision, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
    store.finishCheck({ ...task, status: 'passed', result: { analysisSha256: digest } })
    await assert.rejects(buildPreview({ ...input, analysis: Buffer.from('{}') }), { code: 'PREVIEW_NOT_READY' })
    const preview = await buildPreview(input)
    const scene = JSON.parse(await readFile(join(preview.directory, 'view.json'), 'utf8'))
    assert.ok(scene.frames.length > 0)
    assert.ok(scene.geoms.length > 0)
    const ctx = new Context()
    let route
    ctx.provide('experimentStore', store)
    ctx.provide('connection', { fetch: { register(value) { route = value; return () => {} } } })
    const fiber = ctx.plugin(previewPlugin, { python: input.python, flexRoot: input.flexRoot, temporaryRoot: dir, timeoutMs: 60000 })
    await fiber.await()
    try {
      await ctx.get('experimentPreview').prepare({ id: experiment.id, revision: 1, sessionId: 'session', analysis })
      const request = resource => new Request(`http://localhost/api/experiment-preview?resource=${resource}&id=${experiment.id}&revision=1&session=session&task=${task.taskId}`)
      assert.deepEqual(await (await route.fetch(request('status'))).json(), { status: 'ready', id: experiment.id, revision: 1, task: task.taskId })
      assert.ok((await (await route.fetch(request('view'))).json()).frames.length > 0)
      let guards = 0
      await assert.rejects(ctx.get('experimentPreview').prepare({ id: experiment.id, revision: 1, sessionId: 'session', analysis, assertCurrent() { if (++guards === 2) throw new Error('voice superseded during old-preview cleanup') } }), /voice superseded/)
      assert.equal(guards, 2)
      assert.notEqual((await route.fetch(request('view'))).status, 200)
      await ctx.get('experimentPreview').prepare({ id: experiment.id, revision: 1, sessionId: 'session', analysis, assertCurrent() {} })
      store.update({ id: experiment.id, expectedRevision: experiment.revision, snapshot: { protocol: 'changed protocol', sessionId: 'session' } })
      assert.equal((await route.fetch(request('view'))).status, 409)
      await assert.rejects(buildPreview(input), { code: 'STALE_TASK' })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
