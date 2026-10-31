/**
 * Model tools for the skill centre, the shared review queues, and the DataOps API reference.
 *
 * Registration is disclosure, not authorization. `AiToolManager` computes the workspace's
 * current DataOps scope once per credential/role sync and registers only the tools that scope
 * can use; these definitions assume they were registered for a principal that may call them.
 * Every `execute` therefore validates parameters, asks for user approval where a mutation needs
 * it, writes its audit line, and lets DataOps answer — no per-call role read, no local permission
 * tree, and no replacement for the backend's AuthGuard/PermissionGuard.
 *
 * The skill plaza is the catalogue. `scope=mine` exposes the caller's pending/rejected rows,
 * the public list exposes what the caller may install, and the admin list (administrators only)
 * exposes disabled entries. Installation, sharing and deletion are deliberately three different
 * actions: uninstall removes only the caller's installation, unshare unpublishes the shared entry
 * (with an unpublished notification), and delete permanently removes the entry after a second
 * confirmation, with its own deleted notification and audit trail.
 *
 * @module tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ReviewApi } from './review-api.ts'
import { readLocalSkills } from './skill-plaza.ts'
import { ApiDocsUnavailableError, searchOpenApiDocument, type ApiDocsFilters } from './api-docs.ts'
import { OPEN_OBJECT_SCHEMA, renderJson, type Json } from './tool-output.ts'
import {
  canReview,
  isAdmin,
  isDepartmentAdmin,
  type AiToolName,
  type DataOpsScope,
} from './tool-scope.ts'

/** One managed tool together with the name the disclosure map uses. */
export interface AiManagedTool {
  name: AiToolName
  definition: ToolDefinition
}

/** Parse one plaza response body into rows without trusting its shape. */
function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  if (typeof body === 'object' && body !== null && Array.isArray((body as { skills?: unknown }).skills)) {
    return ((body as { skills: unknown[] }).skills).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  }
  return []
}

const forbidden = (message: string): Error => new Error('Forbidden (403): ' + message)

/**
 * Build every managed tool definition.
 *
 * The definitions are built once; `readScope` is a live getter so a tool that survives a role
 * change reports the scope the manager currently holds instead of the one it was registered
 * with. An undefined scope can only be observed by an in-flight call during disposal, where the
 * safe behavior is to show only the public catalogue.
 * @param ctx - Host context used for local skills, approval and audit.
 * @param reviewApi - Same-origin bridge holding the workspace JWT.
 * @param readScope - Live accessor for the manager's current scope.
 * @returns One definition per managed tool name.
 */
export function buildAiManagementTools(
  ctx: Context,
  reviewApi: ReviewApi,
  readScope: () => DataOpsScope | undefined,
): AiManagedTool[] {
  const approve = async (tool: string, exec: ToolRunContext, reason: string): Promise<void> => {
    if (exec.agent === undefined) throw new Error(tool + ' requires an initiating agent')
    const approval = (ctx as unknown as { approval: { request(input: { agent: unknown; toolName: string; callId: string; signal: AbortSignal; reason: string }): Promise<string> } }).approval
    const outcome = await approval.request({ agent: exec.agent, toolName: tool, callId: exec.callId, signal: exec.signal, reason })
    if (outcome !== 'allowed-once') throw new Error(tool + ' approval was ' + outcome)
  }
  const audit = (tool: string, exec: ToolRunContext, detail: Record<string, unknown>): void => {
    try {
      const agent = exec.agent as { session?: { id?: string } } | undefined
      ctx.logger.info('[audit] ' + tool + ' ' + JSON.stringify({ sessionId: agent?.session?.id ?? null, callId: exec.callId, ...detail }))
    } catch { /* audit must not fail the tool */ }
  }
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const result = await reviewApi.request(path, init)
    if (result.status === 401) throw new Error('Unauthorized (401): DataOps session expired')
    const detail = (result.body as { error?: unknown; message?: unknown } | null)
    const reason = typeof detail?.error === 'string' ? detail.error : typeof detail?.message === 'string' ? detail.message : ''
    if (result.status === 403) throw forbidden(reason || 'the current role may not perform this action')
    if (result.status === 409) throw new Error('Conflict (409): ' + (reason || 'the skill still has installations'))
    if (result.status < 200 || result.status >= 300) throw new Error('DataOps ' + path + ' failed: HTTP ' + result.status.toString() + (reason ? ': ' + reason : ''))
    return result.body
  }

  const listSkills = async (scope: DataOpsScope, includeLocal: boolean): Promise<Record<string, unknown>> => {
    const mine = rowsOf(await call('/api/ai/skill-plaza/skills?scope=mine'))
    const publicRows = rowsOf(await call('/api/ai/skill-plaza/skills'))
    const admin = isAdmin(scope) ? rowsOf(await call('/api/ai/skill-plaza/admin/skills')) : []
    const byId = new Map<number, Record<string, unknown>>()
    for (const row of [...mine, ...publicRows, ...admin]) if (typeof row.id === 'number') byId.set(row.id, { ...byId.get(row.id), ...row })
    const rows = [...byId.values()]
    const local = includeLocal ? (await readLocalSkills(ctx)).map(skill => ({ name: skill.name, description: skill.description ?? null, source: 'local' })) : []
    const catalog = {
      local,
      pending: rows.filter(row => row.reviewStatus === 'pending'),
      approved: rows.filter(row => row.reviewStatus === 'approved'),
      rejected: rows.filter(row => row.reviewStatus === 'rejected'),
    }
    return { catalog, canReview: canReview(scope), isAdmin: isAdmin(scope), isDepartmentAdmin: isDepartmentAdmin(scope), departmentCode: scope.departmentCode ?? null, skills: rows }
  }

  /**
   * Build the enable/disable pair.
   *
   * The two tools share one body so their approval reason, audit detail and endpoint stay in
   * step; only the verb and the boolean they send differ.
   */
  function defineSkillStatusTool(enabled: boolean): ToolDefinition {
    const name = enabled ? 'skill_enable' : 'skill_disable'
    return defineTool({
      name,
      description: (enabled ? 'Enable' : 'Disable') + ' one plaza skill for distribution. Administrator only. Requires user approval; audited.',
      parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      execute: async (args: { skill_id: number }, exec) => {
        await approve(name, exec, (enabled ? 'Enable' : 'Disable') + ' skill ' + args.skill_id.toString())
        await call('/api/ai/skill-plaza/admin/skills/' + args.skill_id.toString() + '/status', { method: 'PATCH', body: JSON.stringify({ enabled }) })
        audit(name, exec, { skillId: args.skill_id, enabled })
        return { skillId: args.skill_id, enabled }
      },
    })
  }

  return [
    {
      name: 'skill_list',
      definition: defineTool({
        name: 'skill_list',
        description: 'List skills in the DataOps skill centre: local workspace skills plus the caller\'s pending/rejected submissions and the approved plaza entries they may install. Scope follows the caller role (department admins see their department; ordinary users see their own and approved entries). Read-only.',
        parameters: {
          include_local: { type: 'boolean', description: 'Include local workspace skills (default true).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { include_local?: boolean }) => {
          return await listSkills(readScope() ?? {}, args.include_local !== false) as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_get',
      definition: defineTool({
        name: 'skill_get',
        description: 'Read one skill-centre entry by id: description, instruction, review status, review note, risk report and visibility. Only entries visible to the caller can be read.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Skill/plaza id from skill_list.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }) => {
          const listing = await listSkills(readScope() ?? {}, false)
          const rows = listing.skills as Array<Record<string, unknown>>
          const found = rows.find(row => row.id === args.skill_id)
          if (found === undefined) throw new Error('Skill not found or not visible: ' + args.skill_id.toString())
          return found as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_submit',
      definition: defineTool({
        name: 'skill_submit',
        description: 'Submit the caller\'s own skill for plaza review. When the workspace review switch is off DataOps approves immediately; otherwise the entry becomes pending. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Own skill/plaza id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_submit', exec, 'Submit skill ' + args.skill_id.toString() + ' for review')
          const value = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/submit', { method: 'POST', body: '{}' })
          audit('skill_submit', exec, { skillId: args.skill_id })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_install',
      definition: defineTool({
        name: 'skill_install',
        description: 'Install one approved, visible plaza skill into the caller\'s workspace. Requires user approval; audited. The secret-free result reports the local skill key.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_install', exec, 'Install skill ' + args.skill_id.toString())
          const value = await call('/api/ai/skill-plaza/install', { method: 'POST', body: JSON.stringify({ skillId: args.skill_id }) })
          audit('skill_install', exec, { skillId: args.skill_id })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_uninstall',
      definition: defineTool({
        name: 'skill_uninstall',
        description: 'Uninstall one skill from the caller\'s own workspace only: deletes the current user\'s installation record. The plaza entry, its review status, visibility and enabled flag are unchanged and no “unpublished” notification is sent. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_uninstall', exec, 'Uninstall skill ' + args.skill_id.toString() + ' from the current workspace')
          const result = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/install', { method: 'DELETE' }) as { uninstalled?: unknown; removed?: unknown }
          audit('skill_uninstall', exec, { skillId: args.skill_id, scope: 'installation-only', removed: result.removed ?? null })
          return { uninstalled: result.uninstalled === true, removed: typeof result.removed === 'number' ? result.removed : 0 }
        },
      }),
    },
    {
      name: 'skill_enable',
      definition: defineSkillStatusTool(true),
    },
    {
      name: 'skill_disable',
      definition: defineSkillStatusTool(false),
    },
    {
      name: 'skill_unshare',
      definition: defineTool({
        name: 'skill_unshare',
        description: 'Stop sharing one plaza skill (soft unpublish): the entry and its installations remain, review status/visibility are kept, and DataOps sends an “unpublished” notification. Owners may unshare their own entries; 超级管理员/管理员 any entry; 部门管理员 their department. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_unshare', exec, 'Unshare skill ' + args.skill_id.toString())
          await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString(), { method: 'DELETE' })
          audit('skill_unshare', exec, { skillId: args.skill_id, effect: 'soft-unpublish' })
          return { unshared: args.skill_id, effect: 'plaza-sharing-disabled' }
        },
      }),
    },
    {
      name: 'skill_delete',
      definition: defineTool({
        name: 'skill_delete',
        description: 'Permanently delete one plaza skill. This is not unshare: the record is removed, DataOps sends a “deleted” notification (not “unpublished”), and the audit entry records the permanent action. Requires confirm=true as a second confirmation; owners may delete their own entries, 超级管理员/管理员 any entry, 部门管理员 their department. If installations still exist the backend returns 409 and the error is passed through. Requires user approval; audited.',
        parameters: {
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          confirm: { type: 'boolean', required: true, description: 'Must be true: explicitly confirms permanent deletion.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number; confirm: boolean }, exec) => {
          if (args.confirm !== true) throw new Error('skill_delete requires confirm=true (permanent deletion)')
          await approve('skill_delete', exec, 'Permanently delete skill ' + args.skill_id.toString())
          await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/permanent', { method: 'DELETE' })
          audit('skill_delete', exec, { skillId: args.skill_id, permanent: true })
          return { deleted: args.skill_id, permanent: true }
        },
      }),
    },
    {
      name: 'review_scan',
      definition: defineTool({
        name: 'review_scan',
        description: 'Run the DataOps AI risk scan for skill and/or workflow ids. Reviewers only; the tool is disclosed to principals with review capability and skill read access, and DataOps still enforces the permission on every call. Read-only.',
        parameters: {
          skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids to scan.' },
          workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids to scan.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skills?: number[]; workflows?: string[] }) => {
          return await call('/api/ai/review/scan', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [] }) }) as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_decide',
      definition: defineTool({
        name: 'review_decide',
        description: 'Approve or reject skills/workflows. Requires authorization.confirmed=true (the administrator explicitly confirmed), a reviewer role, resource scope and the review-decide capability; DataOps enforces all of them on the call. Requires a second user approval at tool level and writes an audit entry.',
        parameters: {
          skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids.' },
          workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids.' },
          decision: { type: 'string', required: true, description: 'approve or reject.' },
          note: { type: 'string', description: 'Review note (max 2000 chars).' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true: the administrator confirmed this decision.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skills?: number[]; workflows?: string[]; decision: string; note?: string; confirmed: boolean }, exec) => {
          if (args.confirmed !== true) throw new Error('authorization.confirmed=true is required for review_decide')
          if (args.decision !== 'approve' && args.decision !== 'reject') throw new Error('decision must be approve or reject')
          if ((args.skills ?? []).length === 0 && (args.workflows ?? []).length === 0) throw new Error('at least one skill or workflow id is required')
          await approve('review_decide', exec, 'Review ' + args.decision + ' for ' + (args.skills ?? []).length.toString() + ' skill(s) / ' + (args.workflows ?? []).length.toString() + ' workflow(s)')
          const value = await call('/api/ai/review/decide', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [], decision: args.decision, note: args.note ?? '', authorization: { confirmed: true } }) })
          audit('review_decide', exec, { decision: args.decision, skills: args.skills ?? [], workflows: args.workflows ?? [], confirmed: true })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_notifications_list',
      definition: defineTool({
        name: 'review_notifications_list',
        description: 'List the caller\'s review notifications and unread count. Read-only and always scoped to the current DataOps user.',
        parameters: {
          unread_only: { type: 'boolean', description: 'Only unread notifications.' },
          limit: { type: 'number', description: 'Maximum rows (default 20).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { unread_only?: boolean; limit?: number }) => {
          const query = new URLSearchParams({ unreadOnly: args.unread_only === true ? 'true' : 'false', limit: String(args.limit ?? 20) })
          return await call('/api/ai/review-notifications?' + query.toString()) as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_notifications_read',
      definition: defineTool({
        name: 'review_notifications_read',
        description: 'Mark the caller\'s review notifications as read, either selected ids or all. Scoped to the current DataOps user; no secret is involved.',
        parameters: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Notification ids to mark read.' },
          all: { type: 'boolean', description: 'Mark every notification read.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { ids?: string[]; all?: boolean }, exec) => {
          const value = await call('/api/ai/review-notifications/read', { method: 'POST', body: JSON.stringify({ ids: args.ids ?? [], all: args.all === true }) })
          audit('review_notifications_read', exec, { count: args.ids?.length ?? 0, all: args.all === true })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_api_docs',
      definition: defineTool({
        name: 'dataops_api_docs',
        description: 'Search the DataOps HTTP API reference (OpenAPI 3) for endpoint contracts. Super administrators only; read-only. Returns compact operations — method, path, operationId, summary, tags, parameters, request-body fields and security — filtered by keyword, tag, path, operationId or HTTP method. It only reads the fixed /api/openapi.json document and cannot execute arbitrary requests.',
        parameters: {
          query: { type: 'string', description: 'Case-insensitive keywords matched against path, operationId, summary, tags and description. All keywords must match.' },
          tag: { type: 'string', description: 'Exact OpenAPI tag (case-insensitive).' },
          path: { type: 'string', description: 'Case-insensitive substring of the operation path.' },
          operation_id: { type: 'string', description: 'Case-insensitive substring of the operationId.' },
          method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or TRACE.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: ApiDocsFilters) => {
          const result = await reviewApi.request('/api/openapi.json')
          if (result.status === 401) throw new Error('Unauthorized (401): DataOps session expired; sign in again to read the API reference')
          if (result.status === 403) throw new Error('Forbidden (403): the DataOps OpenAPI document is not available to this role')
          if (result.status === 404) throw new Error('DataOps API docs are unavailable: /api/openapi.json is not configured (DATAOPS_OPENAPI_UNAVAILABLE)')
          if (result.status === 503) throw new Error('DataOps API docs are unavailable: this workspace has no DataOps session')
          if (result.status < 200 || result.status >= 300) throw new Error('DataOps API docs request failed: HTTP ' + result.status.toString())
          try {
            return searchOpenApiDocument(result.body, args) as unknown as Record<string, Json>
          } catch (error) {
            if (error instanceof ApiDocsUnavailableError) throw new Error(error.message)
            throw error
          }
        },
      }),
    },
  ]

}