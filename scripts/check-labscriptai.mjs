/** Exercise the exact pinned runtime through public MCP tools; never uses a model or robot. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '../vendor/cordis/src/index.ts'
import { LocalSandboxProvider } from '../packages/sandbox/sandbox-local/src/index.ts'
import { createPluginClient } from '../internal/experiment/plugin-client.mjs'
import { ensurePluginRuntime } from './labscriptai-runtime.mjs'

const runtime = await ensurePluginRuntime(process.cwd())
const ctx = new Context()
try {
  await ctx.plugin(LocalSandboxProvider, {}).await()
  const client = createPluginClient({ ...runtime, timeoutMs: 300000, sandbox: ctx.sandbox })
  const tools = new Set((await client.catalog()).map(tool => tool.name))
  for (const name of ['robot_status', 'capture_image', 'deck_vision_check', 'runtime_watch', 'safe_next_action']) {
    assert.ok(tools.has(name), `LabscriptAI did not publish ${name}`)
  }
  const protocol = await readFile(new URL('../internal/experiment/example_transfer.py', import.meta.url), 'utf8')
  const analysis = await client.analyze(protocol)
  const documents = await client.documents(analysis)
  assert.ok(documents.animation?.length > 1000, 'animation document unavailable')
  assert.ok(documents.setup?.length > 1000, 'setup document unavailable')
  assert.ok(documents.files.some(file => file.name === 'wells.csv'))
  const png = documents.files.find(file => file.name === 'setup.png')
  assert.ok(png, 'downloadable setup PNG unavailable')
  assert.equal(png.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'setup download is not a PNG')
  const setup = documents.files.find(file => file.name === 'setup.json')
  assert.ok(setup, 'setup data unavailable')
  const model = JSON.parse(setup.bytes.toString())
  const source = model.labware.find(labware => labware.slot === 'B3')
  assert.ok(source, 'source reservoir missing from setup')
  assert.equal(Object.values(source.initial.A1).reduce((total, volume) => total + volume, 0), 1000, 'setup must retain declared starting volume')
  assert.ok(model.labware.some(labware => labware.slot === 'C3'), 'destination plate missing from setup')
  const wells = documents.files.find(file => file.name === 'wells.csv').bytes.toString()
  assert.match(wells, /B3,[^\r\n]*,A1,[^\r\n]*1000/)
  assert.doesNotMatch(documents.setup.toString(), /<script>/)
  const ot2Protocol = await readFile(new URL('../internal/experiment/tests/example_ot2_transfer.py', import.meta.url), 'utf8')
  const ot2Analysis = await client.analyze(ot2Protocol)
  assert.equal(JSON.parse(ot2Analysis).robotType, 'OT-2 Standard')
  const ot2Documents = await client.documents(ot2Analysis)
  assert.ok(ot2Documents.animation?.length > 1000 && ot2Documents.setup?.length > 1000, 'OT-2 documents unavailable')
  const ot2Setup = ot2Documents.files.find(file => file.name === 'setup.json')
  assert.ok(ot2Setup, 'OT-2 setup data unavailable')
  const ot2Source = JSON.parse(ot2Setup.bytes.toString()).labware.find(labware => labware.slot === '3')
  assert.equal(Object.values(ot2Source.initial.A1).reduce((total, volume) => total + volume, 0), 100)
  console.log(JSON.stringify({ ok: true, ot2_animation_bytes: ot2Documents.animation.length, version: runtime.version, revision: runtime.revision, artifact_api: runtime.artifact_api,
    animation_bytes: documents.animation.length, setup_bytes: documents.setup.length }))
} finally {
  await ctx.fiber.dispose()
}
