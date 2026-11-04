import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../preview-plugin.mjs'

test('registers and disposes the authenticated carrier route', async () => {
  const ctx = new Context()
  let registered
  ctx.provide('experimentStore', { get() {}, getChecks() {} })
  ctx.provide('connection', { fetch: { register(route) { registered = route; return () => { registered = undefined } } } })
  const fiber = ctx.plugin(plugin, { flexRoot: '/unused', python: '/unused', temporaryRoot: '/unused', timeoutMs: 1000 })
  await fiber.await()
  try {
    assert.equal(registered.path, '/api/experiment-preview')
    assert.deepEqual(registered.methods, ['GET'])
    assert.deepEqual(await (await registered.fetch(new Request('http://localhost/api/experiment-preview?resource=status&session=session'))).json(), { status: 'waiting' })
    assert.ok(ctx.get('experimentPreview'))
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
  assert.equal(registered, undefined)
  assert.equal(ctx.get('experimentPreview'), undefined)
})
