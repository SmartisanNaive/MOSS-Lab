import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPreviewDocument } from '../src/client/bundle.ts'

const identity = { id: 'experiment', revision: 1, task: 'checked' }
const session = 'session-one'
afterEach(() => vi.restoreAllMocks())

describe('portable plugin documents', () => {
  it('preserves plugin HTML bytes and rechecks the current session and task', async () => {
    const calls: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'https://example.test')
      calls.push(url)
      const resource = url.searchParams.get('resource')
      return resource === 'status' ? Response.json({ status: 'ready', ...identity }) : new Response(`<html>${resource}</html>`)
    })
    const bundle = await fetchPreviewDocument(session, identity.id, 1, identity.task, 'animation', new AbortController().signal, 'api/experiment-preview')
    expect(bundle).toBe('<html>animation</html>')
    expect(calls.map(url => url.searchParams.get('resource'))).toEqual(['animation', 'status'])
    expect(calls.slice(0, 1).every(url => url.searchParams.get('session') === session && url.searchParams.get('task') === identity.task)).toBe(true)
    expect(calls.at(-1)?.searchParams.get('session')).toBe(session)
  })

  it('uses the demo endpoint without the real session', async () => {
    const calls: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'https://example.test')
      calls.push(url)
      return url.searchParams.get('resource') === 'status' ? Response.json({ status: 'ready', ...identity }) : new Response('<html>demo</html>')
    })
    await fetchPreviewDocument('demo', identity.id, 1, identity.task, 'animation', new AbortController().signal, 'api/experiment-demo')
    expect(calls.every(url => url.pathname === '/api/experiment-demo')).toBe(true)
    expect(calls.at(-1)?.search).toBe('?resource=status')
  })

  it('keeps the selected document independent and verifies an unavailable document against the current task', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const resource = new URL(input instanceof Request ? input.url : input.toString(), 'https://example.test').searchParams.get('resource')
      return resource === 'setup' ? new Response(null, { status: 404 }) : resource === 'status' ? Response.json({ status: 'ready', ...identity }) : new Response('<html>animation</html>')
    })
    const signal = new AbortController().signal
    expect(await fetchPreviewDocument(session, identity.id, 1, identity.task, 'animation', signal, 'api/experiment-preview')).toBe('<html>animation</html>')
    expect(await fetchPreviewDocument(session, identity.id, 1, identity.task, 'setup', signal, 'api/experiment-preview')).toBeNull()
  })

  it('rejects a checked task changed during download', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const resource = new URL(input instanceof Request ? input.url : input.toString(), 'https://example.test').searchParams.get('resource')
      return resource === 'status' ? Response.json({ status: 'ready', ...identity, task: 'new' }) : new Response('<html>document</html>')
    })
    await expect(fetchPreviewDocument(session, identity.id, 1, identity.task, 'animation', new AbortController().signal, 'api/experiment-preview')).rejects.toThrow('changed')
  })

  it('rejects another session and oversized documents', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    await expect(fetchPreviewDocument('other', identity.id, 1, identity.task, 'animation', new AbortController().signal, 'api/experiment-preview')).rejects.toThrow('unavailable')
    request.mockImplementation(async () => new Response(new Uint8Array(64 * 1024 * 1024 + 1)))
    await expect(fetchPreviewDocument(session, identity.id, 1, identity.task, 'animation', new AbortController().signal, 'api/experiment-preview')).rejects.toThrow('size limit')
  })
})
