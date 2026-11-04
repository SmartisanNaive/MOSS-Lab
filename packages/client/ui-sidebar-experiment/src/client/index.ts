/** Register the experiment animation page in the right sidebar. */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { VoiceWorkbench, createVoiceNavigationStore } from './voice-workbench.tsx'
import type { Context } from '@deepseek-ai/cordis'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ExperimentBody, ExperimentTitle } from './Experiment.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'
import { robotStatusProvider, statusProvider, watchProvider, voiceWorkbenchProvider } from './status.ts'
import { AutoOpenExperiment, createAutoOpenStore } from './auto-open.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

const ID = '@deepseek-ai/dsh-client-ui-sidebar-experiment'
const NS = 'sidebarExperiment'

/** Services required by the browser plugin. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'resources', 'uiWorkspace', 'sessions']

/** Register the localized tab type and its content. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.resources.register(statusProvider), 'ui-sidebar-experiment.status')
  ctx.effect(() => ctx.resources.register(watchProvider), 'ui-sidebar-experiment.watch')
  ctx.effect(() => ctx.resources.register(robotStatusProvider), 'ui-sidebar-experiment.robot-status')
  ctx.effect(() => ctx.resources.register(voiceWorkbenchProvider), 'ui-sidebar-experiment.voice-status')
  const voiceStore = createVoiceNavigationStore()
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: `${ID}.voice`, store: voiceStore, locale: NS,
    inject: () => ({ navigate: async (id: string, signal: AbortSignal) => {
      await ctx.sessions.refresh()
      if (!signal.aborted) ctx.uiWorkspace.openSession(SessionId(id))
    } }),
  }, VoiceWorkbench)), 'ui-sidebar-experiment.voice-navigation')
  const autoOpenStore = createAutoOpenStore()
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: ID, store: autoOpenStore,
    inject: sessionId => ({
      openExperiment: () => {
        if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return false
        ctx.sidebarRight.openTab('experiment-animation')
        return true
      },
      hooks: { sidebarMounted: ctx.sidebarRight.mounted },
    }),
  }, AutoOpenExperiment)), 'ui-sidebar-experiment.auto-open')
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-experiment.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: 'experiment-animation',
    priority: 'builtin',
    title: () => t('title'),
    guide: [{ id: 'animation', order: 20, title: () => t('title'), description: () => t('description'), icon: IconPlayOutlineRegular }],
  }), 'ui-sidebar-experiment.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
  }, ExperimentBody)), 'ui-sidebar-experiment.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID,
  }, ExperimentTitle)), 'ui-sidebar-experiment.title')
}
