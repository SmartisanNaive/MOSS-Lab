import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fetchPreviewDocument } from './bundle.ts'

/** Status returned by the experiment preview service. */
export type ExperimentStatus = { readonly status: 'waiting' | 'checking' } | Ready & { readonly files: readonly string[] }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Current checked-experiment preview status. */
    experimentstatus: ExperimentStatus
    experimentdocument: string | null
    /** Preview identity for automatic session navigation. */
    experimentwatch: { readonly status: 'waiting' | 'checking' } | Ready
    /** One on-demand, read-only robot status query. */
    robotstatus: RobotStatus
    voiceworkbench: VoiceWorkbenchStatus
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Status could not be retrieved or was malformed. */
    'experiment/status-unavailable': Record<string, never>
    /** The robot status endpoint could not be reached. */
    'experiment/robot-unavailable': Record<string, never>
  }
}

/** Read-only device response; unavailable fields remain explicitly null. */
export type RobotStatus = {
  readonly status: 'not_configured' | 'unreachable' | 'partial' | 'ready'
  readonly queriedAt: string
  readonly health: { readonly status: string | null; readonly robotModel: string | null } | null
  readonly instruments: readonly { readonly mount: 'left' | 'right'; readonly name: string | null }[] | null
}

type Ready = { readonly status: 'ready'; readonly id: string; readonly revision: number; readonly task: string }

/** Fetch device information only after an explicit user request. */
export const robotStatusProvider: ResourceProvider<'robotstatus'> = {
  protocol: 'robotstatus',
  async *open(address, { signal }) {
    if (new URL(address).pathname === '/0') return
    try {
      const response = await fetch('api/robot-status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
      if (!response.ok) throw new Error('Status request failed')
      const value: unknown = await response.json()
      if (!isRobotStatus(value)) throw new Error('Invalid robot status')
      if (!signal.aborted) yield { ok: true, value }
    } catch {
      if (!signal.aborted) yield { ok: false, error: new RemoteError('experiment/robot-unavailable', 'Robot status is unavailable.', {}) }
    }
  },
}

function isRobotStatus(value: unknown): value is RobotStatus {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('queriedAt' in value) || !('health' in value) || !('instruments' in value)) return false
  if (!['not_configured', 'unreachable', 'partial', 'ready'].includes(String(value.status)) || typeof value.queriedAt !== 'string') return false
  const health = value.health
  if (health !== null && (typeof health !== 'object' || !('status' in health) || !('robotModel' in health) || (health.status !== null && typeof health.status !== 'string') || (health.robotModel !== null && typeof health.robotModel !== 'string'))) return false
  return value.instruments === null || (Array.isArray(value.instruments) && value.instruments.every((item: unknown) => typeof item === 'object' && item !== null && 'mount' in item && 'name' in item && (item.mount === 'left' || item.mount === 'right') && (item.name === null || typeof item.name === 'string')))
}

/** Parse a status body; `checking` reports the server rebuilding a persisted preview. */
function parseStatus(value: unknown): { readonly status: 'waiting' | 'checking' } | Ready | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) return undefined
  if (value.status === 'waiting' || value.status === 'checking') return { status: value.status }
  if (value.status !== 'ready' || !('id' in value) || !('revision' in value) || !('task' in value)) return undefined
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.task !== 'string' || value.task.length === 0) return undefined
  return { status: 'ready', id: value.id, revision: value.revision, task: value.task }
}

function delay(signal: AbortSignal, milliseconds = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Watch publication without downloading the scene while the sidebar is closed. */
export const watchProvider: ResourceProvider<'experimentwatch'> = {
  protocol: 'experimentwatch',
  async *open(address, { signal }) {
    const session = decodeURIComponent(new URL(address).pathname.slice(1))
    let active = false
    while (!signal.aborted) {
      try {
        if (!session) throw new Error('Missing session')
        const params = new URLSearchParams({ resource: 'status', session })
        const response = await fetch(`api/experiment-preview?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('Status request failed')
        const status = parseStatus(await response.json())
        if (status === undefined) throw new Error('Invalid status response')
        active = status.status === 'checking'
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can occur while a request is awaited.
        if (!signal.aborted) yield { ok: true, value: status }
      } catch {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can occur while a request is awaited.
        if (!signal.aborted) yield { ok: false, error: new RemoteError('experiment/status-unavailable', 'Experiment status is unavailable.', {}) }
      }
      await delay(signal, active ? 1000 : 5000)
    }
  },
}

/** Resource provider that retrieves the current preview status. */
export const statusProvider: ResourceProvider<'experimentstatus'> = {
  protocol: 'experimentstatus',
  async *open(address, { signal }) {
    let active = false
    while (!signal.aborted) {
      try {
        const url = new URL(address)
        const demo = url.searchParams.get('mode') === 'demo'
        const session = demo ? 'demo' : decodeURIComponent(url.pathname.split('/')[1] ?? '')
        if (!session) throw new Error('Missing session')
        const endpoint = demo ? 'api/experiment-demo' : 'api/experiment-preview'
        const params = new URLSearchParams(demo ? { resource: 'status' } : { resource: 'status', session })
        const response = await fetch(`${endpoint}?${params}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), credentials: 'same-origin', cache: 'no-store',
        })
        if (!response.ok) throw new Error('Status request failed')
        const value: unknown = await response.json()
        const status = parseStatus(value)
        if (status === undefined) throw new Error('Invalid status response')
        active = status.status === 'checking'
        const files = status.status === 'ready' ? readFiles(value) : []
        if (!signal.aborted) yield { ok: true, value: status.status === 'ready' ? { ...status, files } : status }
      } catch {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can occur while a request is awaited.
        if (!signal.aborted) yield {
          ok: false,
          error: new RemoteError('experiment/status-unavailable', 'Experiment status is unavailable.', {}),
        }
      }
      await delay(signal, active ? 1000 : 5000)
    }
  },
}

function readFiles(value: unknown): string[] {
  const files = typeof value === 'object' && value !== null && 'files' in value ? value.files : []
  if (!Array.isArray(files) || files.length > 64) throw new Error('Invalid preview files')
  return (files as readonly unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry)
      || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) throw new Error('Invalid preview filename')
    return entry.name
  })
}

/** Load the selected document for one session and checked task. */
export const documentProvider: ResourceProvider<'experimentdocument'> = {
  protocol: 'experimentdocument',
  async *open(address, { signal }) {
    const url = new URL(address)
    const [session, id, revision, task, view] = url.pathname.slice(1).split('/').map(decodeURIComponent)
    if (!session || !id || !task || (view !== 'animation' && view !== 'setup')) return
    const endpoint = session === 'demo' ? 'api/experiment-demo' : 'api/experiment-preview'
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)])
      const document = await fetchPreviewDocument(session, id, Number(revision), task, view, deadline, endpoint)
      if (!signal.aborted) yield { ok: true, value: document }
    } catch {
      if (!signal.aborted) yield { ok: false, error: new RemoteError('experiment/status-unavailable', 'Preview document is unavailable.', {}) }
    }
  },
}

export type VoiceWorkbenchStatus = {
  readonly sequence: number
  readonly sessionId: string | null
  readonly jobId: string | null
  readonly status: 'idle' | 'running' | 'completed' | 'error' | 'timeout'
  readonly result: string | null
  readonly focusSequence?: number
  readonly phase?: string
  readonly question?: string | null
  readonly preview?: { readonly id: string; readonly revision: number } | null
  readonly connection?: { readonly status: string }
}

/** Observe the voice task without creating a second conversation or model turn. */
export const voiceWorkbenchProvider: ResourceProvider<'voiceworkbench'> = {
  protocol: 'voiceworkbench',
  async *open(_address, { signal }) {
    let active = false
    while (isActive(signal)) {
      try {
        const response = await fetch('api/xiaozhi-workbench', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('Voice task unavailable')
        const value: unknown = await response.json()
        if (!isVoiceWorkbenchStatus(value)) throw new Error('Invalid voice task')
        active = value.status === 'running' || value.status === 'timeout'
        if (isActive(signal)) yield { ok: true, value }
      } catch {
        if (isActive(signal)) yield { ok: false, error: new RemoteError('experiment/status-unavailable', 'Voice task is unavailable.', {}) }
      }
      await delay(signal, active ? 500 : 1000)
    }
  },
}

function isVoiceWorkbenchStatus(value: unknown): value is VoiceWorkbenchStatus {
  if (typeof value !== 'object' || value === null) return false
  return 'sequence' in value && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
    && 'status' in value && ['idle', 'running', 'completed', 'error', 'timeout'].includes(String(value.status))
    && 'sessionId' in value && (value.sessionId === null || (typeof value.sessionId === 'string' && value.sessionId.length > 0))
    && 'jobId' in value && (value.jobId === null || typeof value.jobId === 'string')
    && 'result' in value && (value.result === null || typeof value.result === 'string')
    && (!('focusSequence' in value) || Number.isSafeInteger(value.focusSequence) && Number(value.focusSequence) >= 0)
    && (!('phase' in value) || typeof value.phase === 'string')
    && (!('question' in value) || value.question === null || typeof value.question === 'string')
    && (!('connection' in value) || typeof value.connection === 'object' && value.connection !== null
      && 'status' in value.connection && typeof value.connection.status === 'string')
    && (!('preview' in value) || value.preview === null || typeof value.preview === 'object' && value.preview !== null && 'id' in value.preview && typeof value.preview.id === 'string' && 'revision' in value.preview && Number.isSafeInteger(value.preview.revision) && Number(value.preview.revision) > 0)
}

function isActive(signal: AbortSignal): boolean { return !signal.aborted }
