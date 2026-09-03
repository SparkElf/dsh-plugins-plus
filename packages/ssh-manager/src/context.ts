import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

export interface SshWebServer { register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void }
export interface SshToolsService { register(tool: unknown): () => void }
export type SshContext = CordisContext & { webServer: SshWebServer; tools: SshToolsService }
