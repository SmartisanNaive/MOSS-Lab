import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Commands from '@deepseek-ai/dsh-commands'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import * as CompactCommand from '@deepseek-ai/dsh-command-compact'
import * as Persona from '@deepseek-ai/dsh-persona'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { agentOn, harness } from './harness.ts'

it('loads the chat preset and blocks global, late and agent-local tools while preserving conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-chat-'))
  const ctx = await harness()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Commands)
  const adapter = new MockAdapter([
    toolCallResponse('injected', 'local_tool', {}), textResponse('Still here.'), textResponse('Again.'), textResponse('Summary of our conversation.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  let executions = 0
  const tool = (name: string) => defineTool({
    name, description: 'Test capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { executions++; return name },
  })
  await ctx.plugin({
    name: 'experiment-workflow-fixture',
    apply(child) {
      child.provide('experimentWorkflow', {
        create: async () => { executions++; return { id: 'experiment-1' } },
      })
    },
  })
  const experimentTools = await import('../../../../internal/experiment/agent-tools.mjs')
  await ctx.plugin(experimentTools)
  const patches = loadOverlayPatches('moss', fileURLToPath(new URL('../../../../moss-model.patch.yml', import.meta.url)))
  const rows = patches.flatMap(patch => patch.insert ?? []).filter(row => row.id === 'preset-chat')
  expect(rows).toHaveLength(1)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...rows, { id: 'preset-standard', name: 'cordis:preset', config: { id: 'standard', plugins: [] } }]))
  Object.assign(ctx.loader.builtins, { include: Include, preset: AgentPreset })
  const chatPlugin = await import('../../../../internal/chat-tools.mjs')
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-persona', Persona],
    ['./internal/chat-tools.mjs', chatPlugin],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompaction],
    ['@deepseek-ai/dsh-command-compact', CompactCommand],
  ])
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
    async import(specifier) {
      const plugin = modules.get(specifier)
      if (plugin === undefined) throw new Error(`Unexpected plugin: ${specifier}`)
      return plugin
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect(await ctx.agentPresets.resolve('chat')).toEqual({ id: 'chat' })
  const { agent: chat } = await ctx.agents.create({
    sessionId: SessionId('chat-test'), agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chat') },
  })
  const standard = await agentOn(ctx, 'standard-test')
  ctx.tools.register(tool('late_global'))
  chat.ctx.tools.register(tool('local_tool'))
  expect((await ctx.systemPrompt.assemble({ scope: chat })).tools).toEqual([])
  expect((await ctx.systemPrompt.assemble({ scope: standard })).tools.map(row => row.name)).toEqual(expect.arrayContaining(['create_experiment', 'late_global']))
  expect(ctx.agentPresets.inspectCompositions(chat.ctx)[0]?.modules).toEqual(expect.arrayContaining([
    expect.objectContaining({ moduleName: '@deepseek-ai/dsh-compaction-basic' }),
    expect.objectContaining({ moduleName: '@deepseek-ai/dsh-command-compact' }),
  ]))
  for (const name of ['create_experiment', 'late_global', 'local_tool']) {
    const result = await ctx.tools.execute({ agent: chat, calls: [{ type: 'tool-call', id: ToolCallId(name), name, arguments: '{}' }], signal: new AbortController().signal })
    expect(result.results[0]?.result.isError).toBe(true)
  }
  expect(executions).toBe(0)
  const allowed = await ctx.tools.execute({ agent: standard, calls: [{ type: 'tool-call', id: ToolCallId('standard'), name: 'create_experiment', arguments: JSON.stringify({ creationKey: 'key', requirement: 'test', parameters: { assumptions: 'test' }, protocol: 'test' }) }], signal: new AbortController().signal })
  expect(allowed.results[0]?.result).toMatchObject({ isError: false, value: { id: 'experiment-1' } })
  chat.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello '.repeat(2000) }], source: { kind: 'user' } }))
  await chat.whenIdle()
  chat.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello again' }], source: { kind: 'user' } }))
  await chat.whenIdle()
  expect(executions).toBe(1)
  expect(adapter.requests).toHaveLength(3)
  expect(adapter.requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
  expect(chat.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(3)
  const compact = await ctx.commands.execute(chat, '/compact', [], new AbortController().signal)
  expect(compact?.result).toMatchObject({ kind: 'success' })
  expect(chat.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
})
