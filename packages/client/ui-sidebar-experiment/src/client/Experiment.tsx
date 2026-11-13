import { useState, type ReactNode } from 'react'
import { Button, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './Experiment.module.css'

/** Check the current experiment on each mount and explicit refresh. */
export function ExperimentBody({ t, useResource, useTabInfo, sessionId }: PropsLocale<'sidebarExperiment'> & PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  const [viewMode, setViewMode] = useState<'animation' | 'setup'>('animation')
  const [generation, setGeneration] = useState(0)
  const [retry, setRetry] = useState({ animation: 0, setup: 0 })
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
  const needsInput = voiceTask?.phase === 'needs_input'
  const voiceUnavailable = voiceTask !== undefined && (voice.status === 'failed' || voice.status === 'none')
  const updating = (voiceTask?.status === 'running' || voiceTask?.status === 'timeout') && !published
  const receipt = voiceTask ? `/${voiceTask.sequence}/${published ? 'preview_ready' : voiceTask.status}` : ''
  const address = `dsh-resource://experimentstatus/${encodeURIComponent(sessionId)}/${encodeURIComponent(tab.id)}/${generation}${receipt}`
  const resource = useResource<'experimentstatus'>(demo ? `${address}?mode=demo` : address)
  const current = resource.status === 'live' && resource.value?.status === 'ready' ? resource.value : undefined
  const matches = !published || current?.id === published.id && current.revision === published.revision
  const requestFailed = voiceTask?.status === 'error'
  const ready = current && !updating && !voiceUnavailable && (!requestFailed || published != null) && matches ? current : undefined
  const documentAddress = ready ? [demo ? 'demo' : sessionId, ready.id, String(ready.revision), ready.task, viewMode].map(encodeURIComponent).join('/') : ''
  const document = useResource<'experimentdocument'>(`dsh-resource://experimentdocument/${documentAddress}?retry=${retry[viewMode]}`)
  const documentFailed = document.status === 'failed' || document.status === 'none' || document.value === null
  const failed = requestFailed || voiceUnavailable || resource.status === 'failed' || resource.status === 'none'
  const message = requestFailed ? `${t('voiceFailed')} ${voiceTask.result ?? ''}` : failed ? t('error')
    : needsInput ? t('voiceNeedsInput') : updating ? t('voiceWorking')
      : resource.status === 'loading' || resource.value?.status === 'checking' ? t('checking') : demo ? t('demoWaiting') : t('waiting')
  return (
    <div className={css.preview}>
      {demo && <div className={css.demoInfo}>
        <strong>{t('demoLabel')}</strong>
        <div>{t('demoControls')}</div>
      </div>}
      <div className={css.toolbar}>
        <Button size="sm" variant="outline" aria-pressed={viewMode === 'animation'} onClick={() => { setViewMode('animation') }}>{t('showAnimation')}</Button>
        <Button size="sm" variant="outline" aria-pressed={viewMode === 'setup'} onClick={() => { setViewMode('setup') }}>{t('setupImage')}</Button>
        <Button size="sm" variant="outline" onClick={() => { setDemoTask(demo ? undefined : task ?? null) }}>{t(demo ? 'returnToExperiment' : 'viewDemo')}</Button>
        <Button size="sm" variant="outline" onClick={() => { setGeneration(value => value + 1) }}>{t('refresh')}</Button>
        {ready && ready.files.length > 0 && <details className={css.downloads}>
          <summary>{t('download')}</summary>
          {ready.files.map(file => <a key={file} download={file} href={`${demo ? 'api/experiment-demo' : 'api/experiment-preview'}?${new URLSearchParams({ id: ready.id, revision: String(ready.revision), session: demo ? 'demo' : sessionId, task: ready.task, resource: 'file', file })}`}>{file}</a>)}
        </details>}
        <Button size="sm" variant="outline" onClick={() => { setRobotGeneration(value => value + 1) }}>{t('robotQuery')}</Button>
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
      {needsInput && voiceTask.question && <div className={css.robotInfo} role="status">{voiceTask.question}</div>}
      {ready && requestFailed && <div className={css.robotInfo} role="alert">{message}</div>}
      {ready && !demo && <div className={css.robotInfo} data-experiment-revision={ready.revision}>{t('revision')} {ready.revision}</div>}
      {ready
        ? document.status === 'live' && typeof document.value === 'string'
          ? <iframe key={documentAddress} className={css.frame} title={t(viewMode === 'setup' ? 'setupImage' : 'title')}
            sandbox={viewMode === 'setup' ? '' : 'allow-scripts'} srcDoc={document.value} />
          : <div className={css.waiting}>
            <div role={documentFailed ? 'alert' : 'status'}>{t(documentFailed
              ? (viewMode === 'setup' ? 'setupLoadFailed' : 'animationLoadFailed') : 'checking')}</div>
            {documentFailed && <Button size="sm" variant="outline" onClick={() => {
              setRetry(value => ({ ...value, [viewMode]: value[viewMode] + 1 }))
            }}>{t(viewMode === 'setup' ? 'retrySetup' : 'retryAnimation')}</Button>}
          </div>
        : <div className={css.waiting}><div role={failed ? 'alert' : 'status'}>{message}</div></div>}
    </div>
  )
}

/** Animation tab icon and title. */
export function ExperimentTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><IconPlayOutlineRegular className={css.icon} />{tab.title}</>
}
