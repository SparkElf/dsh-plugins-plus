import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar/client/service'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import { VscRemoteExplorer } from 'react-icons/vsc'
import { I18nProvider, translate } from './i18n.tsx'
import { SshManager } from './SshManager.tsx'
import { installXtermStyles } from './xterm-styles.ts'

export const inject = ['betterSidebar', 'conversation', 'sessions', 'locale']

export function apply(ctx: Context): void {
  installXtermStyles()
  const SshTab = ({ scope, visible }: TabComponentProps) => <I18nProvider ctx={ctx}><SshManager ctx={ctx} sessionId={scope.sessionId} visible={visible} /></I18nProvider>
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-manager:hosts',
    title: () => translate(ctx, 'tab.ssh'),
    icon: size => <VscRemoteExplorer size={size} />,
    order: 46,
    single: true,
    component: SshTab,
  }), 'dsh-ssh-manager: Better Sidebar tab')
}
