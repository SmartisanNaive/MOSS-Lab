import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { boundedResponse, ensurePluginRuntime, extractPlugin, validateLock } from '../../../scripts/labscriptai-runtime.mjs'
import { findPluginUpdate } from '../../../scripts/update-labscriptai.mjs'
import { readPluginDocuments, readPluginFile } from '../plugin-client.mjs'

const revision = 'a'.repeat(40)
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const lock = sha256 => ({ schema: 1, artifact_api: 1, version: '0.1.3', kind: 'source', revision,
  url: `https://codeload.github.com/KRATSZ/labscriptai-ot/zip/${revision}`, sha256 })

test('pinned installation verifies checksums, installs once, and retains existing versions on failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const archive = Buffer.from(zipSync({
    'plugin/.codex-plugin/plugin.json': strToU8('{"version":"0.1.3"}'),
    'plugin/servers/opentrons-mcp/index.js': strToU8('// fixture'),
  }))
  const pinned = lock(checksum(archive))
  await writeFile(join(directory, 'labscriptai-ot.lock.json'), JSON.stringify(pinned))
  let downloads = 0
  let installs = 0
  const options = { override: undefined, fetcher: async () => { downloads++; return new Response(archive) }, installer: async () => { installs++ } }
  const runtime = await ensurePluginRuntime(directory, options)
  assert.equal(runtime.revision, revision)
  assert.equal(await readFile(join(runtime.root, 'servers/opentrons-mcp/index.js'), 'utf8'), '// fixture')
  await ensurePluginRuntime(directory, options)
  assert.equal(downloads, 1)
  assert.equal(installs, 2) // The plugin installer owns dependency-health reuse.
  await writeFile(join(directory, 'labscriptai-ot.lock.json'), JSON.stringify(lock('b'.repeat(64))))
  await assert.rejects(ensurePluginRuntime(directory, options), /checksum mismatch/)
  assert.equal(await readFile(join(runtime.root, 'servers/opentrons-mcp/index.js'), 'utf8'), '// fixture')
  await writeFile(join(directory, 'labscriptai-ot.lock.json'), JSON.stringify(pinned))
  const rollback = await ensurePluginRuntime(directory, { ...options, fetcher: async () => assert.fail('old archive must remain cached') })
  assert.equal(rollback.root, runtime.root)
  assert.ok(!(await readdir(join(directory, '.dsh-local/plugins'))).some(name => name.startsWith('install-')))
})

test('packaged runtime keeps program dependencies outside experiment snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-storage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const archive = zipSync({ 'plugin/.codex-plugin/plugin.json': strToU8(JSON.stringify({ version: '0.1.3' })), 'plugin/servers/opentrons-mcp/index.js': strToU8('// fixture') })
  await writeFile(join(directory, 'labscriptai-ot.lock.json'), JSON.stringify(lock(checksum(archive))))
  const cacheHome = join(directory, 'home/runtime-cache')
  const runtime = await ensurePluginRuntime(directory, { dataHome: join(directory, 'home'), cacheHome, override: undefined,
    fetcher: async () => new Response(archive), installer: async (_root, dependencies) => assert.equal(dependencies, join(cacheHome, 'dependencies')) })
  assert.ok(runtime.root.startsWith(await realpath(cacheHome)))
  assert.ok(runtime.data.startsWith(await realpath(cacheHome)))
  await assert.rejects(readdir(join(directory, 'home/.dsh-local')), { code: 'ENOENT' })
})

test('archive extraction rejects traversal and mixed roots before publishing an install', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-archive-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [index, files] of [{ 'root/../escape': strToU8('bad') }, { 'one/a': strToU8('a'), 'two/b': strToU8('b') }].entries()) {
    const archive = join(directory, `${index}.zip`)
    const target = join(directory, String(index))
    await mkdir(target)
    await writeFile(archive, zipSync(files))
    await assert.rejects(extractPlugin(archive, target), /Unsafe|invalid relative path/)
    assert.deepEqual(await readdir(target), [])
  }
})

test('lock and downloaded bodies fail closed for unsupported APIs, hosts, and unbounded responses', async () => {
  assert.throws(() => validateLock({ ...lock('a'.repeat(64)), artifact_api: 2 }), /Invalid/)
  assert.throws(() => validateLock({ ...lock('a'.repeat(64)), url: 'https://example.test/plugin.zip' }), /Untrusted/)
  await assert.rejects(boundedResponse(new Response(new Uint8Array(11)), 10), /size limit/)
})

test('artifact reads reject paths outside the invocation and oversized output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-artifacts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const invocation = join(directory, 'invocation')
  await mkdir(invocation)
  await writeFile(join(directory, 'outside.html'), 'outside')
  await writeFile(join(invocation, 'setup.html'), '<html>setup</html>')
  await assert.rejects(readPluginFile(invocation, join(directory, 'outside.html'), 1024), { code: 'PLUGIN_RESPONSE_INVALID' })
  await assert.rejects(readPluginFile(invocation, join(invocation, 'setup.html'), 4), { code: 'PLUGIN_RESPONSE_INVALID' })
  assert.match((await readPluginFile(invocation, join(invocation, 'setup.html'), 1024)).toString(), /setup/)
})

const release = version => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: ['release-manifest.json', `labscriptai-ot-${version}.zip`].map(name => ({ name,
  browser_download_url: `https://github.com/KRATSZ/labscriptai-ot/releases/download/v${version}/${name}` })) })
const provider = (info, artifactApi = 1) => async url => Response.json(url.includes('api.github.com') ? info : { version: info.tag_name.slice(1), artifact_api: artifactApi,
  assets: [{ name: `labscriptai-ot-${info.tag_name.slice(1)}.zip`, sha256: 'c'.repeat(64) }] })

test('updates promote a source pin to its published release, without downgrades or incompatible APIs', async () => {
  const current = lock('a'.repeat(64))
  const promoted = await findPluginUpdate(current, provider(release('0.1.3')))
  assert.equal(promoted.status, 'updated')
  assert.equal(promoted.lock.kind, 'release')
  assert.equal(promoted.lock.sha256, 'c'.repeat(64))
  assert.equal((await findPluginUpdate(current, provider(release('0.1.2')))).status, 'current')
  assert.deepEqual(await findPluginUpdate(current, provider(release('0.2.0'), 2)), {
    status: 'unsupported_api', version: '0.2.0', artifact_api: 2, expected_artifact_api: 1,
  })
  assert.equal((await findPluginUpdate(current, provider({ ...release('0.2.0'), prerelease: true }))).status, 'current')
  const broken = release('0.1.4')
  broken.assets[0].browser_download_url = 'https://example.test/manifest.json'
  await assert.rejects(findPluginUpdate(current, provider(broken)), /trusted checksum manifest/)
})

test('artifact manifests reject incompatible APIs, mixed analyses and tampered bytes while preserving partial availability', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-manifest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('<html>animation</html>')
  const path = join(directory, 'animation.html')
  await writeFile(path, bytes)
  const value = { ok: true, artifact_api: 1, plugin_version: '0.1.3', analysis_sha256: 'analysis', attachments: [], documents: {
    animation: { status: 'ready', path, mime: 'text/html', bytes: bytes.length, sha256: checksum(bytes) }, setup: { status: 'unavailable', message: 'figure failed' },
  } }
  const checked = await readPluginDocuments(value, 'analysis', '0.1.3', directory)
  assert.deepEqual(checked.animation, bytes)
  assert.equal(checked.setup, null)
  for (const changes of [{ artifact_api: 2 }, { plugin_version: '0.1.4' }, { analysis_sha256: 'other' }]) {
    await assert.rejects(readPluginDocuments({ ...value, ...changes }, 'analysis', '0.1.3', directory), { code: 'PLUGIN_RESPONSE_INVALID' })
  }
  await writeFile(path, '<html>modified</html>')
  await assert.rejects(readPluginDocuments(value, 'analysis', '0.1.3', directory), { code: 'PLUGIN_RESPONSE_INVALID' })
})
