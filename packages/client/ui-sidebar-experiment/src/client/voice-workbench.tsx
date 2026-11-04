import { useEffect, useState } from 'react'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './status.ts'

type State = { sequence: number }
type Actions = { acknowledge: (draft: State, sequence: number) => void }

/** Remember navigation receipts without taking selection away on every poll. */
export function createVoiceNavigationStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ sequence: -1 }),
    actions: { acknowledge: (draft, sequence) => { draft.sequence = sequence } },
  })
}

export interface VoiceNavigationInjected {
  navigate: (sessionId: string, signal: AbortSignal) => Promise<void>
}

/** Follow a newly accepted voice message even when another page is selected. */
export function VoiceWorkbench({ useResource, useStore, actions, navigate, t }: PropsRuntime<'shell.overlay'> & PropsStore<ReturnType<typeof createVoiceNavigationStore>> & VoiceNavigationInjected & PropsLocale<'sidebarExperiment'>) {
  const resource = useResource<'voiceworkbench'>('dsh-resource://voiceworkbench/current')
  const sequence = useStore(state => state.sequence)
  const value = resource.value
  const target = value?.status === 'idle' ? null : value?.sessionId
  const accepted = value?.focusSequence ?? value?.sequence
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!target || accepted === undefined || accepted <= sequence) return
    const controller = new AbortController()
    setFailed(false)
    void (async () => {
      for (let attempt = 0; attempt < 4 && isActive(controller.signal); attempt++) {
        try {
          await navigate(target, controller.signal)
          if (isActive(controller.signal)) actions.acknowledge(accepted)
          return
        } catch {
          if (!isActive(controller.signal)) return
          if (attempt === 3) { setFailed(true); return }
          await waitToRetry(controller.signal, 250 * 2 ** attempt)
        }
      }
    })()
    return () =>{  controller.abort() }
  }, [target, accepted, sequence, actions, navigate, retry])
  return failed ? <div role="alert">{t('voiceNavigationFailed')} <button type="button" onClick={() =>{  setRetry(value => value + 1) }}>{t('refresh')}</button></div> : null
}

/** Allow the Host catalog to catch up without retaining work after navigation changes. */
function waitToRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function isActive(signal: AbortSignal): boolean { return !signal.aborted }
