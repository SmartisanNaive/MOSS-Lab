import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import * as Persona from '@deepseek-ai/dsh-persona'
import { expect, it, onTestFinished } from 'vitest'
import { agentOn, harness } from './harness.ts'

it('mounts the robot tools only in the experiment assistant preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-experiment-'))
  const ctx = await harness()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(TokenMeter)
  const executions: string[] = []
  ctx.provide('robotControl', {
    allowLive: true,
    checkRunnable: () => {},
    status: async () => ({ status: 'ready' }),
    startRun: async () => { executions.push('start'); return { runId: 'run-1', status: 'started' } },
    getRun: async runId => ({ runId, status: 'running' }),
    getCommands: async () => [],
    controlRun: async () => ({ accepted: true }),
  })
  const patches = loadOverlayPatches('moss', fileURLToPath(new URL('../../../../moss-model.patch.yml', import.meta.url)))
  const rows = patches.flatMap(patch => patch.insert ?? [])
  expect(rows.filter(row => row.id === 'preset-moss-experiment')).toHaveLength(1)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    ...rows.filter(row => row.id === 'preset-moss-experiment'),
    { id: 'preset-standard', name: 'cordis:preset', config: { id: 'standard', plugins: [] } },
  ]))
  Object.assign(ctx.loader.builtins, { include: Include, preset: AgentPreset })
  const robotTools = await import('../../../../internal/experiment/robot-tools.mjs')
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-persona', Persona],
    ['./internal/experiment/robot-tools.mjs', robotTools],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompaction],
  ])
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
    async import(specifier) {
      const loaded = modules.get(specifier)
      if (loaded === undefined) throw new Error(`Unexpected plugin: ${specifier}`)
      return loaded
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect(await ctx.agentPresets.resolve('moss-experiment')).toEqual({ id: 'moss-experiment' })
  const experiment = await agentOn(ctx, 'moss-experiment-test', 'moss-experiment')
  const standard = await agentOn(ctx, 'standard-test')
  const experimentTools = (await ctx.systemPrompt.assemble({ scope: experiment })).tools.map(row => row.name)
  expect(experimentTools).toEqual(expect.arrayContaining(['get_robot_status', 'start_robot_run', 'get_robot_run', 'control_robot_run']))
  const standardTools = (await ctx.systemPrompt.assemble({ scope: standard })).tools.map(row => row.name)
  expect(standardTools).not.toContain('start_robot_run')
  expect(executions).toEqual([])
})
