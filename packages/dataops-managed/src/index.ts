/** DataOps-managed JWT intake and credential-backed MCP composition. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@sparkelf/dsh-plugin-mcp-credentials'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { ModelSync, type SyncStateStore } from './model-sync.ts'
import { SkillPlaza, readLocalSkills } from './skill-plaza.ts'

/** Cordis plugin name for the DataOps-managed integration. */
export const name = 'dataops-managed'
/** Host services required by managed JWT and MCP ownership. */
export const inject = ['credentials', 'webServer', 'tools', 'settings', 'skills']

export const MANAGED_AUTH_PATH = '/integrations/dataops/managed-auth'

/** This plugin's profile entry id, which owns its Config and sync state. */
export const MANAGED_PLUGIN_ID = 'dataops-managed'

/** Same-origin route the workspace settings pages use to read and change model sharing. */
export const MODEL_SYNC_PATH = '/integrations/dataops/model-sync'

/** Same-origin route the skill center uses to read and change plaza sharing. */
export const SKILL_PLAZA_PATH = '/integrations/dataops/skill-plaza'

/** The live sync instance, so the settings routes can act on it after activation. */
let modelSyncRef: ModelSync | undefined

/** The live plaza instance, so the skill center routes can act on it after activation. */
let skillPlazaRef: SkillPlaza | undefined

/** The live skill plaza, once this plugin activated. */
export function currentSkillPlaza(): SkillPlaza | undefined {
  return skillPlazaRef
}

/** The live model-sync instance, once this plugin activated. */
export function currentModelSync(): ModelSync | undefined {
  return modelSyncRef
}

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
  /**
   * Model-sync state this workspace keeps.
   *
   * Volatile, so the settings service stores it in this workspace's own document. It belongs
   * to the workspace rather than to DataOps because it records whether the user here wrote
   * their own models, which is a fact about this workspace.
   */
  modelSync: ModelSyncState
}

/** What this workspace remembers about sharing model configuration. */
export interface ModelSyncState {
  /** The user here chose their own models, so adoption stops for them. */
  detached: boolean
  /** Model ids adoption last wrote, so a later edit can be told apart from one of them. */
  adoptedModelIds: string[]
  /** Model ids the administrator keeps private; every other model is offered by default. */
  privateModelIds: string[]
}

/** Default sync state before this workspace stored anything. */
const MODEL_SYNC_DEFAULT: ModelSyncState = {
  detached: false,
  adoptedModelIds: [],
  privateModelIds: [],
}

/** Schemastery parser for managed DataOps configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://host.docker.internal:3101'),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  toolCallTimeoutMs: z.number().min(1).default(120_000),
  /**
   * Volatile so the settings service persists it in this workspace's document. The shape is
   * left open because the sync state is this plugin's own record, not user configuration.
   */
  modelSync: z.any().default(MODEL_SYNC_DEFAULT).volatile(),
})

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
  const baseUrl = new URL(config.baseUrl).origin
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

  /**
   * The sync state lives in this plugin's own Config, so the settings service persists it in
   * the workspace document and it survives a restart.
   */
  const syncStore: SyncStateStore = {
    read: () => ({
      detached: config.modelSync?.detached === true,
      adoptedModelIds: Array.isArray(config.modelSync?.adoptedModelIds) ? config.modelSync.adoptedModelIds : [],
      privateModelIds: Array.isArray(config.modelSync?.privateModelIds) ? config.modelSync.privateModelIds : [],
    }),
    write: async (next) => {
      await ctx.settings.update(MANAGED_PLUGIN_ID, { modelSync: next })
    },
  }
  const modelSync = new ModelSync(ctx, { baseUrl, credentialRef: config.credentialRef }, syncStore)
  modelSyncRef = modelSync
  const skillPlaza = new SkillPlaza(ctx, { baseUrl, credentialRef: config.credentialRef })
  skillPlazaRef = skillPlaza

  /**
   * Adopt the publisher's models once the workspace has a session.
   *
   * Adoption waits for the JWT because the publication is read with it; a workspace that has
   * not been authorized yet simply tries again when its session arrives.
   */
  const adoptNow = async (): Promise<void> => {
    try {
      await modelSync.adopt()
    } catch (error) {
      ctx.logger.warn('dataops-managed: model sync could not adopt the published models')
      ctx.logger.warn(error)
    }
  }
  if (await ctx.credentials.resolve(accessRef) !== undefined) await adoptNow()

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
      await adoptNow()
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
    },
  }), 'dataops-managed: JWT intake route')

  /**
   * The settings surface the workspace's own pages read and write.
   *
   * Same-origin only: the browser reaches these through the gateway that already authenticated
   * it, and the DataOps JWT they act with is the one this plugin holds, never a value the page
   * supplies.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODEL_SYNC_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const sync = currentModelSync()
      if (sync === undefined) {
        writeJson(response, 503, { error: 'model sync is not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          writeJson(response, 200, await sync.status())
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'publish') {
          const sharingEnabled = body?.sharingEnabled === true
          await sync.publish(sharingEnabled)
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'detach') {
          await sync.detach()
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'resume') {
          await sync.resumeFollowing()
          await sync.adopt()
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'private-models') {
          const ids = Array.isArray(body?.privateModelIds)
            ? body.privateModelIds.filter((id): id is string => typeof id === 'string')
            : []
          await sync.setPrivateModels(ids, body?.sharingEnabled === true)
          writeJson(response, 200, await sync.status())
          return
        }
        writeJson(response, 400, { error: 'unknown action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: model sync request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: model sync routes')

  /**
   * The skill plaza surface the workspace's skill center reads and writes.
   *
   * Same-origin only, like the model routes: the browser reaches these through the gateway
   * that already authenticated it, and the DataOps JWT they act with is the one this plugin
   * holds rather than a value the page supplies.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SKILL_PLAZA_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const plaza = currentSkillPlaza()
      if (plaza === undefined) {
        writeJson(response, 503, { error: 'skill plaza is not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          writeJson(response, 200, {
            skills: await plaza.list({ tag: url.searchParams.get('tag') ?? undefined, query: url.searchParams.get('q') ?? undefined }),
            tags: await plaza.tags(),
          })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'local-skills') {
          writeJson(response, 200, { skills: await readLocalSkills(ctx) })
          return
        }
        if (action === 'share') {
          const name = typeof body?.name === 'string' ? body.name : ''
          const instruction = typeof body?.instruction === 'string' ? body.instruction : ''
          const description = typeof body?.description === 'string' ? body.description : undefined
          const tags = Array.isArray(body?.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : []
          const shared = await plaza.share({ name, description, instruction, tags })
          writeJson(response, 200, { skill: shared })
          return
        }
        if (action === 'unshare') {
          if (typeof body?.id === 'number') await plaza.unshare(body.id)
          writeJson(response, 200, { success: true })
          return
        }
        if (action === 'install') {
          const result = typeof body?.id === 'number' ? await plaza.install(body.id) : null
          writeJson(response, 200, result ?? { installed: false, skillKey: null, keptLocal: false })
          return
        }
        writeJson(response, 400, { error: 'unknown action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: skill plaza request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: skill plaza routes')
}

/** Read and parse a JSON request body, tolerating an absent one. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Answer one settings request as JSON. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(payload)
}
