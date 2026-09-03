import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar/client/service'
import { VscCloud } from 'react-icons/vsc'
import { ApiClient } from './ApiClient.tsx'
export const inject = ['betterSidebar', 'conversation', 'sessions']
export function apply(ctx: Context): void { ctx.effect(() => ctx.betterSidebar.registerTab({ id: 'dsh-api-client:requests', title: 'API', icon: size => <VscCloud size={size} />, order: 47, single: true, component: ({ scope, visible }) => <ApiClient ctx={ctx} sessionId={scope.sessionId} visible={visible} /> }), 'dsh-api-client: Better Sidebar tab') }
