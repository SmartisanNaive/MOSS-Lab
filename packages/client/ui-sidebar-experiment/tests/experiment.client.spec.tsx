// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '../../ui-sidebar-right/src/client/tab-registry.ts'
import { describe, expect, it, vi } from 'vitest'
import { ExperimentBody } from '../src/client/Experiment.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { robotStatusProvider, statusProvider, watchProvider } from '../src/client/status.ts'
import { AutoOpenExperiment, createAutoOpenStore } from '../src/client/auto-open.tsx'
import type { ExperimentStatus } from '../src/client/status.ts'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

describe('experiment animation entry', () => {
  it('opens each ready preview once in its visible session', () => {
    const store = createAutoOpenStore().create()
    const openExperiment = vi.fn(() => true)
    let visible = 'other'
    let task = 'first'
    const props = {
      sessionId: 'session',
      useResource: () => ({ status: 'live', value: { status: 'ready', id: 'experiment', revision: 1, task } }),
      useSidebarMounted: (select: (value: string) => boolean) => select(visible),
      useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) => select(store.getSnapshot()),
      actions: store.actions, openExperiment,
    } as unknown as Parameters<typeof AutoOpenExperiment>[0]
    const view = render(<AutoOpenExperiment {...props} />)
    expect(openExperiment).not.toHaveBeenCalled()
    visible = 'session'
    view.rerender(<AutoOpenExperiment {...props} />)
    expect(openExperiment).toHaveBeenCalledTimes(1)
    view.rerender(<AutoOpenExperiment {...props} />)
    expect(openExperiment).toHaveBeenCalledTimes(1)
    task = 'second'
    view.rerender(<AutoOpenExperiment {...props} />)
    expect(openExperiment).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('queries robot status only after the user asks and displays returned details', () => {
    const addresses: string[] = []
    const useResource = ((address: string) => {
      addresses.push(address)
      if (address === 'dsh-resource://robotstatus/1') return { status: 'live', value: { status: 'ready', queriedAt: '2026-11-01T11:00:00Z', health: { status: 'ok', robotModel: 'Flex' }, instruments: [{ mount: 'left', name: 'P1000' }] }, failure: undefined }
      return { status: 'live', value: { status: 'waiting' }, failure: undefined }
    }) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key in zh ? zh[key as keyof typeof zh] : key} />)
    expect(screen.queryByText(/Flex/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.robotQuery }))
    expect(addresses).toContain('dsh-resource://robotstatus/1')
    expect(screen.getByText(/Flex/)).toBeTruthy()
    expect(screen.getByText(/P1000/)).toBeTruthy()
    view.unmount()
  })

  it('requests robot status once and rejects malformed results', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'ready', queriedAt: '2026-11-01T11:00:00Z', health: { status: 'ok', robotModel: 'Flex' }, instruments: [] }))
    const controller = new AbortController()
    try {
      const idle = robotStatusProvider.open('dsh-resource://robotstatus/0', { signal: controller.signal })[Symbol.asyncIterator]()
      expect((await idle.next()).done).toBe(true)
      expect(request).not.toHaveBeenCalled()
      const query = robotStatusProvider.open('dsh-resource://robotstatus/1', { signal: controller.signal })[Symbol.asyncIterator]()
      expect((await query.next()).value).toMatchObject({ ok: true, value: { status: 'ready', instruments: [] } })
      expect(request).toHaveBeenCalledWith('/api/robot-status', expect.objectContaining({ credentials: 'same-origin' }))
      request.mockResolvedValueOnce(Response.json({ status: 'ready' }))
      const invalid = robotStatusProvider.open('dsh-resource://robotstatus/2', { signal: controller.signal })[Symbol.asyncIterator]()
      expect((await invalid.next()).value?.ok).toBe(false)
    } finally {
      controller.abort()
      request.mockRestore()
    }
  })

  it('watches only the current session status', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'ready', id: 'x', revision: 1, task: 't' }))
    const controller = new AbortController()
    const iterator = watchProvider.open('dsh-resource://experimentwatch/session%20one', { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toEqual({ ok: true, value: { status: 'ready', id: 'x', revision: 1, task: 't' } })
      expect(request).toHaveBeenCalledWith('/api/experiment-preview?resource=status&session=session+one', expect.objectContaining({ credentials: 'same-origin' }))
    } finally {
      controller.abort()
      await iterator.return?.()
      request.mockRestore()
    }
  })
  it('relays a server checking status while a persisted preview is rebuilt', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ status: 'checking' }))
      .mockResolvedValueOnce(Response.json({ status: 'ready', id: 'x', revision: 1, task: 't' }))
    const controller = new AbortController()
    const iterator = watchProvider.open('dsh-resource://experimentwatch/session', { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toEqual({ ok: true, value: { status: 'checking' } })
      const next = iterator.next()
      await vi.advanceTimersByTimeAsync(1000)
      expect((await next).value).toEqual({ ok: true, value: { status: 'ready', id: 'x', revision: 1, task: 't' } })
    } finally {
      controller.abort()
      await iterator.return?.()
      request.mockRestore()
      vi.useRealTimers()
    }
  })
  it('shows waiting and requests a fresh resource when refreshed', () => {
    const addresses: string[] = []
    const useResource = ((address: string) => {
      addresses.push(address)
      return { status: 'live', value: { status: 'waiting' }, failure: undefined }
    }) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'test-tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key === 'waiting' ? zh.waiting : key} />)
    expect(screen.getByRole('status').textContent).toBe(zh.waiting)
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
    expect(addresses.filter(address => address.startsWith('dsh-resource://experimentstatus/'))).toEqual(['dsh-resource://experimentstatus/session/test-tab/0', 'dsh-resource://experimentstatus/session/test-tab/1'])
    expect(view.container.querySelector('iframe')).toBeNull()
    view.unmount()
  })

  it.each([
    [undefined, 'failed', 'error', 'alert'],
  ] as const)('reports available or failed status without an iframe', (value, status, message, role) => {
    const useResource = (() => ({ status, value, failure: undefined })) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key} />)
    expect(screen.getByRole(role).textContent).toBe(message)
    expect(view.container.querySelector('iframe')).toBeNull()
    view.unmount()
  })

  it('switches between demo and real status with a persistent demo warning', () => {
    const addresses: string[] = []
    const useResource = ((address: string) => {
      addresses.push(address)
      if (address.startsWith('dsh-resource://experimentwatch/')) return { status: 'live', value: { status: 'waiting' }, failure: undefined }
      return address.includes('mode=demo')
        ? { status: 'live', value: { status: 'ready', id: 'demo', revision: 1, task: 'task', document: '<p>demo</p>' }, failure: undefined }
        : { status: 'live', value: { status: 'waiting' }, failure: undefined }
    }) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key in zh ? zh[key as keyof typeof zh] : key} />)
    fireEvent.click(screen.getByRole('button', { name: zh.viewDemo }))
    expect(screen.getByText(zh.demoLabel)).toBeTruthy()
    expect(screen.getByText(zh.demoControls)).toBeTruthy()
    expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toBe('<p>demo</p>')
    expect(addresses.filter(address => address.startsWith('dsh-resource://experimentstatus/')).at(-1)).toContain('?mode=demo')
    fireEvent.click(screen.getByRole('button', { name: zh.returnToExperiment }))
    expect(screen.getByRole('status').textContent).toBe(zh.waiting)
    expect(screen.queryByText(zh.demoLabel)).toBeNull()
    expect(addresses.at(-1)).not.toContain('mode=demo')
    view.unmount()
  })

  it('returns from demo when a new experiment preview becomes ready', () => {
    let task: string | undefined = 'old-task'
    const useResource = ((address: string) => {
      if (address.startsWith('dsh-resource://experimentwatch/')) return { status: 'live', value: task ? { status: 'ready', id: 'x', revision: 1, task } : { status: 'waiting' }, failure: undefined }
      return address.includes('mode=demo')
        ? { status: 'live', value: { status: 'ready', id: 'demo', revision: 1, task: 'demo', document: '<p>demo</p>' }, failure: undefined }
        : { status: 'live', value: { status: 'waiting' }, failure: undefined }
    }) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key in zh ? zh[key as keyof typeof zh] : key} />)
    fireEvent.click(screen.getByRole('button', { name: zh.viewDemo }))
    expect(screen.getByText(zh.demoLabel)).toBeTruthy()
    task = undefined
    view.rerender(<ExperimentBody {...props} t={key => key in zh ? zh[key as keyof typeof zh] : key} />)
    expect(screen.getByText(zh.demoLabel)).toBeTruthy()
    task = 'new-task'
    view.rerender(<ExperimentBody {...props} t={key => key in zh ? zh[key as keyof typeof zh] : key} />)
    expect(screen.queryByText(zh.demoLabel)).toBeNull()
    view.unmount()
  })

  it('renders an opaque sandbox when resources are ready', () => {
    const useResource = (() => ({ status: 'live', value: { status: 'ready', id: 'x', revision: 2, task: 't', document: '<p>viewer</p>' }, failure: undefined })) as UseResource
    const props = { sessionId: 'session', useTabInfo: () => ({ tab: { id: 'tab' } }), useResource } as PropsRuntime<'sidebar.right.pane.tab'>
    const view = render(<ExperimentBody {...props} t={key => key} />)
    const frame = view.container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe('<p>viewer</p>')
    view.unmount()
  })

  it('checks again after one second and reports a disconnect', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ status: 'waiting' }))
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new AbortController()
    const iterator = statusProvider.open('dsh-resource://experimentstatus/session', { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toEqual({ ok: true, value: { status: 'waiting' } })
      const next = iterator.next()
      await vi.advanceTimersByTimeAsync(1000)
      expect((await next).value?.ok).toBe(false)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      controller.abort()
      await iterator.return?.()
      request.mockRestore()
      vi.useRealTimers()
    }
  })

  it('clears the old viewer when its checked task changes', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ status: 'waiting' }))
      .mockResolvedValueOnce(Response.json({ status: 'ready', id: 'x', revision: 2, task: 'next' }))
    const controller = new AbortController()
    const iterator = statusProvider.open('dsh-resource://experimentstatus/session', { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      await iterator.next()
      const next = iterator.next()
      await vi.advanceTimersByTimeAsync(1000)
      expect((await next).value).toEqual({ ok: true, value: { status: 'checking' } })
    } finally {
      controller.abort()
      await iterator.return?.()
      request.mockRestore()
      vi.useRealTimers()
    }
  })

  it('requests demo status without the real session', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'waiting' }))
    const controller = new AbortController()
    const iterator = statusProvider.open('dsh-resource://experimentstatus/real-session/tab/0?mode=demo', { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toEqual({ ok: true, value: { status: 'waiting' } })
      expect(request).toHaveBeenCalledWith('/api/experiment-demo?resource=status', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    } finally {
      controller.abort()
      await iterator.return?.()
      request.mockRestore()
    }
  })

  it('reports HTTP failures', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    const frames = []
    const controller = new AbortController()
    for await (const frame of statusProvider.open('dsh-resource://experimentstatus/test', { signal: controller.signal })) { frames.push(frame); controller.abort() }
    expect(frames[0]?.ok).toBe(false)
    request.mockRestore()
  })

  it.each([
    [{ status: 'waiting' }, 'waiting'],
  ])('reads a valid %s status from the same origin', async (body, expected) => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    const controller = new AbortController()
    const frames = []
    for await (const frame of statusProvider.open('dsh-resource://experimentstatus/test', { signal: controller.signal })) { frames.push(frame); controller.abort() }
    expect(frames).toEqual([{ ok: true, value: body }])
    expect((frames[0] && frames[0].ok ? frames[0].value as ExperimentStatus : undefined)?.status).toBe(expected)
    expect(request).toHaveBeenCalledWith('/api/experiment-preview?resource=status&session=test', {
      signal: expect.any(AbortSignal), credentials: 'same-origin', cache: 'no-store',
    })
    request.mockRestore()
  })

  it.each([{ status: 'ready', id: '', revision: 2 }, { status: 'ready', id: 'x', revision: 0 }, { status: 'other' }])
  ('rejects malformed or unknown status %s', async (body) => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    const frames = []
    const controller = new AbortController()
    for await (const frame of statusProvider.open('dsh-resource://experimentstatus/test', { signal: controller.signal })) { frames.push(frame); controller.abort() }
    expect(frames[0]?.ok).toBe(false)
    request.mockRestore()
  })

  it('registers and disposes the guide entry and its tab seats', async () => {
    const ctx = new Context()
    const tabs = new SidebarRightTabRegistry(ctx)
    const entries: { name: string; key: string }[] = []
    const slots = {
      inject: (_name: string, register: () => () => void) => register(),
      register: (entry: { name: string; key: string }) => {
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      },
    }
    ctx.provide('resources', { register: () => () => {} } as never)
    ctx.provide('sessions', { refresh: async () => {} } as never)
    ctx.provide('uiWorkspace', { openSession() {} } as never)
    ctx.provide('sidebarRightTabs', tabs as never)
    ctx.provide('sidebarRight', { mounted: { getSnapshot: () => undefined } } as never)
    ctx.provide('slots', slots as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: () => () => {},
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const tab = tabs.get('experiment-animation')
      expect(tab?.guide?.[0]?.title()).toBe(en.title)
      expect(tab?.guide?.[0]?.icon).toBeDefined()
      expect(entries.map(entry => entry.name)).toEqual(['shell.overlay', 'conversation.composer.dock', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
      expect(entries.slice(2).every(entry => entry.key === tab?.id)).toBe(true)
    } finally {
      await fiber.dispose()
    }
    expect(tabs.get('experiment-animation')).toBeUndefined()
    expect(entries).toEqual([])
  })
})
