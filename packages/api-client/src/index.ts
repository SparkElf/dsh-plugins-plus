import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApiContext } from './context.ts'
import { executeApiRequest } from './executor.ts'
import { exportApiDocument, importApiDocument, type ApiExchangeFormat } from './import-export.ts'
import { ApiClientStore } from './store.ts'
import type { ApiAuthSecretInput, ApiCollection, ApiEnvironment, ApiRequest, ApiWorkspace } from './types.ts'

export * from './types.ts'
export * from './import-export.ts'
export { ApiClientStore } from './store.ts'
export { executeApiRequest } from './executor.ts'
export const name = 'api-client'
export const inject = ['webServer', 'tools']
type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
function toolJson<T>(value: T): Record<string, ToolJson> { return value as unknown as Record<string, ToolJson> }

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Uint8Array[] = []; for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
function writeJson(res: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(body) }
function sanitizedRequest(request: ApiRequest): Record<string, ToolJson> { const value = { ...request, auth: { ...request.auth, credentialId: undefined } }; return value as unknown as Record<string, ToolJson> }
function exchangeFormat(value: unknown): ApiExchangeFormat {
  if (value !== 'postman' && value !== 'openapi') throw new Error('API exchange format must be postman or openapi')
  return value
}

export type ApiClientHostMethods = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>

export function createApiClientHostMethods(store: ApiClientStore): ApiClientHostMethods {
  return {
    state: () => store.state(),
    'workspaces.save': async payload => { await store.saveWorkspace(payload.workspace as ApiWorkspace); return store.state() },
    'workspaces.delete': async payload => { await store.deleteWorkspace(String(payload.workspaceId)); return store.state() },
    'collections.save': async payload => { await store.saveCollection(payload.collection as ApiCollection); return store.state() },
    'collections.delete': async payload => { await store.deleteCollection(String(payload.collectionId)); return store.state() },
    'environments.save': async payload => { await store.saveEnvironment(payload.environment as ApiEnvironment); return store.state() },
    'environments.delete': async payload => { await store.deleteEnvironment(String(payload.environmentId)); return store.state() },
    'requests.save': async payload => { await store.saveRequest(payload.request as ApiRequest, payload.authSecret as ApiAuthSecretInput | undefined); return store.state() },
    'requests.delete': async payload => { await store.deleteRequest(String(payload.requestId)); return store.state() },
    'requests.execute': async payload => ({ response: await executeApiRequest(store, String(payload.requestId)), state: await store.state() }),
    'workspaces.import': async payload => {
      const bundle = importApiDocument(exchangeFormat(payload.format), payload.document)
      await store.saveWorkspace(bundle.workspace)
      for (const collection of bundle.collections) await store.saveCollection(collection)
      for (const environment of bundle.environments) await store.saveEnvironment(environment)
      for (const request of bundle.requests) await store.saveRequest(request, bundle.authSecrets[request.id])
      return { workspaceId: bundle.workspace.id, state: await store.state() }
    },
    'workspaces.export': async payload => exportApiDocument(exchangeFormat(payload.format), await store.state(), String(payload.workspaceId)),
  }
}

/** Register API collection CRUD, explicit execution, import/export, history, and sanitized model tools. */
export function apply(ctx: ApiContext): void {
  const store = new ApiClientStore()
  const logger = ctx.logger as unknown as { error(...args: unknown[]): void }
  const methods = createApiClientHostMethods(store)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-api-client/api', handler: async (req, res) => {
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/dsh-api-client/api/'.length)
    try { const handler = methods[method]; if (handler === undefined) throw new Error('Unknown API Client method: ' + method); writeJson(res, 200, await handler(await readBody(req))) }
    catch (error) { logger.error('[dsh-api-client] API request failed', error); writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'dsh-api-client: HTTP API')
  const open = { type: 'object', additionalProperties: true } as const
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_list_requests', description: 'List API workspaces, collections, environments, and requests without secret values.', parameters: {}, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async () => { const state = await store.state(); return toolJson({ workspaces: state.workspaces, collections: state.collections, environments: state.environments, requests: state.requests.map(sanitizedRequest) }) } })), 'dsh-api-client: list requests tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_get_request', description: 'Read one saved API request without authorization secrets.', parameters: { request_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { request_id: string }) => sanitizedRequest(await store.request(args.request_id)) })), 'dsh-api-client: get request tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_prepare_request', description: 'Prepare but do not execute a saved API request for user review in the API Client.', parameters: { request_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { request_id: string }) => toolJson({ request: sanitizedRequest(await store.request(args.request_id)), executable: false, reason: 'Open the API Client and explicitly send the request.' }) })), 'dsh-api-client: prepare request tool')
}
