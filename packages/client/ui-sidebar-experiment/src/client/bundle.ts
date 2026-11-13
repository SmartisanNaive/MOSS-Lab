export type PreviewView = 'animation' | 'setup'
export type PreviewEndpoint = 'api/experiment-preview' | 'api/experiment-demo'

const MAX_FILE = 64 * 1024 * 1024

/** Fetch one bounded document and verify that its checked revision is still selected. */
export async function fetchPreviewDocument(
  session: string, id: string, revision: number, task: string, resource: PreviewView,
  signal: AbortSignal, endpoint: PreviewEndpoint,
): Promise<string | null> {
  const document = await readDocument()
  const statusParams = new URLSearchParams(endpoint === 'api/experiment-demo' ? { resource: 'status' } : { resource: 'status', session })
  const response = await fetch(`${endpoint}?${statusParams}`, { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('Preview status unavailable')
  const status: unknown = await response.json()
  if (typeof status !== 'object' || status === null || !('status' in status) || status.status !== 'ready'
    || !('id' in status) || status.id !== id || !('revision' in status) || status.revision !== revision
    || !('task' in status) || status.task !== task) throw new Error('Experiment changed during preview load')
  return document

  async function readDocument(): Promise<string | null> {
    const params = new URLSearchParams({ id, revision: String(revision), session, task, resource })
    const response = await fetch(`${endpoint}?${params}`, { signal, credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 404 || response.status === 503) return null
    if (!response.ok || response.body === null) throw new Error('Preview resource unavailable')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > MAX_FILE) throw new Error('Preview resource exceeds size limit')
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
    return new TextDecoder('utf-8', { fatal: true }).decode(result)
  }
}
