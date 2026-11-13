/** Voice continuation and checked previews through the authenticated Web surface. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
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
async function experimentModule(name: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ new URL(`../../../internal/experiment/${name}`, import.meta.url).href)
}
async function voiceModule(name: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ new URL(`../../../internal/xiaozhi/${name}`, import.meta.url).href)
}

it('continues one experiment in the workbench, publishes the current checked preview, and opens a new experiment explicitly', async () => {
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
    const { handleMessage } = await voiceModule('bridge.mjs') as { handleMessage: (message: object, store: object, sessionId: null, delegation: object) => Promise<{ result: { content: [{ text: string }] } }> }
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
    const protocol = await readFile(new URL('../../../internal/experiment/example_transfer.py', import.meta.url), 'utf8')
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
    const callVoice = async (name: string, args: object) => {
      assert.ok(store)
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
      const reply = await handleMessage(request, store, null, { ...voice, voiceReceipt: feedback.receipt, voiceStatus: feedback.status })
      return JSON.parse(reply.result.content[0].text) as VoiceReply
    }
    disposers.push(registerWorkbench(connection, voice))
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
    const accepted = await callVoice('moss_delegate', { message: 'Start a Flex experiment' })
    expect(accepted.sessionId).toBe(first)
    expect(accepted).toMatchObject({ status: 'running', awaitingConfirmation: true, speech: { speak: true, text: 'What final volume per well?' } })
    const question = page.getByText('What final volume per well?', { exact: true })
    await expect.poll(() => question.count(), { timeout: 12000 }).toBe(1)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/voice-workbench/needs-input.expected.md', import.meta.url)), await question.ariaSnapshot(), webSnapshotMode())
    finishQuestion?.()
    expect((await callVoice('moss_task_status', { jobId: accepted.jobId })).speech.speak).toBe(false)
    expect((await callVoice('moss_delegate', { message: '50 microliters', newExperiment: true })).sessionId).toBe(first)
    await pending
    await expect.poll(() => page.locator('[data-experiment-revision="1"]').count(), { timeout: 15000 }).toBe(1)
    const animation = page.locator('iframe[title="Experiment animation"]')
    expect((await animation.getAttribute('srcdoc'))?.length).toBeGreaterThan(10)
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
})
