/** DataOps-managed JWT intake and credential-backed MCP composition. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@sparkelf/dsh-plugin-mcp-credentials'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { ModelSync, type SyncStateStore } from './model-sync.ts'
import {
  SECTION_SYNC_DEFAULT,
  SettingsSync,
  type PublishedSection,
  type SectionSyncState,
  type SectionSyncStore,
} from './settings-sync.ts'
import { SkillPlaza, readLocalSkills } from './skill-plaza.ts'
import {
  WorkspaceLimits,
  WorkspaceLimitsRejection,
  currentWorkspaceLimits,
  setWorkspaceLimits,
} from './workspace-limits.ts'

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

/** Same-origin route the Settings panel uses to read and change this workspace's limits. */
export const WORKSPACE_LIMITS_PATH = '/integrations/dataops/workspace-limits'

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

export { currentWorkspaceLimits }

/** The live settings-sync instance, once this plugin activated. */
let settingsSyncRef: SettingsSync | undefined

/** @returns The live instance, or undefined before this plugin activated. */
export function currentSettingsSync(): SettingsSync | undefined {
  return settingsSyncRef
}

/**
 * A volatile config reference.
 *
 * A field marked volatile is not stored with the plugin's own configuration: the settings
 * service keeps it in this workspace's document and hands the plugin a reference that it
 * updates in place, so a value written through the Settings panel is visible without a
 * restart. Reading the field directly therefore reads the reference, not the value.
 */
interface VolatileRef<T> {
  /** The current value behind the reference. */
  get(): T
}

/**
 * Read the value behind a possibly-volatile field.
 *
 * A volatile field always arrives as a reference, but the plain shape is accepted too so a
 * caller that validated the config without a settings service still reads its value.
 * @param field - The config field as the runtime supplied it.
 * @param fallback - Value to use when nothing is stored yet.
 * @returns The current value.
 */
function volatileValue<T>(field: T | VolatileRef<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && 'get' in field && typeof field.get === 'function') {
    return (field as VolatileRef<T>).get() ?? fallback
  }
  return field as T
}

/** Configuration for the DataOps-managed MCP connection. */
export interface Config {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /** Local namespace for DataOps MCP tools. */
  serverName: string
  /** DSH credential reference that stores the current DataOps access JWT. */
  credentialRef: string
  /**
   * Per-tool-call timeout forwarded to the MCP client.
   *
   * Volatile, so the settings service stores the platform default in this workspace's document
   * and the panel can raise it without a profile edit. The read goes through `volatileValue`.
   */
  toolCallTimeoutMs: number | VolatileRef<number>
  /**
   * Model-sync state this workspace keeps.
   *
   * Volatile, so the settings service stores it in this workspace's own document. It belongs
   * to the workspace rather than to DataOps because it records whether the user here wrote
   * their own models, which is a fact about this workspace.
   *
   * Volatile, so the runtime supplies a reference and the read goes through `volatileValue`.
   */
  modelSync: ModelSyncState | VolatileRef<ModelSyncState>
  /**
   * Settings-distribution state this workspace keeps.
   *
   * Volatile, like the model-sync state beside it, and for the same reason: it records whether
   * the user here wrote their own values, which is a fact about this workspace.
   *
   * Volatile, like the field above, so the read goes through `volatileValue`.
   */
  settingsSync: SectionSyncState | VolatileRef<SectionSyncState>
  /**
   * Settings namespaces this deployment distributes to other workspaces.
   *
   * Empty by default: a deployment that publishes nothing offers no defaults, and a reader takes
   * its own values. Naming a namespace here is what puts it in every publication.
   */
  distributedSettingsNamespaces: string[]
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

/**
 * Per-tool-call timeout a workspace starts with.
 *
 * Named rather than inlined so the schema default and the read fallback cannot drift: the field is
 * volatile, so a workspace that never changed it reads no value at all and both places have to
 * answer the same number.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 300_000

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
  /**
   * Volatile so the settings service persists it in this workspace's document: the timeout an
   * operator needs depends on the query behind a tool, which is deployment knowledge the profile
   * that mounts this plugin does not have.
   *
   * `z.any()` like the sync state above, and for the same reason: a volatile field is delivered
   * to `apply` as a reference rather than a value, so a narrowed schema would describe a shape
   * the runtime does not pass. The range is enforced where the value is read.
   */
  toolCallTimeoutMs: z.any().default(DEFAULT_TOOL_CALL_TIMEOUT_MS).volatile(),
  /**
   * Volatile so the settings service persists it in this workspace's document. The shape is
   * left open because the sync state is this plugin's own record, not user configuration.
   */
  modelSync: z.any().default(MODEL_SYNC_DEFAULT).volatile(),
  /** Volatile for the same reason as `modelSync`: it is this plugin's own record. */
  settingsSync: z.any().default(SECTION_SYNC_DEFAULT).volatile(),
  /**
   * Namespaces offered in a publication. Validated as strings so a malformed profile entry fails
   * at load rather than producing a publication no reader can apply.
   */
  distributedSettingsNamespaces: z.array(z.string()).default([]).description(
    'Settings namespaces offered to other workspaces when this one publishes.',
  ),
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
      toolCallTimeoutMs: volatileValue(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
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

  /**
   * Connect the MCP client when a JWT is already stored.
   *
   * A connect can fail for reasons this plugin does not own — the stored JWT may have expired,
   * or DataOps may be unreachable at this moment — and those are states the settings routes
   * report and recover from. Awaiting it here would abort activation, leaving the plugin with
   * no routes at all: the panel then cannot read the very state that explains the failure, and
   * the browser reports a connection error instead. The routes below are registered first, and
   * a failed connect is reported rather than thrown.
   */
  const connectExisting = async (): Promise<void> => {
    if (await ctx.credentials.resolve(accessRef) === undefined) return
    try {
      await ensureMcp()
    } catch (error) {
      ctx.logger.warn('dataops-managed: connecting the DataOps MCP server failed; the settings routes stay up so a new JWT can be connected')
      ctx.logger.warn(error)
    }
  }

  /**
   * The sync state lives in this plugin's own Config, so the settings service persists it in
   * the workspace document and it survives a restart.
   */
  const syncStore: SyncStateStore = {
    read: () => {
      const state = volatileValue(config.modelSync, MODEL_SYNC_DEFAULT)
      return {
        detached: state?.detached === true,
        adoptedModelIds: Array.isArray(state?.adoptedModelIds) ? state.adoptedModelIds : [],
        privateModelIds: Array.isArray(state?.privateModelIds) ? state.privateModelIds : [],
      }
    },
    write: async (next) => {
      await ctx.settings.update(MANAGED_PLUGIN_ID, { modelSync: next })
    },
  }
  /**
   * The settings-distribution state lives in this plugin's own Config, so the settings service
   * persists it in the workspace document and it survives a restart.
   */
  const sectionStore: SectionSyncStore = {
    read: () => {
      const state = volatileValue(config.settingsSync, SECTION_SYNC_DEFAULT)
      return {
        sections: typeof state?.sections === 'object' && state.sections !== null ? state.sections : {},
      }
    },
    write: async (next) => {
      await ctx.settings.update(MANAGED_PLUGIN_ID, { settingsSync: next })
    },
  }
  const settingsSync = new SettingsSync(ctx, sectionStore)
  settingsSyncRef = settingsSync

  /**
   * The namespaces this deployment distributes.
   *
   * Listed here rather than inside the sync because what a deployment offers is its own choice:
   * the sync knows how to carry a section, and this decides which ones travel.
   */
  const distributedNamespaces = (): string[] => {
    const configured = config.distributedSettingsNamespaces
    return Array.isArray(configured) ? configured.filter((ns): ns is string => typeof ns === 'string' && ns !== '') : []
  }

  /**
   * Read the sections this workspace would publish.
   *
   * A namespace no plugin owns is skipped: publishing a section this deployment cannot apply
   * would offer readers values nothing on their side reads.
   */
  const collectSections = async (): Promise<PublishedSection[]> => {
    const collected: PublishedSection[] = []
    for (const ns of distributedNamespaces()) {
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === ns)
      if (descriptor === undefined) continue
      const value = descriptor.value
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      collected.push({ ns, value: value as Record<string, unknown> })
    }
    return collected
  }

  const modelSync = new ModelSync(
    ctx,
    { baseUrl, credentialRef: config.credentialRef, collectSections },
    syncStore,
  )
  modelSyncRef = modelSync
  const skillPlaza = new SkillPlaza(ctx, { baseUrl, credentialRef: config.credentialRef })
  skillPlazaRef = skillPlaza
  const workspaceLimits = new WorkspaceLimits(ctx, { baseUrl, credentialRef: config.credentialRef })
  setWorkspaceLimits(workspaceLimits)

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
    try {
      // The sections come from the same publication the models did, so a workspace that just
      // adopted models applies the settings that publication carried in the same pass.
      const published = await modelSync.readPublishedSections()
      if (published.length > 0) await settingsSync.adopt(published)
    } catch (error) {
      ctx.logger.warn('dataops-managed: distributed settings could not be adopted')
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
          writeJson(response, 200, {
            ...await sync.status(),
            // The sections travel beside the models because the panel shows both, and a separate
            // request would let the two rows disagree about which publication they describe.
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
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
        if (action === 'publish') {
          const sharingEnabled = body?.sharingEnabled === true
          await sync.publish(sharingEnabled)
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'publish-defaults') {
          // One action that copies whatever this workspace holds: the models plus every namespace
          // the deployment distributes. Sharing stays on so a reader picks it up.
          await sync.publish(true)
          writeJson(response, 200, {
            ...await sync.status(),
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
          })
          return
        }
        if (action === 'detach') {
          await sync.detach()
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'detach-section') {
          const ns = typeof body?.ns === 'string' ? body.ns.trim() : ''
          if (ns === '') {
            writeJson(response, 400, { error: 'detach-section needs a namespace' })
            return
          }
          await settingsSyncRef?.detach(ns)
          writeJson(response, 200, {
            ...await sync.status(),
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
          })
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

  /**
   * The workspace limits an administrator sets in DataOps.
   *
   * Read through the plugin because it holds the DataOps JWT; the page cannot reach those settings
   * itself. Same-origin only, like its neighbours.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WORKSPACE_LIMITS_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const limits = currentWorkspaceLimits()
      if (limits === undefined) {
        writeJson(response, 503, { error: 'workspace limits are not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          const status = await limits.status()
          if (status === undefined) {
            writeJson(response, 503, { error: 'workspace limits are not active' })
            return
          }
          writeJson(response, 200, status)
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const fileReadMaxBytes = body?.fileReadMaxBytes
        const uploadMaxBytes = body?.uploadMaxBytes
        if (typeof fileReadMaxBytes !== 'number' || typeof uploadMaxBytes !== 'number') {
          writeJson(response, 400, { error: 'both byte ceilings are required' })
          return
        }
        const status = await limits.save({ fileReadMaxBytes, uploadMaxBytes })
        if (status === undefined) {
          writeJson(response, 503, { error: 'workspace limits are not active' })
          return
        }
        writeJson(response, 200, status)
      } catch (error) {
        // A rejection DataOps already explained keeps its status and message: the panel shows the
        // reason and the user can correct the value. Anything else is a fault here, not input.
        if (error instanceof WorkspaceLimitsRejection) {
          writeJson(response, error.status, { error: error.message })
          return
        }
        ctx.logger.warn('dataops-managed: workspace limits request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: workspace limits route')

  await connectExisting()
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
