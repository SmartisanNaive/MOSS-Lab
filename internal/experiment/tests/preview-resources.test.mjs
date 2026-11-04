import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewResources } from '../preview-resources.mjs'

test('serves only a published preview whose latest check and revision still match', async t => {
  const root = await mkdtemp(join(tmpdir(), 'preview-resources-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'web/vendor'), { recursive: true })
  await writeFile(join(root, 'viewer.html'), '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><script type="module" src="/viewer.js"></script>')
  await writeFile(join(root, 'web/viewer.js'), 'import { OrbitControls } from "/vendor/OrbitControls.js"; let key = params.get("key"); fetch(`/flex3d/${key}/info`); fetch(`/flex3d/${key}/analysis.json`); fetch(`/flex3d/${key}/view.json`); new TextureLoader().load(`/flex3d/${key}/assets/${item.file}`);\n  select(0);\n}')
  await writeFile(join(root, 'view.json'), '{"frames":[]}')
  let revision = 1
  let checks = [{ name: 'protocol-analysis', status: 'passed', taskId: 'task', protocolHash: 'hash', result: { analysisSha256: 'digest' } }]
  const store = { get: () => ({ revision, snapshot: { sessionId: 'session' }, protocolHash: 'hash' }), getChecks: () => checks }
  const resources = new PreviewResources(store, root)
  const req = name => new Request(`http://localhost/api/experiment-preview?id=exp&revision=1&session=session&task=task&resource=${name}`)
  assert.deepEqual(await (await resources.fetch(req('status'))).json(), { status: 'waiting' })
  assert.equal((await resources.fetch(req('viewer'))).status, 404)
  resources.publish({ id: 'exp', revision: 1, sessionId: 'session', taskId: 'task', analysisSha256: 'digest', directory: root })
  resources.select('exp')
  assert.deepEqual(await (await resources.fetch(req('status'))).json(), { status: 'ready', id: 'exp', revision: 1, task: 'task' })
  assert.deepEqual(await (await resources.fetch(new Request('http://localhost/api/experiment-preview?resource=status&session=other'))).json(), { status: 'waiting' })
  assert.equal((await resources.fetch(new Request('http://localhost/api/experiment-preview?id=exp&revision=1&session=other&task=task&resource=view'))).status, 404)
  const html = await resources.fetch(req('viewer'))
  assert.equal(html.status, 200)
  assert.match(await html.text(), /resource=three/)
  const script = await (await resources.fetch(req('script'))).text()
  assert.match(script, /resource=orbit/)
  assert.match(script, /resource=analysis/)
  assert.doesNotMatch(script, /`\/flex3d\/\$\{key\}/)
  assert.equal((await resources.fetch(req('view'))).status, 200)
  assert.equal((await resources.fetch(new Request('http://localhost/api/experiment-preview?id=exp&revision=1&session=session&task=old&resource=view'))).status, 409)
  assert.equal((await resources.fetch(req('asset&file=..%2Fsecret.png'))).status, 400)
  checks = [...checks, { ...checks[0], status: 'running', taskId: 'new' }]
  assert.equal((await resources.fetch(req('view'))).status, 409)
  assert.deepEqual(await (await resources.fetch(req('status'))).json(), { status: 'waiting' })
  checks = checks.slice(0, 1)
  revision = 2
  assert.equal((await resources.fetch(req('viewer'))).status, 409)
})
