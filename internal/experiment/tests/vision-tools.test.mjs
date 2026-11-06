import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../vendor/cordis/src/index.ts'
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts'
import ToolsService from '../../../packages/core/tools/src/index.ts'
import * as plugin from '../vision-tools.mjs'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  const calls = []
  ctx.provide('experimentVision', {
    capture: async () => { calls.push({ method: 'capture' }); return { id: 'photo-1', imageUrl: '/api/robot-camera?id=photo-1' } },
    inspect: async input => { calls.push({ method: 'inspect', input }); return { photo: { id: 'photo-1' }, analysis: { summary: 'ok' } } },
  })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const tools = Object.fromEntries(ctx.tools.definitions().map(tool => [tool.name, tool]))
  return { ctx, fiber, tools, calls }
}

test('registers the deck-vision tools inside the preset and removes them on disposal', async () => {
  const { ctx, fiber, tools } = await setup()
  try {
    assert.deepEqual(Object.keys(tools).sort(), ['capture_deck_photo', 'inspect_deck'])
    await fiber.dispose()
    assert.deepEqual(ctx.tools.definitions(), [])
  } finally { await ctx.fiber.dispose() }
})

test('forwards captures and an optional photo id without extra arguments', async () => {
  const { ctx, tools, calls } = await setup()
  try {
    assert.deepEqual(await tools.capture_deck_photo.execute({}), { id: 'photo-1', imageUrl: '/api/robot-camera?id=photo-1' })
    await tools.inspect_deck.execute({})
    await tools.inspect_deck.execute({ photoId: 'photo-1' })
    assert.deepEqual(calls, [
      { method: 'capture' },
      { method: 'inspect', input: {} },
      { method: 'inspect', input: { photoId: 'photo-1' } },
    ])
  } finally { await ctx.fiber.dispose() }
})
