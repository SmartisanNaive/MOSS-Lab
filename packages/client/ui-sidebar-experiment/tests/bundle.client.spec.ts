import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPreviewBundle } from '../src/client/bundle.ts'
import { createPreviewDocument } from '../src/client/document.ts'

const session = 'session-one'
const identity = { id: 'experiment', revision: 1, task: 'checked' }
const path = (resource: string) => `/api/experiment-preview?${new URLSearchParams({ id: identity.id, revision: String(identity.revision), session, task: identity.task, resource })}`
const encoder = new TextEncoder()
const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input
const contents: Record<string, string> = {
  viewer: `<script type="importmap">{"imports":{"three":"${path('three')}"}}</script><script type="module" src="${path('script').replaceAll('&', '&amp;')}"></script>`,
  script: `import * as THREE from "three"; import { OrbitControls } from "${path('orbit')}"; fetch("${path('info')}"); fetch("${path('analysis')}"); fetch("${path('view')}"); load((${JSON.stringify(path('asset'))} + '&file=' + encodeURIComponent(item.file)));`,
  orbit: 'import { Vector3 } from \'three\'', three: 'export const Vector3 = class {}', info: '{}', analysis: '{}', view: '{"textures":[{"file":"texture.png"}]}', asset: 'png',
}

afterEach(() => vi.restoreAllMocks())

describe('bounded checked preview resources', () => {
  it('loads pinned resources and verifies the checked task again', async () => {
    const calls: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(requestUrl(input), 'https://example.test')
      calls.push(url)
      const resource = url.searchParams.get('resource')!
      return resource === 'status' ? Response.json({ status: 'ready', ...identity }) : new Response(contents[resource])
    })
    const bundle = await fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)
    expect(Object.keys(bundle.assets)).toEqual(['texture.png'])
    expect(calls.filter(url => url.searchParams.get('resource') !== 'status').every(url =>
      url.searchParams.get('session') === session && url.searchParams.get('id') === identity.id && url.searchParams.get('revision') === '1' && url.searchParams.get('task') === identity.task)).toBe(true)
    expect(calls.at(-1)?.searchParams.get('session')).toBe(session)
    const document = createPreviewDocument(bundle, session, identity.id, identity.revision, identity.task)
    expect(document).toContain("script-src 'unsafe-inline' blob:")
    expect(document).not.toContain(path('asset'))
    expect(document).not.toContain('texture.png')
  })

  it('loads demo resources and rewrites their internal demo addresses', async () => {
    const calls: URL[] = []
    const demoContent = (value: string) => value.replaceAll('api/experiment-preview', 'api/experiment-demo').replaceAll('session-one', 'demo')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(requestUrl(input), 'https://example.test')
      calls.push(url)
      const resource = url.searchParams.get('resource')!
      return resource === 'status' ? Response.json({ status: 'ready', ...identity }) : new Response(demoContent(contents[resource]!))
    })
    const bundle = await fetchPreviewBundle('demo', identity.id, identity.revision, identity.task, new AbortController().signal, 'api/experiment-demo')
    const document = createPreviewDocument(bundle, 'demo', identity.id, identity.revision, identity.task, 'api/experiment-demo')
    expect(document).toContain("script-src 'unsafe-inline' blob:")
    expect(calls.every(url => url.pathname === '/api/experiment-demo')).toBe(true)
    expect(calls.filter(url => url.searchParams.get('resource') !== 'status').every(url => url.searchParams.get('session') === 'demo')).toBe(true)
    expect(calls.at(-1)?.search).toBe('?resource=status')
    expect(() => createPreviewDocument(bundle, 'demo', identity.id, identity.revision, identity.task)).toThrow('Unsupported')
  })

  it('fails when the host rejects a different session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    await expect(fetchPreviewBundle('other-session', identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('unavailable')
  })

  it('rejects an experiment whose task changes during loading', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const resource = new URL(requestUrl(input), 'https://example.test').searchParams.get('resource')!
      return resource === 'status' ? Response.json({ status: 'ready', ...identity, task: 'new' }) : new Response(contents[resource])
    })
    await expect(fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('changed')
  })

  it.each(['../escape.png', 'invalid/file.png'])('rejects invalid texture names', async (file) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const resource = new URL(requestUrl(input), 'https://example.test').searchParams.get('resource')!
      return new Response(resource === 'view' ? JSON.stringify({ textures: [{ file }] }) : contents[resource])
    })
    await expect(fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('filename')
  })

  it('rejects more than 64 textures', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const resource = new URL(requestUrl(input), 'https://example.test').searchParams.get('resource')!
      return new Response(resource === 'view' ? JSON.stringify({ textures: Array.from({ length: 65 }, () => ({ file: 'a.png' })) }) : contents[resource])
    })
    await expect(fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('textures')
  })

  it('rejects a bundle above 64 MiB', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(32 * 1024 * 1024)))
    await expect(fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('size limit')
  })

  it('rejects a resource above 32 MiB', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(32 * 1024 * 1024 + 1)))
    await expect(fetchPreviewBundle(session, identity.id, identity.revision, identity.task, new AbortController().signal)).rejects.toThrow('size limit')
  })

  it('rejects missing script references before creating a document', () => {
    const bytes = encoder.encode('')
    expect(() => createPreviewDocument({ viewer: bytes, script: bytes, orbit: bytes, three: bytes, info: bytes, analysis: bytes, view: bytes, assets: {} }, session, identity.id, 1, identity.task)).toThrow('Unsupported')
  })
})
