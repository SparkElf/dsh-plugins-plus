import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the skill center's slot declaration so this plugin can contribute to it.
import type {} from '@sparkelf/dsh-client-ui-skill-center/client'
import { ManagedDataOpsSection } from './ManagedDataOpsSection.tsx'
import { SkillPlazaSection } from './SkillPlazaSection.tsx'
import { installWanxiangBranding } from './install-branding.tsx'
import { ReloginPrompt, type ReloginPromptProps } from './ReloginPrompt.tsx'
import { PermissionCenterSection } from './PermissionCenterSection.tsx'
import { PermissionCenterIcon } from './PermissionCenterIcon.tsx'
import { WorkspaceUpgradePrompt } from './WorkspaceUpgradePrompt.tsx'
import { WorkflowPlazaBell } from './NotificationBell.tsx'
import { canSeeManagedSettings, subscribeManagedSettingsVisibility } from './settings-gate.ts'
import { REVIEW_CONTEXT_PATH, reviewDemoMode } from './review-client.ts'
import type { ManagedDataOpsSectionInjected } from './ManagedDataOpsSection.tsx'
import { en, zh, type ManagedDataOpsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Header actions declared by the knowledge-base workflow plaza. */
    'workflow-plaza.actions': {
      kind: 'single'
      scope: 'root'
      owner: Record<string, never>
      hookContext: unknown
    }
  }

  interface LocaleNamespaceMap {
    'settings.dataops-managed': ManagedDataOpsKey
  }
}

const NS = 'settings.dataops-managed'
const AUTH_UPDATED_MESSAGE = 'dataops-auth-updated'
const MANAGED_AUTH_PATH = '/integrations/dataops/managed-auth'

/** Sidebar entry and main page id for the permission centre. */
const PERMISSION_PANEL_ID = 'dataops-permissions'

/** Required client services for the managed DataOps Settings section. */
export const inject = ['slots', 'locale']

/**
 * Bind the four strings the sign-in prompt needs.
 *
 * Narrowed to exactly those keys rather than reusing the settings-section resolver: the prompt
 * asks its own small copy, and a wider type would let a typo pass as a valid key.
 *
 * @param ctx - client context carrying the registered namespace.
 * @returns a resolver for the prompt's own keys.
 */
const bindReloginCopy = (ctx: ClientContext): ReloginPromptProps['t'] => {
  const translate = ctx.locale.bind(NS) as (key: string) => string
  return (key) => translate(key)
}

/**
 * Register the managed DataOps surfaces and the sign-in prompt.
 *
 * The prompt rides a sidebar seat because the client needs *some* always-mounted surface for a
 * dialog that is about the whole workspace rather than one panel. The seat is a container: the
 * dialog itself portals to `document.body`, so this contributes no visible element to the
 * sidebar at rest and cannot disturb the regions that already live there.
 *
 * @param ctx - DSH client context with locale, slots and the sidebar foot.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dataops-managed: settings copy')
  installWanxiangBranding(ctx)
  const t = ctx.locale.bind(NS) as ManagedDataOpsSectionInjected['t']

  /**
   * Register the settings section only for the two administrator role labels.
   *
   * The identity record arrives after the iframe loads and can change when the portal account is
   * switched, so the registration is reconciled whenever the shared account store publishes. An
   * ordinary user's profile therefore has no section, no configuration form, and no publish
   * control at all — not a hidden one.
   */
  ctx.effect(() => {
    let disposeSection: (() => void) | undefined
    const reconcile = (): void => {
      const allowed = canSeeManagedSettings()
      if (allowed && disposeSection === undefined) {
        disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dataops',
          order: 25,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, ManagedDataOpsSection))
      } else if (!allowed && disposeSection !== undefined) {
        disposeSection()
        disposeSection = undefined
      }
    }
    reconcile()
    const unsubscribe = subscribeManagedSettingsVisibility(reconcile)
    return () => {
      unsubscribe()
      disposeSection?.()
      disposeSection = undefined
    }
  }, 'dataops-managed: settings section role gate')

  /**
   * The re-authentication prompt, mounted where it is always alive.
   *
   * A dialog needs a component that stays mounted whether or not the operator has the settings
   * panel open, and the sidebar foot is the one seat this plugin already owns. The component
   * renders nothing until DataOps reports the session has ended, so at rest it adds no element.
   */
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dataops-relogin',
    order: 90,
    inject: () => ({ t: bindReloginCopy(ctx) }),
  }, ReloginPrompt))
  /**
   * The workspace image upgrade notice. It lives in the shell overlay so it can sit
   * above the page without taking a sidebar or conversation seat; the component renders
   * nothing until DataOps reports a newer image.
   */
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dataops-workspace-upgrade',
    order: 20,
    inject: () => ({ t }),
  }, WorkspaceUpgradePrompt as never))

  /**
   * The permission centre, a sidebar entry plus the page it opens.
   *
   * The entry's glyph hides itself for an ordinary user; the page and every backend endpoint
   * re-check the caller, so hiding is navigation, not authorization.
   */
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PERMISSION_PANEL_ID as never,
  }, (() => PermissionCenterSection({ t })) as never)), 'dataops-managed: permission centre page')

  ctx.effect(() => {
    let disposeEntry: (() => void) | undefined
    let live = true
    const allowed = async (): Promise<boolean> => {
      if (typeof window !== 'undefined' && reviewDemoMode()) return true
      // The two managed-settings roles are already known from the launcher label; a department
      // administrator is only known from the review context, so ask the Host in that case.
      if (canSeeManagedSettings()) return true
      try {
        const response = await fetch(REVIEW_CONTEXT_PATH)
        if (!response.ok) return false
        const body = await response.json() as { primaryRole?: string; review?: { canReview?: boolean } }
        return body.primaryRole === 'DEPT_ADMIN' || body.review?.canReview === true
      } catch {
        return false
      }
    }
    const sync = async (): Promise<void> => {
      const next = await allowed()
      if (!live) return
      if (next && disposeEntry === undefined) {
        disposeEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PERMISSION_PANEL_ID,
          order: 20,
          label: () => t('permNav'),
          locale: NS,
        }, PermissionCenterIcon as never))
      } else if (!next && disposeEntry !== undefined) {
        disposeEntry()
        disposeEntry = undefined
      }
    }
    void sync()
    const off = subscribeManagedSettingsVisibility(() => { void sync() })
    return () => {
      live = false
      off()
      disposeEntry?.()
      disposeEntry = undefined
    }
  }, 'dataops-managed: permission centre entry gate')

  /**
   * The skill plaza, contributed to the skill center page.
   *
   * The skill center declares the slot and renders whatever it holds; a profile without this
   * plugin leaves it empty, which is what keeps the plaza out of a deployment that never
   * installed DataOps.
   */
  ctx.slots.inject('skill-center.section', () => ctx.slots.register({
    name: 'skill-center.section',
    id: 'dataops-plaza',
    order: 10,
    inject: () => ({ t }),
  }, SkillPlazaSection))

  /**
   * The workflow plaza's header seat, declared by the knowledge-base plugin. It renders a slot
   * rather than importing this plugin; the bell therefore joins only when both are installed.
   */
  ctx.slots.inject('workflow-plaza.actions', () => ctx.slots.register({
    name: 'workflow-plaza.actions',
  }, WorkflowPlazaBell as never))

  const synchronizeJwt = async (): Promise<void> => {
    const response = await fetch(new URL(MANAGED_AUTH_PATH, window.location.origin), {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`DataOps managed JWT synchronization failed with HTTP ${String(response.status)}`)
  }
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent
      || (event.data as { type?: unknown } | null)?.type !== AUTH_UPDATED_MESSAGE) return
    void synchronizeJwt().catch(error => console.error('dataops-managed.jwt_sync_failed', error))
  }
  ctx.effect(() => {
    window.addEventListener('message', onMessage)
    void synchronizeJwt().catch(error => console.error('dataops-managed.jwt_sync_failed', error))
    return () => window.removeEventListener('message', onMessage)
  }, 'dataops-managed: JWT synchronization')
}
