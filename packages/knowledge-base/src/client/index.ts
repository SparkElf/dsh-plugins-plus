/**
 * Knowledge-base Client plugin.
 *
 * Registers three official DSH surfaces:
 * - `sidebar.panellist` gives the left-sidebar menu entry.
 * - The matching `main` key gives the management page the entry selects. The
 *   page replaces the conversation area and carries its own master-detail
 *   layout: a menu and the knowledge tree on the left, a content region on the
 *   right.
 * - `settings.section` gives the connection and status page.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { KnowledgeSettingsSection } from './KnowledgeSettingsSection.tsx'
import type { KnowledgeSettingsInjected } from './KnowledgeSettingsSection.tsx'
import { KnowledgePanel } from './KnowledgePanel.tsx'
import type { KnowledgePanelInjected, SessionSource } from './KnowledgePanel.tsx'
import { KnowledgeMenuIcon } from './KnowledgeMenuIcon.tsx'
import { en, zh, type KnowledgeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.knowledgeBase': KnowledgeKey
  }
}

const NS = 'settings.knowledgeBase'

/**
 * Panel id shared by the list entry and the `main` slot it selects.
 *
 * The ui-sidebar contract resolves a missing panel by throwing and keeping the
 * current selection, so these two registrations must always ship together.
 */
const PANEL_ID = 'knowledge-base'

/** Client services required for these contributions. */
export const inject = ['slots', 'locale', 'uiSession']

/**
 * Register the knowledge-base navigation entry and Settings section.
 * @param ctx - DSH client context with locale and slot registries.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'knowledge-base: copy')
  const t = ctx.locale.bind(NS) as KnowledgeSettingsInjected['t']

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PANEL_ID,
    order: 35,
    label: () => t('nav'),
    inject: () => ({ t }),
  }, KnowledgeSettingsSection))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('nav'),
  }, KnowledgeMenuIcon))

  // The management page needs the caller's session to scope the file tree, and the
  // root-scoped `main` slot supplies no props. `uiSession.adapter.current` is the
  // published binding whose `key` is the session the main view is showing.
  //
  // Reading it once at inject time is not enough, because the value becomes
  // available only after a Workspace is chosen, which regularly happens AFTER this
  // page is first mounted: a page that sampled it once showed "No session
  // selected." forever and the file tree never appeared. Measured in a browser on
  // 2026-10-15 against a profile whose workspace list was still empty.
  //
  // The observable itself is handed to the component, which subscribes with
  // `useSyncExternalStore`. Re-reading inside `inject` would not help on its own:
  // the slot caches the injected value, so a later change has to reach React
  // through a subscription rather than through a fresh read.
  const currentSession = ctx.uiSession.adapter.current

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    // `main` is root-scoped, so the slot passes no locale-bound copy of its own;
    // the page gets the namespace's resolver plus the session source.
    inject: (): KnowledgePanelInjected => ({
      t: (key: string) => t(key as Parameters<typeof t>[0]),
      // The active locale id, so dates and relative spans render in the reader's
      // language rather than the machine's.
      locale: ctx.locale.getSnapshot().active,
      sessionSource: currentSession as SessionSource,
      // The tree's `@` helper takes the context itself, since it resolves the
      // workspace root and the draft service at click time.
      ctx,
    }),
  }, KnowledgePanel))
}
