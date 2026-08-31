/** DataOps-managed JWT intake and credential-backed MCP composition. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@sparkelf/dsh-plugin-mcp-credentials'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name for the DataOps-managed integration. */
export const name = 'dataops-managed'
/** Host services required by managed JWT and MCP ownership. */
export const inject = ['credentials', 'webServer', 'tools']

export const MANAGED_AUTH_PATH = '/integrations/dataops/managed-auth'

/** Configuration for the DataOps-managed MCP connection. */
export interface Config {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /** Local namespace for DataOps MCP tools. */
  serverName: string
  /** DSH credential reference that stores the current DataOps access JWT. */
  credentialRef: string
  /** Per-tool-call timeout forwarded to the MCP client. */
  toolCallTimeoutMs: number
  /** Whether initial MCP connection failure rejects the plugin. */
  failOnStartupError: boolean
}

/** Schemastery parser for managed DataOps configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://host.docker.internal:3101'),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  toolCallTimeoutMs: z.number().min(1).default(120_000),
  failOnStartupError: z.boolean().default(true),
})

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('dataops-managed: baseUrl must be an HTTP or HTTPS origin')
  }
  return url.origin
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization?.trim() ?? ''
  if (!authorization.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()
  return token === '' ? null : token
}

/**
 * Accept the current DataOps JWT and expose DataOps MCP tools through its credential.
 * @param ctx - DSH Host context with credentials, Web routes, and tools.
 * @param config - Managed DataOps origin and MCP settings.
 * @returns Startup readiness after an existing JWT is connected when present.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = normalizeOrigin(config.baseUrl)
  const accessRef = credentialRef(config.credentialRef)
  let mcpFiber: Fiber | undefined

  const ensureMcp = async (): Promise<void> => {
    if (mcpFiber !== undefined && mcpFiber.uid !== null) return
    const fiber = ctx.plugin(McpClient, {
      transport: 'streamable-http',
      serverName: config.serverName,
      url: `${baseUrl}/api/ai/data-query/mcp`,
      headers: {},
      bearerTokenRef: config.credentialRef,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: config.failOnStartupError,
    })
    mcpFiber = fiber
    try {
      await fiber.await()
    } catch (error) {
      if (mcpFiber === fiber) mcpFiber = undefined
      await fiber.dispose()
      throw error
    }
  }

  ctx.effect(() => async () => {
    const fiber = mcpFiber
    mcpFiber = undefined
    if (fiber !== undefined && fiber.uid !== null) await fiber.dispose()
  }, 'dataops-managed: MCP lifecycle')

  if (await ctx.credentials.resolve(accessRef) !== undefined) await ensureMcp()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANAGED_AUTH_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-length': '0' })
        response.end()
        return
      }
      const token = bearerToken(request)
      if (token === null) {
        response.writeHead(401, { 'content-length': '0' })
        response.end()
        return
      }
      await ctx.credentials.set(accessRef, token)
      await ensureMcp()
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
    },
  }), 'dataops-managed: JWT intake route')
}
