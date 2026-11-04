import { useState, type ReactNode } from 'react'
import { Button, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './Experiment.module.css'

/** Check the current experiment on each mount and explicit refresh. */
export function ExperimentBody({ t, useResource, useTabInfo, sessionId }: PropsLocale<'sidebarExperiment'> & PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const [generation, setGeneration] = useState(0)
  const [robotGeneration, setRobotGeneration] = useState(0)
  const [demoTask, setDemoTask] = useState<string | null | undefined>(undefined)
  const { tab } = useTabInfo()
  const robot = useResource<'robotstatus'>(`dsh-resource://robotstatus/${robotGeneration}`)
  const robotValue = robotGeneration > 0 && robot.status === 'live' ? robot.value : undefined
  const watched = useResource<'experimentwatch'>(`dsh-resource://experimentwatch/${encodeURIComponent(sessionId)}`)
  const task = watched.status === 'live' && watched.value !== undefined ? (watched.value.status === 'ready' ? watched.value.task : null) : undefined
  const demo = demoTask !== undefined && (task == null || task === demoTask)
  const voice = useResource<'voiceworkbench'>('dsh-resource://voiceworkbench/current')
  const voiceTask = !demo && voice.value?.sessionId === sessionId ? voice.value : undefined
  const published = voiceTask?.preview
  const receipt = voiceTask ? `/${voiceTask.sequence}/${published ? 'preview_ready' : voiceTask.status}` : ''
  const address = `dsh-resource://experimentstatus/${encodeURIComponent(sessionId)}/${encodeURIComponent(tab.id)}/${generation}${receipt}`
  const resource = useResource<'experimentstatus'>(demo ? `${address}?mode=demo` : address)
  const needsInput = voiceTask?.phase === 'needs_input'
  const updating = (voiceTask?.status === 'running' || voiceTask?.status === 'timeout') && !published && !needsInput
  const voiceUnavailable = !demo && (voice.status === 'failed' || voice.status === 'none')
  const requestFailed = voiceTask?.status === 'error'
  const current = resource.status === 'live' && resource.value?.status === 'ready' ? resource.value : undefined
  const matches = !published || current?.id === published.id && current.revision === published.revision
  const ready = current && !updating && !voiceUnavailable && (!requestFailed || published != null) && matches ? current : undefined
  const failed = requestFailed || voiceUnavailable || resource.status === 'failed' || resource.status === 'none'
  const message = requestFailed ? `${t('voiceFailed')} ${voiceTask.result ?? ''}` : failed ? t('error') : needsInput ? t('voiceNeedsInput') : updating ? t('voiceWorking')
    : resource.status === 'loading' || resource.value?.status === 'checking' ? t('checking') : demo ? t('demoWaiting') : t('waiting')
  return (
    <div className={css.preview}>
      {demo && <div className={css.demoInfo}>
        <strong>{t('demoLabel')}</strong>
        <div>{t('demoControls')}</div>
      </div>}
      <div className={css.toolbar}>
        <Button size="sm" variant="outline" onClick={() =>{  setDemoTask(demo ? undefined : task ?? null) }}>{t(demo ? 'returnToExperiment' : 'viewDemo')}</Button>
        <Button size="sm" variant="outline" onClick={() =>{  setGeneration(value => value + 1) }}>{t('refresh')}</Button>
        <Button size="sm" variant="outline" onClick={() =>{  setRobotGeneration(value => value + 1) }}>{t('robotQuery')}</Button>
      </div>
      {robotGeneration > 0 && <div className={css.robotInfo} role="status">
        {robot.status === 'failed' || robot.status === 'none' ? t('robotUnavailable')
          : robotValue === undefined ? t('robotChecking')
            : <>
              <div>{t(robotValue.status === 'not_configured' ? 'robotNotConfigured' : robotValue.status === 'unreachable' ? 'robotUnavailable' : robotValue.status === 'partial' ? 'robotPartial' : 'robotConnected')}</div>
              {robotValue.health && <>
                <div>{t('robotModel')}: {robotValue.health.robotModel ?? t('robotUnknown')}</div>
                <div>{t('robotHealth')}: {robotValue.health.status ?? t('robotUnknown')}</div>
              </>}
              {robotValue.instruments !== null && <div>{t('robotInstruments')}: {robotValue.instruments.length === 0 ? t('robotNone') : robotValue.instruments.map(item => `${t(item.mount === 'left' ? 'robotLeft' : 'robotRight')}: ${item.name ?? t('robotUnknown')}`).join(' · ')}</div>}
              <div>{t('robotTime')}: {new Date(robotValue.queriedAt).toLocaleString()}</div>
            </>}
      </div>}
      {voiceTask?.phase === 'needs_input' && voiceTask.question && <div className={css.robotInfo} role="status">{voiceTask.question}</div>}
      {ready && requestFailed && <div className={css.robotInfo} role="alert">{message}</div>}
      {ready && <div className={css.robotInfo} data-experiment-revision={ready.revision}>{t('revision')} {ready.revision}</div>}
      {ready
        ? <iframe className={css.frame} title={t('title')} sandbox="allow-scripts" srcDoc={ready.document} />
        : <div className={css.waiting}><div role={failed ? 'alert' : 'status'}>{message}</div></div>}
    </div>
  )
}

/** Animation tab icon and title. */
export function ExperimentTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><IconPlayOutlineRegular className={css.icon} />{tab.title}</>
}
