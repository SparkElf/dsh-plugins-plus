import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar/client/service'
import { VscRemoteExplorer } from 'react-icons/vsc'
import { SshManager } from './SshManager.tsx'
import { installXtermStyles } from './xterm-styles.ts'

export const inject = ['betterSidebar', 'conversation', 'sessions']
export function apply(ctx: Context): void {
  installXtermStyles()
  ctx.effect(() => ctx.betterSidebar.registerTab({ id: 'dsh-ssh-manager:hosts', title: 'SSH', icon: size => <VscRemoteExplorer size={size} />, order: 46, single: true, component: ({ scope, visible }) => <SshManager ctx={ctx} sessionId={scope.sessionId} visible={visible} /> }), 'dsh-ssh-manager: Better Sidebar tab')
}
