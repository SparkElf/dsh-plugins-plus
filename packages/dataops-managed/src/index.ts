/** DataOps-managed JWT intake and credential-backed MCP composition. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { currentAuthState } from './auth-state.ts'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@sparkelf/dsh-plugin-mcp-credentials'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
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
import { ReviewApi } from './review-api.ts'
import { registerAiManagementTools } from './tools.ts'
import {
  WorkspaceLimits,
  WorkspaceLimitsRejection,
  currentWorkspaceLimits,
  setWorkspaceLimits,
} from './workspace-limits.ts'

/** Cordis plugin name for the DataOps-managed integration. */
export const name = 'dataops-managed'
/** Host services required by managed JWT and MCP ownership. */
export const inject = ['credentials', 'webServer', 'tools', 'settings', 'skills', 'approval']

export const MANAGED_AUTH_PATH = '/integrations/dataops/managed-auth'

/** This plugin's profile entry id, which owns its Config and sync state. */
export const MANAGED_PLUGIN_ID = 'dataops-managed'

/** Same-origin route the workspace settings pages use to read and change model sharing. */
export const MODEL_SYNC_PATH = '/integrations/dataops/model-sync'

/** Same-origin route the skill center uses to read and change plaza sharing. */
export const SKILL_PLAZA_PATH = '/integrations/dataops/skill-plaza'
/** Caller role and review capability. */
export const REVIEW_CONTEXT_PATH = '/integrations/dataops/review-context'
/** Notification inbox and read receipts. */
export const REVIEW_NOTIFICATIONS_PATH = '/integrations/dataops/review-notifications'
/** AI scan and the administrator's decision. */
export const REVIEW_ACTION_PATH = '/integrations/dataops/review'
/** Permission-centre reads and writes. */
export const RBAC_PATH = '/integrations/dataops/rbac'
/** The three plaza-review switches. */
export const REVIEW_SETTINGS_PATH = '/integrations/dataops/review-settings'
/** Department CRUD bridge (task-67). */
export const DEPARTMENTS_PATH = '/integrations/dataops/departments'

/** Same-origin route the Settings panel uses to read and change this workspace's limits. */
export const WORKSPACE_LIMITS_PATH = '/integrations/dataops/workspace-limits'

/** Same-origin route the Settings panel uses to read and change the tool-call timeout. */
export const TOOL_TIMEOUT_PATH = '/integrations/dataops/tool-timeout'

/** Same-origin route reporting what the last DataOps answer said about the credential. */
export const AUTH_STATE_PATH = '/integrations/dataops/auth-state'

/** The ends a tool-call timeout may take, in whole seconds. */
export const TOOL_TIMEOUT_MIN_SECONDS = 1
export const TOOL_TIMEOUT_MAX_SECONDS = 3600

/** The live sync instance, so the settings routes can act on it after activation. */
let modelSyncRef: ModelSync | undefined

/** The live plaza instance, so the skill center routes can act on it after activation. */
let skillPlazaRef: SkillPlaza | undefined

/** The live review API, once this plugin activated. */
let reviewApiRef: ReviewApi | undefined

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
 * Adopt the JWT the browser gateway attached to one request.
 *
 * Every browser request reaches this workspace through the DataOps gateway, which resolves the
 * caller's session and forwards a fresh `authorization: Bearer <jwt>` — so the current credential
 * arrives continuously, without any push, handshake or refresh protocol. The routes below are
 * the only place this plugin can see that header, and reading it here is what keeps the stored
 * credential from going stale: the value in it was captured once, while the caller's session is
 * renewed by DataOps for as long as they stay signed in.
 *
 * A request without the header is normal rather than an error (same-origin fetches from inside
 * the workspace do carry it, but a probe or a health check may not), so this only ever improves
 * the stored value and never rejects the request.
 *
 * @param request - the incoming request, whose headers the gateway filled in.
 * @returns once the credential has been updated, or immediately when there is nothing to adopt.
 */
export function adoptRequestJwt(
  ctx: Context,
  accessRef: ReturnType<typeof credentialRef>,
  request: IncomingMessage,
): Promise<void> {
  const token = bearerToken(request)
  // Re-storing the same value would rewrite the credential document and wake its watchers on
  // every request; comparing first keeps adoption to the moments the token actually changed.
  if (token === null) return Promise.resolve()
  return (async () => {
    const current = await ctx.credentials.resolve(accessRef)
    if (current?.value === token) return
    await ctx.credentials.set(accessRef, token)
  })().catch((error: unknown) => {
    // A credential write that fails must not fail the request that carried it: the caller asked
    // for the page, not for this housekeeping, and the next request will try again.
    ctx.logger.warn('dataops-managed: request JWT could not be adopted')
    ctx.logger.warn(error)
  })
}

/** The skill this plugin contributes: how to answer a DataOps data question. */
const QUERY_SKILL_NAME = 'dataops-query'
/** Location of the skill document inside the published package. */
const QUERY_SKILL_FILE = new URL('../skills/dataops-query/SKILL.md', import.meta.url)
/** Package root, which the skill loads its relative resources against. */
const QUERY_SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Describe the query skill to the catalog without reading it.
 *
 * The description repeats what the skill file declares, because a catalog listing must
 * answer whether the skill applies before its content is loaded.
 */
const QUERY_SKILL = {
  name: QUERY_SKILL_NAME,
  description:
    '用户问数、取数、查数据、要报表时使用。包含选表策略（优先总表；有地域区分时先大后小）、取数前与用户确认资源清单、以及超时时主动分批次。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: QUERY_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: QUERY_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: QUERY_SKILL_FILE,
} as const

/** Serve the query skill to the catalog. */
const querySkillProvider = {
  name: QUERY_SKILL_NAME,
  list: () => Promise.resolve([QUERY_SKILL]),
  async get() {
    return { ...QUERY_SKILL, content: await readFile(QUERY_SKILL_FILE, 'utf8') }
  },
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

  // The query skill ships with the plugin: a data question is the plugin's own subject, so its
  // guidance travels with the DataOps integration rather than the deployment profile.
  ctx.skills.registerProvider(() => querySkillProvider)

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
  const reviewApi = new ReviewApi(ctx, { baseUrl, credentialRef: config.credentialRef })
  reviewApiRef = reviewApi
  ctx.effect(() => registerAiManagementTools(ctx, reviewApi), 'dataops-managed: skill and review tools')
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
  // Adoption talks to the backend and may be slow (model publication, distributed
  // settings). It must never delay route registration: the workspace readiness probe
  // asks for `/integrations/dataops/model-sync`, and a stalled adoption used to leave
  // every managed route at 404 while the process was still booting. The function
  // catches and reports its own failures, so starting it without awaiting is safe.
  if (await ctx.credentials.resolve(accessRef) !== undefined) void adoptNow()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANAGED_AUTH_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-length': '0' })
        response.end()
        return
      }
      // The browser cannot read its own httpOnly cookie, so it cannot put the JWT in this
      // request's body. That is fine: the gateway already attached the same token to the header,
      // and reading it there is what makes a bare POST (no body, no client-side token) enough to
      // re-authenticate the workspace after the caller signs in again.
      await adoptRequestJwt(ctx, accessRef, request)
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
          const mine = url.searchParams.get('mine') === '1'
          const page = await plaza.listPage({
            tag: url.searchParams.get('tag') ?? undefined,
            query: url.searchParams.get('q') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            scope: mine ? 'mine' : url.searchParams.get('scope') ?? undefined,
            departmentCode: url.searchParams.get('departmentCode') ?? undefined,
          })
          writeJson(response, 200, {
            skills: mine ? page.skills.filter(skill => skill.sharedByMe) : page.skills,
            tags: mine ? [] : await plaza.tags(),
            ...(page.counts === undefined ? {} : { counts: page.counts }),
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
        if (action === 'share' || action === 'submit') {
          const name = typeof body?.name === 'string' ? body.name : ''
          const instruction = typeof body?.instruction === 'string' ? body.instruction : ''
          const description = typeof body?.description === 'string' ? body.description : undefined
          const tags = Array.isArray(body?.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : []
          if (name.trim() === '' || instruction.trim() === '') {
            writeJson(response, 400, { error: 'name and instruction are required' })
            return
          }
          const shared = await plaza.share({ name, description, instruction, tags })
          writeJson(response, 200, { ok: true, skill: shared })
          return
        }
        if (action === 'review') {
          const api = reviewApiRef
          if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
          const id = typeof body?.id === 'number' ? body.id : undefined
          const decision = body?.decision === 'reject' ? 'reject' : body?.decision === 'approve' ? 'approve' : null
          if (id === undefined || decision === null) { writeJson(response, 400, { error: 'id and decision are required' }); return }
          const result = await api.request('/api/ai/review/decide', {
            method: 'POST',
            body: JSON.stringify({
              skills: [id],
              workflows: [],
              decision,
              note: typeof body?.note === 'string' ? body.note : '',
              authorization: { confirmed: true, reason: 'skill-plaza-review' },
            }),
          })
          writeJson(response, result.status, result.body)
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
   * Review context, notifications, AI scan/decide, the permission centre and review settings.
   *
   * These are thin same-origin bridges: DataOps owns identity, authorization, the state machine
   * and the audit trail; this route only attaches the workspace JWT and forwards answers so the
   * browser can show a precise waiting/refused state instead of flattening both to "empty".
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_CONTEXT_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'content-length': '0' }); response.end(); return }
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const result = await api.request('/api/ai/review/context')
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review context failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review context route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_NOTIFICATIONS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const params = new URLSearchParams()
          if (url.searchParams.get('unreadOnly') === 'true') params.set('unreadOnly', 'true')
          if (url.searchParams.get('limit') !== null) params.set('limit', url.searchParams.get('limit') as string)
          const result = await api.request('/api/ai/review-notifications' + (params.size === 0 ? '' : '?' + params.toString()))
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const result = await api.request('/api/ai/review-notifications/read', { method: 'POST', body: JSON.stringify(body ?? {}) })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review notifications failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review notifications route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_ACTION_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'content-length': '0' }); response.end(); return }
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        const skills = Array.isArray(body?.skills) ? body.skills : []
        const workflows = Array.isArray(body?.workflows) ? body.workflows : []
        if (action === 'scan') {
          const result = await api.request('/api/ai/review/scan', { method: 'POST', body: JSON.stringify({ skills, workflows }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (action === 'decide') {
          const result = await api.request('/api/ai/review/decide', {
            method: 'POST',
            body: JSON.stringify({
              skills,
              workflows,
              decision: body?.decision,
              note: body?.note,
              authorization: body?.authorization,
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        writeJson(response, 400, { error: 'unknown review action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: review action failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review action route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RBAC_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const section = url.searchParams.get('section') ?? 'matrix'
          const suffix = section === 'members'
            ? '?q=' + encodeURIComponent(url.searchParams.get('q') ?? '') + '&departmentCode=' + encodeURIComponent(url.searchParams.get('departmentCode') ?? '')
            : section === 'resources'
              ? '?kind=' + encodeURIComponent(url.searchParams.get('kind') ?? '')
              : ''
          const target = section === 'members'
            ? '/api/system/permission-center/members' + suffix
            : section === 'departments'
              ? '/api/system/permission-center/departments'
              : section === 'resources'
                ? '/api/system/permission-center/resources' + suffix
                : '/api/system/permission-center/matrix' + (url.searchParams.get('scope') === 'dsh' ? '?scope=dsh' : '')
          const result = await api.request(target)
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PUT') { response.writeHead(405, { allow: 'GET, PUT', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const section = typeof body?.section === 'string' ? body.section : ''
        const value = typeof body?.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {}
        if (section === 'roles') {
          const result = await api.request('/api/system/permission-center/matrix', { method: 'PUT', body: JSON.stringify(value) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'members' && typeof value.userId === 'string') {
          const result = await api.request('/api/system/permission-center/members/' + encodeURIComponent(value.userId) + '/roles', { method: 'PUT', body: JSON.stringify({ roleCodes: value.roleCodes }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'departments' && typeof value.code === 'string') {
          const result = await api.request('/api/system/permission-center/departments/' + encodeURIComponent(value.code) + '/admin', { method: 'PUT', body: JSON.stringify({ userIds: value.userIds }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'resources' && typeof value.kind === 'string' && value.id !== undefined) {
          const result = await api.request('/api/system/permission-center/resources/' + encodeURIComponent(value.kind) + '/' + encodeURIComponent(String(value.id)) + '/scope', {
            method: 'PUT',
            body: JSON.stringify({ departmentCode: value.departmentCode, visibility: value.visibility, ownerId: value.ownerId }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        writeJson(response, 400, { error: 'unknown rbac section' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: permission centre failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: permission centre route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEPARTMENTS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const body = await readJson(request)
        if (request.method === 'POST') {
          const result = await api.request('/api/system/departments', { method: 'POST', body: JSON.stringify(body ?? {}) })
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PATCH' && request.method !== 'DELETE') {
          response.writeHead(405, { allow: 'POST, PATCH, DELETE', 'content-length': '0' })
          response.end()
          return
        }
        const code = typeof body?.code === 'string' ? body.code : ''
        if (code === '') { writeJson(response, 400, { error: 'department code is required' }); return }
        // The backend uses updatedAt as its optimistic-lock token. Read the current row here so
        // the browser does not have to carry a field the permission-centre list does not return.
        const current = await api.request('/api/system/departments/' + encodeURIComponent(code))
        const record = typeof current.body === 'object' && current.body !== null ? current.body as Record<string, unknown> : {}
        const department = typeof record.department === 'object' && record.department !== null ? record.department as Record<string, unknown> : {}
        const updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : department.updatedAt
        if (typeof updatedAt !== 'string') { writeJson(response, current.status === 200 ? 409 : current.status, { error: 'department not found' }); return }
        if (request.method === 'PATCH') {
          const result = await api.request('/api/system/departments/' + encodeURIComponent(code), {
            method: 'PATCH',
            body: JSON.stringify({
              updatedAt,
              name: body?.name,
              parentCode: body?.parentCode,
              description: body?.description,
              owner: body?.owner,
              enabled: body?.enabled,
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        const result = await api.request('/api/system/departments/' + encodeURIComponent(code), {
          method: 'DELETE',
          body: JSON.stringify({ updatedAt }),
        })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: department bridge failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: department CRUD bridge')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_SETTINGS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const result = await api.request('/api/integrations/dataops/review-settings')
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PUT' && request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST, PUT', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const result = await api.request('/api/integrations/dataops/review-settings', { method: 'POST', body: JSON.stringify(body ?? {}) })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review settings failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review settings route')

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

  /**
   * The tool-call timeout, stored in this plugin's own Config.
   *
   * The settings service keeps the value in this workspace's document and updates the volatile
   * reference in place, so a change takes effect on the next connection without a restart. The
   * profile therefore does not have to anticipate how long a deployment's queries take.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TOOL_TIMEOUT_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const read = () => volatileValue(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
      if (request.method === 'GET') {
        writeJson(response, 200, { toolCallTimeoutMs: read() })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
        response.end()
        return
      }
      try {
        const body = await readJson(request)
        const milliseconds = body?.toolCallTimeoutMs
        if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds)) {
          writeJson(response, 400, { error: 'toolCallTimeoutMs must be a whole number of milliseconds' })
          return
        }
        const seconds = milliseconds / 1000
        if (seconds < TOOL_TIMEOUT_MIN_SECONDS || seconds > TOOL_TIMEOUT_MAX_SECONDS) {
          writeJson(response, 400, {
            error: 'the timeout must be between ' + String(TOOL_TIMEOUT_MIN_SECONDS)
              + ' and ' + String(TOOL_TIMEOUT_MAX_SECONDS) + ' seconds',
          })
          return
        }
        await ctx.settings.update(MANAGED_PLUGIN_ID, { toolCallTimeoutMs: milliseconds })
        writeJson(response, 200, { toolCallTimeoutMs: milliseconds })
      } catch (error) {
        ctx.logger.warn('dataops-managed: tool timeout request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: tool timeout route')

  /**
   * What the last DataOps answer said about this workspace's credential.
   *
   * The settings surfaces need this because a 401 is handled deep inside a call that degrades to
   * "no data", so the panel renders as if the workspace simply has nothing to show. Reading this
   * route is how the interface learns the reason is an ended session rather than an empty one.
   * The recorded state is an observation, never an authority: DataOps still decides.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_STATE_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'content-length': '0' })
        response.end()
        return
      }
      writeJson(response, 200, { state: currentAuthState() })
    },
  }), 'dataops-managed: auth state route')

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
