import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { ExperimentStore } from '../index.mjs'
import { buildPreview } from '../preview.mjs'
import { PreviewResources } from '../preview-resources.mjs'
import { createPreviewDocument } from '../../../packages/client/ui-sidebar-experiment/src/client/document.ts'

const project = resolve(import.meta.dirname, '../../..')
const lab = join(project, 'labscriptai-ot')
const require = createRequire(resolve('apps/web/package.json'))
const { chromium } = require('playwright')
const executablePath = process.env.MOSS_CHROMIUM

// This isolated fixture is not published to the application's experiment store.
test('renders a generated Flex scene in the sandboxed player', { timeout: 90000, skip: !executablePath }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'experiment-browser-test-'))
  const store = new ExperimentStore({ path: join(dir, 'experiment.sqlite'), create: true })
  let browser
  try {
    const analysis = Buffer.from(JSON.stringify({ robotType: 'OT-3 Standard', metadata: { protocolName: 'test analysis' }, commands: [{ id: 'home', commandType: 'home', params: {}, status: 'succeeded' }] }))
    const { experiment } = store.create({ creationKey: 'test', snapshot: { protocol: 'test protocol', sessionId: 'test-session' } })
    const task = store.startCheck({ id: experiment.id, revision: 1, protocolHash: experiment.protocolHash, name: 'protocol-analysis' })
    store.finishCheck({ ...task, status: 'passed', result: { analysisSha256: createHash('sha256').update(analysis).digest('hex') } })
    const preview = await buildPreview({ store, id: experiment.id, revision: 1, sessionId: 'test-session', analysis, python: join(lab, '.venv/bin/python'), flexRoot: join(lab, 'automation/flex3d'), temporaryRoot: dir, timeoutMs: 60000 })
    const resources = new PreviewResources(store, join(lab, 'automation/flex3d'))
    resources.publish(preview)
    resources.select(experiment.id)
    const get = async (resource, file) => {
      const query = new URLSearchParams({ id: experiment.id, revision: '1', session: 'test-session', task: task.taskId, resource })
      if (file) query.set('file', file)
      const response = await resources.fetch(new Request(`http://localhost/api/experiment-preview?${query}`))
      assert.equal(response.status, 200, resource)
      return new Uint8Array(await response.arrayBuffer())
    }
    const bundle = {}
    for (const name of ['viewer', 'script', 'orbit', 'three', 'info', 'analysis', 'view']) bundle[name] = await get(name)
    bundle.assets = {}
    const scene = JSON.parse(new TextDecoder().decode(bundle.view))
    for (const texture of scene.textures) bundle.assets[texture.file] = await get('asset', texture.file)
    const document = createPreviewDocument(bundle, 'test-session', experiment.id, 1, task.taskId)
    browser = await chromium.launch({ executablePath })
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.setContent('<iframe sandbox="allow-scripts" style="width:360px;height:650px"></iframe>')
    await page.locator('iframe').evaluate((element, value) => { element.srcdoc = value }, document)
    const frame = page.frameLocator('iframe')
    await frame.locator('canvas').waitFor({ timeout: 30000 })
    assert.ok(await frame.locator('#steps li').count() > 0)
    assert.equal(await frame.locator('#lang').count(), 0)
    assert.equal(await frame.locator('#help').count(), 0)
    assert.equal(await frame.locator('canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0), true)
    const play = frame.locator('#play')
    await play.waitFor()
    await frame.locator('#steps li').first().waitFor()
    await frame.locator('#play').filter({ hasText: /Pause|暂停/ }).waitFor({ timeout: 10000 })
    await play.click()
    const afterFirstClick = await play.textContent()
    await play.click()
    assert.notEqual(await play.textContent(), afterFirstClick)
    const time = frame.locator('#time')
    await time.evaluate(element => { element.value = element.max; element.dispatchEvent(new Event('input', { bubbles: true })) })
    assert.equal(await time.inputValue(), await time.getAttribute('max'))
    if (process.env.MOSS_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.MOSS_PREVIEW_SCREENSHOT })
    assert.deepEqual(errors, [])
  } finally {
    if (browser) await browser.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
