import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const log = await readFile(process.argv[2], 'utf8')
const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:3080\/\?token=\S+)/)?.[1]
if (!url) throw new Error('Local application URL missing')
const require = createRequire(resolve('apps/web/package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({ executablePath: '/Users/baice/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.waitForTimeout(3000)
    const newSession = page.getByRole('button', { name: /新建会话|New session/i }).first()
    if (await newSession.count()) await newSession.click()
    await page.getByText('Welcome to LabScriptAI').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(2000)
    const images = await page.locator('img[src*="labscriptai-logo"]').evaluateAll(nodes => nodes.map(node => ({ loaded: node.complete && node.naturalWidth > 0, width: node.clientWidth, src: new URL(node.src).pathname })))
    if (images.length < 2 || images.some(image => !image.loaded)) throw new Error(`${scheme}: brand images did not load: ${JSON.stringify(images)}`)
    if (await page.getByText('预览版', { exact: true }).count()) throw new Error(`${scheme}: obsolete preview badge remains`)
    await page.screenshot({ path: `${process.env.CLAUDE_JOB_DIR}/tmp/labscriptai-brand-${scheme}.png` })
    console.log(`${scheme}: welcome visible, ${images.length} brand images loaded, ${errors.length} page errors`)
    if (errors.length) throw new Error(errors.join('; '))
    await page.close()
  }
} finally { await browser.close() }
