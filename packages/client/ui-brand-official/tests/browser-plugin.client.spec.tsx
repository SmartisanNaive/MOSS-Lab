// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { LabScriptBrandMark } from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'

afterEach(cleanup)

const holes = ['sidebar.brand.mark', 'conversation.hero.brand.mark'] as const

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(holes.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('LabScriptAI brand plugin', () => {
  it('keeps the host Loader entry inert and requires the slot service', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots'])
  })

  it('fills both brand slots before or after their declaration and removes them on disposal', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of holes) expect(before.slots.entries(hole)).toHaveLength(1)
    before.disposeHoles?.()
    for (const hole of holes) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of holes) expect(before.slots.entries(hole)).toHaveLength(1)
    await fiber.dispose()
    for (const hole of holes) expect(before.slots.entries(hole)).toHaveLength(0)
    await before.ctx.fiber.dispose()

    const after = await bench(false)
    const lateFiber = after.ctx.plugin({ inject: [...inject], apply })
    await lateFiber.await()
    for (const hole of holes) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of holes) expect(after.slots.entries(hole)).toHaveLength(1)
    await after.ctx.fiber.dispose()
  })

  it('renders the supplied mark at the requested size', () => {
    const mark = render(<LabScriptBrandMark size={34} />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('34')
    mark.rerender(<LabScriptBrandMark size={24} />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('24')
  })
})
