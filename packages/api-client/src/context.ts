import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
export interface ApiWebServer { register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void }
export interface ApiToolsService { register(tool: unknown): () => void }
export type ApiContext = CordisContext & { webServer: ApiWebServer; tools: ApiToolsService }
