/** A bounded set of resources belonging to one checked experiment revision. */
export interface PreviewBundle {
  readonly viewer: Uint8Array
  readonly script: Uint8Array
  readonly orbit: Uint8Array
  readonly three: Uint8Array
  readonly info: Uint8Array
  readonly analysis: Uint8Array
  readonly view: Uint8Array
  readonly assets: Readonly<Record<string, Uint8Array>>
}

const MAX_FILE = 32 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024
const MAX_TEXTURES = 64

type Resource = 'viewer' | 'script' | 'orbit' | 'three' | 'info' | 'analysis' | 'view' | 'asset'

/**
 * Download the checked resources for one preview identity and verify that the identity is still current.
 * Reject HTTP or metadata failures, invalid textures, size limits, and identity changes during loading.
 * @param session - session id scoping the resource requests; demo callers pass the fixed `demo` session.
 * @param id - published experiment id from the ready status.
 * @param revision - checked experiment revision that every resource must match.
 * @param task - protocol-check task id that must still be current at the final status read.
 * @param signal - caller-owned cancellation signal passed to each request; aborting rejects the promise.
 * @param endpoint - preview route; defaults to `/api/experiment-preview`, or use `/api/experiment-demo`.
 * @returns complete resources and PNG assets, limited to 32 MiB per resource, 64 MiB total, and 64 textures.
 */
export async function fetchPreviewBundle(session: string, id: string, revision: number, task: string, signal: AbortSignal, endpoint: '/api/experiment-preview' | '/api/experiment-demo' = '/api/experiment-preview'): Promise<PreviewBundle> {
  let total = 0
  async function read(resource: Resource, file?: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ id, revision: String(revision), session, task, resource })
    if (file !== undefined) params.set('file', file)
    const response = await fetch(`${endpoint}?${params}`, { signal, credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok || response.body === null) throw new Error('Preview resource unavailable')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        total += chunk.value.byteLength
        if (length > MAX_FILE || total > MAX_TOTAL) throw new Error('Preview resource exceeds size limit')
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch((cancelError: unknown) => { console.error('Preview stream cancellation failed', cancelError) })
      throw error
    } finally {
      reader.releaseLock()
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  }
  const viewer = await read('viewer')
  const script = await read('script')
  const orbit = await read('orbit')
  const three = await read('three')
  const info = await read('info')
  const analysis = await read('analysis')
  const view = await read('view')
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(view))
  if (typeof parsed !== 'object' || parsed === null || !('textures' in parsed) || !Array.isArray(parsed.textures)
    || parsed.textures.length > MAX_TEXTURES) throw new Error('Invalid preview textures')
  const assets = Object.create(null) as Record<string, Uint8Array>
  const textures: unknown[] = parsed.textures
  for (const texture of textures) {
    if (typeof texture !== 'object' || texture === null || !('file' in texture) || typeof texture.file !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(texture.file) || texture.file === '.' || texture.file === '..') {
      throw new Error('Invalid texture filename')
    }
    if (!(texture.file in assets)) assets[texture.file] = await read('asset', texture.file)
  }
  const statusParams = new URLSearchParams(endpoint === '/api/experiment-demo' ? { resource: 'status' } : { resource: 'status', session })
  const response = await fetch(`${endpoint}?${statusParams}`, { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('Preview status unavailable')
  const status: unknown = await response.json()
  if (typeof status !== 'object' || status === null || !('status' in status) || status.status !== 'ready'
    || !('id' in status) || status.id !== id || !('revision' in status) || status.revision !== revision
    || !('task' in status) || status.task !== task) {
    throw new Error('Experiment changed during preview load')
  }
  return { viewer, script, orbit, three, info, analysis, view, assets }
}
