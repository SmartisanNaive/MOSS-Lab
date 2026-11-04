import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../../../vendor/cordis/src/index.ts'
import { ExperimentStore } from '../index.mjs'
import { createWorkflow } from '../workflow.mjs'
import { createDelegation } from '../../xiaozhi/delegation.mjs'
import * as previewPlugin from '../preview-plugin.mjs'
import * as analyzerPlugin from '../analyzer-plugin.mjs'
import { LocalSandboxProvider } from '../../../packages/sandbox/sandbox-local/src/index.ts'
import LocalSubprocessRuntime from '../../../packages/subprocess/subprocess-local/src/index.ts'

const lab = resolve(import.meta.dirname, '../../../labscriptai-ot')
test('real analysis publishes its owned preview and suppresses a late focus acknowledgement', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-integration-'))
  const store = new ExperimentStore({ path: join(dir, 'store.sqlite'), create: true })
  const ctx = new Context()
  let route
  ctx.provide('experimentStore', store)
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => {} } } })
  const config = { flexRoot: join(lab, 'automation/flex3d'), python: join(lab, '.venv/bin/python'), temporaryRoot: dir, timeoutMs: 60000 }
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(LocalSubprocessRuntime)
  const preview = ctx.plugin(previewPlugin, config)
  const analyzer = ctx.plugin(analyzerPlugin, config)
  await Promise.all([preview.await(), analyzer.await()])
  let request, supersedeOnPublish = false
  const delegation = createDelegation({ sessionId: 's1', events: ctx, workspaces: { list: () => [] },
    controller: { async prompt(input) { request = input } } })
  const workflow = createWorkflow({ store, analyzer: ctx.get('protocolAnalyzer'),
    captureIntent: id => delegation.captureIntent(id),
    preview: { async prepare(input) {
      const result = await ctx.get('experimentPreview').prepare(input)
      if (supersedeOnPublish) await delegation.submit('new voice requirement')
      return result
    } } })
  try {
    const receipt = await delegation.submit('finished voice request')
    await ctx.emit('agent/inbox/claimed', { agent: { id: 's1' }, message: { source: { rpcId: request.requestId } }, turn: 1 })
    await ctx.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } })
    await ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const oldReceipt = delegation.get(receipt.jobId)
    assert.equal(oldReceipt.status, 'completed')
    const original = await readFile(new URL('../example_transfer.py', import.meta.url), 'utf8')
    const invalid = original.replace('opentrons_flex_96_tiprack_1000ul', 'nonexistent_flex_tiprack')
    assert.notEqual(invalid, original)
    await assert.rejects(ctx.get('protocolAnalyzer').analyze(invalid), /nonexistent_flex_tiprack/)
    const protocol = original.replace('模拟示例', '自定义模拟协议')
    const { experiment } = workflow.create({ sessionId: 's1', creationKey: 'one', requirement: 'local simulation', parameters: { assumptions: 'sample setup' }, protocol })
    const result = await workflow.analyze({ sessionId: 's1', id: experiment.id, revision: 1 })
    assert.equal(result.status, 'preview_ready')
    const status = await (await route.fetch(new Request('http://localhost/api/experiment-preview?resource=status&session=s1'))).json()
    assert.equal(status.id, experiment.id)
    const other = await (await route.fetch(new Request('http://localhost/api/experiment-preview?resource=status&session=s2'))).json()
    assert.equal(other.status, 'waiting')
    assert.equal(delegation.workbench().jobId, null)
    assert.deepEqual(delegation.workbench().preview, { id: experiment.id, revision: 1 })
    assert.deepEqual(delegation.get(receipt.jobId), oldReceipt)
    const focus = delegation.workbench().focusSequence
    supersedeOnPublish = true
    assert.equal((await workflow.analyze({ sessionId: 's1', id: experiment.id, revision: 1 })).status, 'preview_ready')
    assert.equal(delegation.workbench().status, 'running')
    assert.equal(delegation.workbench().preview, null)
    assert.equal(delegation.workbench().focusSequence, focus)

  } finally {
    await workflow.close()
    delegation.close()
    await analyzer.dispose()
    await preview.dispose()
    await ctx.fiber.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
