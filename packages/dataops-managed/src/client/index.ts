import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ManagedDataOpsSection } from './ManagedDataOpsSection.tsx'
import type { ManagedDataOpsSectionInjected } from './ManagedDataOpsSection.tsx'
import { en, zh, type ManagedDataOpsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.dataops-managed': ManagedDataOpsKey
  }
}

const NS = 'settings.dataops-managed'

/** Required client services for the managed DataOps Settings section. */
export const inject = ['slots', 'locale']

/**
 * Register localized managed DataOps Settings navigation and content.
 * @param ctx - DSH client context with locale and settings slots.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dataops-managed: settings copy')
  const t = ctx.locale.bind(NS) as ManagedDataOpsSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dataops',
    order: 25,
    label: () => t('nav'),
    inject: () => ({ t }),
  }, ManagedDataOpsSection))
}
