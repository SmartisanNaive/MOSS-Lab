import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../../../vendor/cordis/src/index.ts'
import * as plugin from '../demo-plugin.mjs'
import * as analyzerPlugin from '../analyzer-plugin.mjs'
import { LocalSandboxProvider } from '../../../packages/sandbox/sandbox-local/src/index.ts'
import LocalSubprocessRuntime from '../../../packages/subprocess/subprocess-local/src/index.ts'

const lab = resolve(import.meta.dirname, '../../../labscriptai-ot')
test('publishes a labeled demo and removes its temporary data on disposal', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-plugin-test-'))
  const ctx = new Context()
  let route
  ctx.provide('connection', { fetch: { register(value) { route = value; return () => { route = undefined } } } })
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(LocalSubprocessRuntime)
  const config = { flexRoot: join(lab, 'automation/flex3d'), python: join(lab, '.venv/bin/python'), temporaryRoot: directory, timeoutMs: 60000 }
  const analyzer = ctx.plugin(analyzerPlugin, config)
  await analyzer.await()
  const fiber = ctx.plugin(plugin, config)
  try {
    await fiber.await()
    const status = await (await route.fetch(new Request('http://localhost/api/experiment-demo?resource=status'))).json()
    assert.equal(status.status, 'ready')
    const params = new URLSearchParams({ id: status.id, revision: String(status.revision), session: 'demo', task: status.task, resource: 'analysis' })
    const analysis = await (await route.fetch(new Request(`http://localhost/api/experiment-demo?${params}`))).json()
    assert.match(analysis.metadata.protocolName, /模拟示例/)
    assert.ok(analysis.commands.some(command => command.commandType === 'aspirate'))
    assert.ok(analysis.commands.some(command => command.commandType === 'dispense'))
    params.set('resource', 'viewer')
    assert.match(await (await route.fetch(new Request(`http://localhost/api/experiment-demo?${params}`))).text(), /\/api\/experiment-demo/)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
    assert.deepEqual(await readdir(directory), [])
    await rm(directory, { recursive: true, force: true })
  }
  assert.equal(route, undefined)
})
