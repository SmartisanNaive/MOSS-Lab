import { useEffect } from 'react'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'

type State = { opened: string | undefined }
type Actions = { markOpened: (draft: State, key: string) => void }

/** Remember the last automatically opened preview for each session. */
export function createAutoOpenStore(): EngineStoreHandle<State, Actions> {
  return defineStore({ init: (): State => ({ opened: undefined }), actions: { markOpened: (draft, key) => { draft.opened = key } } })
}

export interface AutoOpenInjected {
  openExperiment: () => boolean
  hooks: { sidebarMounted: HostObservable<string | undefined> }
}

/** Observe preview publication while the session is visible. */
export function AutoOpenExperiment({ sessionId, useResource, useSidebarMounted, openExperiment, useStore, actions }: PropsRuntime<'conversation.composer.dock'> & InjectFace<AutoOpenInjected> & PropsStore<ReturnType<typeof createAutoOpenStore>>) {
  const resource = useResource<'experimentwatch'>(`dsh-resource://experimentwatch/${encodeURIComponent(sessionId)}`)
  const voice = useResource<'voiceworkbench'>('dsh-resource://voiceworkbench/current')
  const delegated = voice.value?.sessionId === sessionId && voice.value.status !== 'idle' ? voice.value : undefined
  const mounted = useSidebarMounted(value => value === sessionId)
  const opened = useStore(state => state.opened)
  const ready = resource.status === 'live' && resource.value?.status === 'ready' ? resource.value : undefined
  const key = delegated !== undefined
    ? JSON.stringify([delegated.focusSequence ?? delegated.sequence])
    : ready === undefined ? undefined : JSON.stringify([ready.id, ready.revision, ready.task])
  useEffect(() => {
    if (voice.status !== 'live' || !mounted || key === undefined || key === opened) return
    if (openExperiment()) actions.markOpened(key)
  }, [actions, key, mounted, openExperiment, opened, voice.status])
  return null
}
