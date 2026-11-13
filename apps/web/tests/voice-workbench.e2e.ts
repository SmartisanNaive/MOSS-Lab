/** Voice continuation and checked previews through the authenticated Web surface. */
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'

type AnalysisTools = {
  analyze(protocol: string): Promise<Buffer>
  documents(analysis: Buffer): Promise<{ animation: Buffer; setup: Buffer; files: { name: string; mime: string; bytes: Buffer }[] }>
}
type ExperimentStore = { close(): void }
type Workflow = {
  create(input: {
    sessionId: string
    creationKey: string
    requirement: string
    parameters: object
    protocol: string
  }): { experiment: { id: string } }
  update(input: {
    sessionId: string
    id: string
    expectedRevision: number
    requirement: string
    parameters: object
    protocol: string
  }): void
  analyze(input: { sessionId: string; id: string; revision: number }): Promise<unknown>
  close(): Promise<void>
}
type Voice = {
  captureIntent(id: string): { assertCurrent(): void }
  close(): void
}
type AskExperimentInput = (args: { question: string }, exec: { agent: { session: { id: string } } }) => Promise<unknown>
type VoiceFeedback = {
  receipt(id: string): object
  status(id: string, options: { userQuery: boolean; signal?: AbortSignal }): Promise<object>
  close(): void
}
type VoiceReply = {
  sessionId: string
  jobId: string
  status: string
  awaitingConfirmation: boolean
  speech: { speak: boolean; text: string }
}
type Bridge = (() => Promise<void>) & { snapshot(): { status: string } }
const comparison = process.env.MOSS_EXPERIENCE_COMPARE
const samples = Number(process.env.MOSS_EXPERIENCE_SAMPLES ?? '30')

async function reportExperience(kind: string, data: object) {
  const path = process.env.MOSS_EXPERIENCE_REPORT
  if (path) await appendFile(path, JSON.stringify({ kind, version: comparison, ...data }) + '\n')
}

async function openVoicePeer(connect: (options: object) => Bridge, store: object, delegation: object) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `ws://127.0.0.1:${address.port}`
  class LoopbackSocket extends WebSocket {
    constructor(_url: string, options: WebSocket.ClientOptions) { super(url, options) }
  }
  const connected = once(server, 'connection')
  const bridge = connect({ url: 'wss://test.invalid', sessionId: null, store, delegation, WebSocketClass: LoopbackSocket,
    reconnectMinMs: 60000, reconnectMaxMs: 60000 })
  const [socket] = await connected as [WebSocket]
  let id = 0
  async function request(method: string, params?: object) {
    const reply = once(socket, 'message')
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }))
    const [data] = await reply as [Buffer]
    return JSON.parse(data.toString()) as { result: { content: [{ text: string }] } }
  }
  await request('tools/list')
  return {
    snapshot: bridge.snapshot,
    async call(name: string, args: object) {
      const reply = await request('tools/call', { name, arguments: args })
      return JSON.parse(reply.result.content[0].text) as VoiceReply
    },
    async disconnect() { socket.terminate(); await expect.poll(() => bridge.snapshot().status).toBe('retrying') },
    async close() { await bridge(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

async function playable(page: Page, timeout: number) {
  const play = page.frameLocator('iframe[title="Experiment animation"]').locator('#play')
  await play.waitFor({ timeout })
  await play.click({ timeout: 1000 })
  await expect.poll(() => play.textContent({ timeout: 500 }), { timeout: 1000 }).toMatch(/暂停|Pause|⏸/)
}

async function measurePreview(browser: Browser, url: string, robot: string) {
  const results: { scenario: string; ms: number | null; setupRequests: number; retryMs: number | null }[] = []
  for (let index = -1; index < samples; index++) {
    for (const scenario of index % 2 === 0 ? ['normal', 'slow-setup', 'failed-setup'] : ['failed-setup', 'slow-setup', 'normal']) {
      const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      let started: number | undefined
      let setupRequests = 0
      let retryAllowed = false
      try {
        await page.route('**/api/experiment-preview?**', async (route) => {
          const resource = new URL(route.request().url()).searchParams.get('resource')
          if (resource === 'status' && started === undefined) started = performance.now()
          if (resource === 'setup') {
            setupRequests++
            if (scenario === 'slow-setup') await new Promise(resolve => setTimeout(resolve, 2200))
            if (scenario === 'failed-setup' && !retryAllowed) return route.fulfill({ status: 500, body: '' })
          }
          await route.continue()
        })
        await page.goto(url)
        let ms: number | null = null
        try { await playable(page, 5500); assert.ok(started !== undefined); ms = Math.round(performance.now() - started) } catch (error) {
          if (scenario !== 'failed-setup') await reportExperience('measurement-error', { robot, scenario, error: String(error) })
        }
        const automaticSetupRequests = setupRequests
        let retryMs: number | null = null
        if (scenario === 'failed-setup' && ms !== null) {
          await page.getByRole('button', { name: 'Setup image', exact: true }).click()
          const retry = page.getByRole('button', { name: 'Retry setup image' })
          await retry.waitFor({ timeout: 6000 })
          retryAllowed = true
          const startRetry = performance.now()
          await retry.click()
          await page.locator('iframe[title="Setup image"]').waitFor({ timeout: 6000 })
          retryMs = Math.round(performance.now() - startRetry)
        }
        if (index >= 0) results.push({ scenario, ms, setupRequests: automaticSetupRequests, retryMs })
      } finally { await page.close() }
    }
  }
  await reportExperience('preview', { robot, samples: results })
}
async function experimentModule(name: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ new URL(`../../../internal/experiment/${name}`, import.meta.url).href)
}
async function voiceModule(name: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ new URL(`../../../internal/xiaozhi/${name}`, import.meta.url).href)
}

const robots = comparison ? [process.env.MOSS_EXPERIENCE_ROBOT ?? 'Flex'] : ['Flex']
it.each(robots)('continues one %s experiment and publishes the current checked preview', async (robot) => {
  const scaffold = await launchWebScaffold()
  const temp = await mkdtemp(join(tmpdir(), 'moss-browser-'))
  const browser = await chromium.launch()
  let workflow: Workflow | undefined
  let store: ExperimentStore | undefined
  let voice: Voice | undefined
  const disposers: (() => void | Promise<void>)[] = []
  try {
    const { ExperimentStore } = await experimentModule('index.mjs') as { ExperimentStore: new (options: { path: string; create: boolean }) => ExperimentStore }
    const { createWorkflow } = await experimentModule('workflow.mjs') as { createWorkflow: (options: object) => Workflow }
    const { apply } = await experimentModule('preview-plugin.mjs') as { apply: (ctx: object, config: object) => void }
    const { apply: applyAgentTools } = await experimentModule('agent-tools.mjs') as { apply: (ctx: object) => void }
    const { createDelegation } = await voiceModule('delegation.mjs') as { createDelegation: (options: object) => Voice }
    const { createVoiceFeedback } = await voiceModule('voice-feedback.mjs') as { createVoiceFeedback: (options: object) => VoiceFeedback }
    const { connectBridge } = await voiceModule('bridge.mjs') as { connectBridge: (options: object) => Bridge }
    const { registerWorkbench } = await voiceModule('workbench-route.mjs') as { registerWorkbench: (connection: object, delegation: object) => () => Promise<void> }
    const saved = await readFile(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url), 'utf8')
    const first = await seedSession(scaffold, saved, 'voice-workbench-session')
    const second = await seedSession(scaffold, saved, 'voice-next-session')
    await scaffold.ctx.sessionController.rename({ sessionId: first, title: 'Voice experiment' })
    await scaffold.ctx.sessionController.rename({ sessionId: second, title: 'New voice experiment' })

    let runtime: AnalysisTools = {
      analyze: async () => Buffer.from('{"robotType":"OT-3 Standard","commands":[]}'),
      documents: async () => ({ animation: Buffer.from('<h1>animation</h1>'), setup: Buffer.from('<h1>setup</h1>'), files: [] }),
    }
    if (process.env.MOSS_TEST_REAL_OT === '1') {
      const { createPluginClient } = await experimentModule('plugin-client.mjs') as { createPluginClient: (config: object) => AnalysisTools }
      const loader = new URL('../../../scripts/labscriptai-runtime.mjs', import.meta.url).href
      const { ensurePluginRuntime } = await import(/* @vite-ignore */ loader) as { ensurePluginRuntime: (path: string) => Promise<object> }
      runtime = createPluginClient({ ...await ensurePluginRuntime(fileURLToPath(new URL('../../..', import.meta.url))), sandbox: scaffold.ctx.sandbox, timeoutMs: 300000 })
    }
    store = new ExperimentStore({ path: join(temp, 'experiments.sqlite'), create: true })
    const services = new Map<string, unknown>()
    let preview: unknown
    const connection = scaffold.ctx.connection
    apply({
      connection, experimentStore: store, labscriptaiRuntime: runtime,
      get: (key: string) => services.get(key),
      provide: (_key: string, service: unknown) => { preview = service },
      effect: (register: () => () => void | Promise<void>) => { disposers.push(register()) },
    }, { temporaryRoot: temp })

    const handlers = new Map<string, (first: object, second: object) => void>()
    let turns = 0
    let nextSession = 0
    let experiment: string | undefined
    let pending: Promise<unknown> = Promise.resolve()
    let finishQuestion: (() => void) | undefined
    let askExperimentInput: AskExperimentInput | undefined
    const protocolPath = robot === 'Flex' ? 'example_transfer.py' : 'tests/example_ot2_transfer.py'
    const protocol = await readFile(new URL(`../../../internal/experiment/${protocolPath}`, import.meta.url), 'utf8')
    voice = createDelegation({
      bindingPath: join(temp, 'voice.json'),
      workspaces: { list: () => [{ id: 'workspace' }] },
      events: { on: (key: string, listener: (first: object, second: object) => void) => {
        handlers.set(key, listener)
        return () => handlers.delete(key)
      } },
      controller: {
        create: async () => ({ sessionId: nextSession++ === 0 ? first : second }),
        rename: async () => {},
        prompt: async ({ sessionId, requestId }: { sessionId: string; requestId: string }) => {
          const turn = ++turns
          handlers.get('agent/inbox/claimed')?.({ agent: { id: sessionId }, message: { source: { rpcId: requestId } }, turn }, {})
          const finish = () => {
            handlers.get('session/event')?.({ id: sessionId }, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'Updated.' }] } } })
            handlers.get('session/event')?.({ id: sessionId }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
          }
          if (turn === 1) {
            assert.ok(askExperimentInput)
            await askExperimentInput({ question: 'What final volume per well?' }, { agent: { session: { id: sessionId } } })
            finishQuestion = finish
          } else if (turn === 2 || turn === 3) {
            const current = workflow
            assert.ok(current)
            if (!experiment) experiment = current.create({ sessionId, creationKey: 'example', requirement: 'water transfer', parameters: {}, protocol }).experiment.id
            else current.update({ sessionId, id: experiment, expectedRevision: 1, requirement: 'revised water transfer', parameters: {}, protocol: protocol.replaceAll('50,', '40,') })
            pending = current.analyze({ sessionId, id: experiment, revision: turn - 1 }).then(finish)
          } else finish()
        },
      },
    })
    services.set('mossVoiceIntent', voice)
    workflow = createWorkflow({ store, analyzer: runtime, preview, captureIntent: (id: string) => voice?.captureIntent(id) })
    services.set('experimentWorkflow', workflow)
    applyAgentTools({
      effect: () => {},
      get: (key: string) => services.get(key),
      tools: { register: (tool: { name: string; execute: AskExperimentInput }) => {
        if (tool.name === 'request_experiment_input') askExperimentInput = tool.execute
      } },
    })
    const feedback = createVoiceFeedback({ delegation: voice, offsetsMs: [0, 15000, 45000], pollWaitMs: 1000 })
    disposers.push(() => feedback.close())
    const peer = await openVoicePeer(connectBridge, store, { ...voice, voiceReceipt: feedback.receipt, voiceStatus: feedback.status })
    disposers.push(peer.close)
    const workbench = voice as Voice & { workbench: () => object }
    disposers.push(registerWorkbench(connection, {
      ...voice, workbench: () => ({ ...workbench.workbench(), connection: peer.snapshot() }),
    }))
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    await page.goto(scaffold.authenticatedUrl)
    const submit = async (message: string, newExperiment = false) => {
      const response = await scaffold.hostFetch('/api/xiaozhi-workbench/message', {
        method: 'POST', headers: { origin: new URL(scaffold.baseUrl).origin, 'content-type': 'application/json' },
        body: JSON.stringify({ message, newExperiment }),
      })
      expect(response.ok).toBe(true)
      return response.json() as Promise<{ sessionId: string }>
    }
    const voiceStarted = performance.now()
    const accepted = await peer.call('moss_delegate', { message: `Start a ${robot} experiment` })
    const receiptMs = Math.round(performance.now() - voiceStarted)
    expect(accepted.sessionId).toBe(first)
    expect(accepted).toMatchObject({ status: 'running', awaitingConfirmation: true, speech: { speak: true, text: 'What final volume per well?' } })
    const question = page.getByText('What final volume per well?', { exact: true })
    await expect.poll(() => question.count(), { timeout: 12000 }).toBe(1)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/voice-workbench/needs-input.expected.md', import.meta.url)), await question.ariaSnapshot(), webSnapshotMode())
    finishQuestion?.()
    expect((await peer.call('moss_task_status', { jobId: accepted.jobId })).speech.speak).toBe(false)
    if (comparison) {
      await peer.disconnect()
      const disconnected = performance.now()
      const resume = page.getByRole('button', { name: 'Continue on web', exact: true })
      let recoveryMs: number | null = null
      try {
        await resume.waitFor({ timeout: 3800 })
        await resume.click()
        recoveryMs = Math.round(performance.now() - disconnected)
      } catch (error) {
        if (comparison !== 'baseline') throw error
      }
      await reportExperience('voice', { robot, receiptMs, recoveryMs })
      if (recoveryMs === null) expect((await submit('50 microliters')).sessionId).toBe(first)
      else {
        await page.getByRole('textbox', { name: 'Reply to Xiaozhi experiment' }).fill('50 microliters')
        await page.getByRole('button', { name: 'Send experiment reply' }).click()
        await expect.poll(() => turns).toBe(2)
      }
    } else {
      expect((await peer.call('moss_delegate', { message: '50 microliters', newExperiment: true })).sessionId).toBe(first)
    }
    await pending
    await page.locator('[data-experiment-revision="1"]').waitFor({ timeout: 15000 })
    const animation = page.locator('iframe[title="Experiment animation"]')
    expect((await animation.getAttribute('srcdoc'))?.length).toBeGreaterThan(10)
    if (comparison) {
      await page.close()
      await measurePreview(browser, scaffold.authenticatedUrl, robot)
      return
    }
    await page.getByRole('button', { name: 'Setup image', exact: true }).click()
    await expect.poll(() => page.locator('iframe[title="Setup image"]').count()).toBe(1)
    expect((await submit('Change it to 40 microliters')).sessionId).toBe(first)
    await pending
    await expect.poll(() => page.locator('[data-experiment-revision="2"]').count(), { timeout: 15000 }).toBe(1)
    expect((await submit('Start another experiment', true)).sessionId).toBe(second)
    expect(nextSession).toBe(2)
  } finally {
    await browser.close()
    await workflow?.close()
    voice?.close()
    for (const dispose of disposers.reverse()) await dispose()
    store?.close()
    await scaffold.close()
    await rm(temp, { recursive: true, force: true })
  }
}, comparison ? 600_000 : undefined)
