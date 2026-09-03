import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar/client/service'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import { VscCloud } from 'react-icons/vsc'
import { ApiClient } from './ApiClient.tsx'
import { I18nProvider, translate } from './i18n.tsx'

export const inject = ['betterSidebar', 'conversation', 'sessions', 'locale']

export function apply(ctx: Context): void {
  const ApiClientTab = ({ scope, visible }: TabComponentProps) => <I18nProvider ctx={ctx}><ApiClient ctx={ctx} sessionId={scope.sessionId} visible={visible} /></I18nProvider>
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-api-client:requests',
    title: () => translate(ctx, 'tab.api'),
    icon: size => <VscCloud size={size} />,
    order: 47,
    single: true,
    component: ApiClientTab,
  }), 'dsh-api-client: Better Sidebar tab')
}
