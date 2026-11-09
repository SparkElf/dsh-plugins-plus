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
import { CollectApi } from './collect-api.ts'
import { ResourceManagementApi } from './resource-management-api.ts'
import type { OpenResourceHub } from './resource-tab.ts'
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

/** Validate one plaza skill id before a provisioning call. */
const provisioningSkillId = (tool: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(tool + ': skill_id must be a positive integer')
  return value
}

/**
 * Normalize one explicit user list for a provisioning call.
 *
 * DataOps user ids are UUID strings, and the provisioning endpoints take a batch. An empty or
 * malformed list is a caller error: forwarding it would either match nobody or let the backend
 * answer a scope the caller never named, so it never reaches the API.
 */
const provisioningUserIds = (tool: string, values: readonly unknown[] | undefined): string[] => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(tool + ': user_ids must be a non-empty array of DataOps user ids')
  }
  const ids = values.map(value => typeof value === 'string' ? value.trim() : '')
  if (ids.some(id => id === '')) throw new Error(tool + ': user_ids must contain non-empty DataOps user ids')
  return Array.from(new Set(ids))
}

/** Read one required department code from tool arguments. */
const provisioningDepartmentCode = (tool: string, value: string | undefined): string => {
  const code = typeof value === 'string' ? value.trim() : ''
  if (code === '') throw new Error(tool + ': department_code is required')
  return code
}

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
  collectHub: OpenResourceHub,
): AiManagedTool[] {
  const collectApi = new CollectApi(reviewApi)
  const resourceManagementApi = new ResourceManagementApi(reviewApi)
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

  const parseJsonObject = (tool: string, label: string, value: string | undefined): Record<string, unknown> | undefined => {
    if (value === undefined || value.trim() === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(tool + ': ' + label + ' must be valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(tool + ': ' + label + ' must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  const parseJsonArray = (tool: string, label: string, value: string | undefined): unknown[] => {
    if (value === undefined || value.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(tool + ': ' + label + ' must be valid JSON')
    }
    if (!Array.isArray(parsed)) throw new Error(tool + ': ' + label + ' must be a JSON array')
    return parsed
  }

  /**
   * Keep only the fields the DataOps execute DTO accepts. The plan tool returns
   * `createSql`/`targetSchema`/`notes` beside `createTable`; if the model passes
   * the whole plan (or rebuilds it after a table-name edit), the backend's
   * `forbidNonWhitelisted` pipe rejects the call with a generic 400.
   */
  const normalizeCreatePlan = (
    tool: string,
    plan: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (plan === undefined) return undefined
    const tableName = typeof plan.tableName === 'string' ? plan.tableName.trim() : ''
    if (!tableName) throw new Error(tool + ': create_plan_json.tableName is required')
    const rawColumns = Array.isArray(plan.columns) ? plan.columns : []
    if (!rawColumns.length) throw new Error(tool + ': create_plan_json.columns is required')
    const columns = rawColumns.map((raw, index) => {
      const column = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {}
      const sourceKey = typeof column.sourceKey === 'string' ? column.sourceKey : ''
      const name = typeof column.name === 'string' ? column.name : ''
      const chineseName = typeof column.chineseName === 'string' ? column.chineseName : ''
      const dataType = typeof column.dataType === 'string' ? column.dataType : ''
      if (!sourceKey || !name || !chineseName || !dataType) {
        throw new Error(tool + ': create_plan_json.columns[' + index + '] needs sourceKey/name/chineseName/dataType')
      }
      return {
        sourceKey,
        name,
        chineseName,
        dataType,
        ...(typeof column.nullable === 'boolean' ? { nullable: column.nullable } : {}),
        ...(typeof column.comment === 'string' ? { comment: column.comment } : {}),
      }
    })
    return {
      tableName,
      ...(typeof plan.tableChineseName === 'string' && plan.tableChineseName.trim()
        ? { tableChineseName: plan.tableChineseName.trim() } : {}),
      ...(typeof plan.tableComment === 'string' && plan.tableComment.trim()
        ? { tableComment: plan.tableComment.trim() } : {}),
      columns,
    }
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
      name: 'skill_install_for_user',
      definition: defineTool({
        name: 'skill_install_for_user',
        description: 'Install one plaza skill directly into the workspaces of the listed users, optionally overwriting an existing installation of the same skill key (overwrite=true). Administrator scope only; DataOps validates every target user and the caller\'s permitted range on the call. ONLY the listed users are affected — nobody else — and the installation takes effect the next time each target opens their workspace (a running workspace may pick it up immediately). Never use this for a whole department; use department_skill_preview + department_skill_bind + department_skill_apply. Requires user approval; audited.',
        parameters: {
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          user_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'DataOps user ids (UUID strings) that should receive the skill.' },
          overwrite: { type: 'boolean', description: 'Overwrite an existing installation of the same skill key. Defaults to false, which leaves an existing installation unchanged.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number; user_ids: string[]; overwrite?: boolean }, exec) => {
          const skillId = provisioningSkillId('skill_install_for_user', args.skill_id)
          const userIds = provisioningUserIds('skill_install_for_user', args.user_ids)
          const overwrite = args.overwrite === true
          await approve(
            'skill_install_for_user',
            exec,
            'Install skill ' + skillId.toString() + ' for ' + userIds.length.toString() + ' user(s)' + (overwrite ? ' with overwrite' : ''),
          )
          const value = await call('/api/ai/skill-plaza/admin/install-for-users', {
            method: 'POST',
            body: JSON.stringify({ skillId, userIds, ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }) }),
          })
          audit('skill_install_for_user', exec, {
            skillId,
            userCount: userIds.length,
            overwrite,
            skillKey: typeof (value as { skillKey?: unknown }).skillKey === 'string' ? (value as { skillKey: string }).skillKey : null,
          })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_bind',
      definition: defineTool({
        name: 'department_skill_bind',
        description: 'Bind one plaza skill as a DEPARTMENT DEFAULT. This changes configuration only: it does NOT touch any existing user\'s workspace — run department_skill_apply to reconcile the department\'s users. The binding applies to the department and, on apply, its sub-departments; DataOps enforces the caller\'s department range. Call department_skill_preview first and show the user the affected tree and user count. Requires user approval; audited.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          enabled: { type: 'boolean', description: 'Whether the binding is active. Defaults to true.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number; enabled?: boolean }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_bind', args.department_code)
          const skillId = provisioningSkillId('department_skill_bind', args.skill_id)
          const enabled = args.enabled !== false
          await approve(
            'department_skill_bind',
            exec,
            (enabled ? 'Bind' : 'Disable') + ' skill ' + skillId.toString() + ' as a default for department ' + departmentCode,
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/bind', {
            method: 'POST',
            body: JSON.stringify({ departmentCode, skillId, enabled }),
          })
          audit('department_skill_bind', exec, { departmentCode, skillId, enabled, spread: false })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_unbind',
      definition: defineTool({
        name: 'department_skill_unbind',
        description: 'Remove one plaza skill from a DEPARTMENT\'s default bindings. This changes configuration only: existing installations remain in the users\' workspaces until the next department_skill_apply reconciles them. DataOps enforces the caller\'s department range. Call department_skill_preview first. Requires user approval; audited.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_unbind', args.department_code)
          const skillId = provisioningSkillId('department_skill_unbind', args.skill_id)
          await approve(
            'department_skill_unbind',
            exec,
            'Unbind skill ' + skillId.toString() + ' from department ' + departmentCode,
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/unbind', {
            method: 'POST',
            body: JSON.stringify({ departmentCode, skillId }),
          })
          audit('department_skill_unbind', exec, { departmentCode, skillId, spread: false })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_apply',
      definition: defineTool({
        name: 'department_skill_apply',
        description: 'Apply the department\'s CURRENT default-skill bindings to its users once: marks the affected users for reconciliation, which runs the next time each workspace starts (a running workspace may reconcile immediately). This is the step that makes earlier bind/unbind changes reach existing users. Target either a department (with optional sub-departments) or an explicit user list. Requires confirm=true plus user approval; audited. Preview the department tree and user count with department_skill_preview first, then show the user the exact scope and ask for explicit confirmation.',
        parameters: {
          department_code: { type: 'string', description: 'Department code to apply. Required unless user_ids is given.' },
          include_descendants: { type: 'boolean', description: 'Also apply to sub-departments. Defaults to true when department_code is set.' },
          user_ids: { type: 'array', items: { type: 'string' }, description: 'Explicit DataOps user ids; an alternative to department_code.' },
          confirm: { type: 'boolean', required: true, description: 'Must be true: explicitly confirms applying the current bindings to the affected users.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code?: string; include_descendants?: boolean; user_ids?: string[]; confirm: boolean }, exec) => {
          if (args.confirm !== true) throw new Error('department_skill_apply requires confirm=true')
          const departmentCode = typeof args.department_code === 'string' ? args.department_code.trim() : ''
          const userIds = args.user_ids === undefined ? [] : provisioningUserIds('department_skill_apply', args.user_ids)
          if (departmentCode === '' && userIds.length === 0) {
            throw new Error('department_skill_apply requires department_code or a non-empty user_ids list')
          }
          if (departmentCode !== '' && userIds.length > 0) {
            throw new Error('department_skill_apply accepts either department_code or user_ids, not both')
          }
          const includeDescendants = args.include_descendants !== false
          await approve(
            'department_skill_apply',
            exec,
            departmentCode !== ''
              ? 'Apply department default skills to ' + departmentCode + (includeDescendants ? ' including sub-departments' : '')
              : 'Apply department default skills to ' + userIds.length.toString() + ' user(s)',
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/apply', {
            method: 'POST',
            body: JSON.stringify({
              ...(departmentCode === '' ? {} : { departmentCode, includeDescendants }),
              ...(userIds.length === 0 ? {} : { userIds }),
            }),
          })
          audit('department_skill_apply', exec, {
            departmentCode: departmentCode === '' ? null : departmentCode,
            includeDescendants: departmentCode === '' ? null : includeDescendants,
            userCount: userIds.length,
            confirmed: true,
          })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_preview',
      definition: defineTool({
        name: 'department_skill_preview',
        description: 'Read-only preview of a department-default skill binding: the department plus its sub-departments, the affected user count, the users, and current installation/conflict details. Call this BEFORE department_skill_bind, department_skill_unbind or department_skill_apply and show the department tree, user count and overwrite/skip details to the user. It writes nothing.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_preview', args.department_code)
          const skillId = provisioningSkillId('department_skill_preview', args.skill_id)
          const query = new URLSearchParams({ departmentCode, skillId: skillId.toString() })
          const value = await call('/api/ai/skill-plaza/admin/department-skills/preview?' + query.toString())
          audit('department_skill_preview', exec, { departmentCode, skillId })
          return value as Record<string, Json>
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
    {
      name: 'dataops_collect_preview',
      definition: defineTool({
        name: 'dataops_collect_preview',
        description: 'Parse one spreadsheet attachment from the workspace and return DataOps\'s preview plus the importable database destinations. Read-only: it does not create a table and does not write rows. Use this first in the data-collection skill, then ask the user to choose the destination when more than one is returned.',
        parameters: {
          file_path: { type: 'string', required: true, description: 'Absolute or workspace-relative path to one .xlsx/.xls/.csv/.tsv file.' },
          model_id: { type: 'number', description: 'Optional shared AI model id for the later plan call.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { file_path: string; model_id?: number }, exec) => {
          const preview = await collectApi.preview(args.file_path)
          const dataSources = await collectApi.dataSources()
          audit('dataops_collect_preview', exec, {
            filePath: args.file_path,
            sessionId: preview.sessionId,
            dataSourceCount: dataSources.length,
          })
          return {
            sessionId: preview.sessionId,
            preview,
            dataSources,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_plan',
      definition: defineTool({
        name: 'dataops_collect_plan',
        description: 'Generate a create-table plan or an existing-table field mapping for a parsed spreadsheet session. Read-only: DataOps only plans, it does not execute DDL or write rows. Call this after the user has chosen a data source; pass root_schema + root_table only when appending to an existing table.',
        parameters: {
          session_id: { type: 'string', required: true, description: 'Session id returned by dataops_collect_preview.' },
          data_source_urn: { type: 'string', required: true, description: 'Destination URN from the preview result.' },
          target_schema: { type: 'string', description: 'Existing-table schema; required when root_table is set.' },
          target_table: { type: 'string', description: 'Existing table name; omit to create a new table.' },
          model_id: { type: 'number', description: 'Optional shared AI model id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { session_id: string; data_source_urn: string; target_schema?: string; target_table?: string; model_id?: number }, exec) => {
          const plan = await collectApi.plan({
            sessionId: args.session_id,
            dataSourceUrn: args.data_source_urn,
            ...(args.target_table
              ? {
                  targetTable: {
                    schema: args.target_schema || '',
                    table: args.target_table,
                  },
                }
              : {}),
            ...(args.model_id === undefined ? {} : { modelId: args.model_id }),
          })
          audit('dataops_collect_plan', exec, {
            sessionId: args.session_id,
            dataSourceUrn: args.data_source_urn,
            targetTable: args.target_table ?? null,
          })
          return plan as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_execute',
      definition: defineTool({
        name: 'dataops_collect_execute',
        description: 'Execute one confirmed spreadsheet import: create a table (or write to an existing table), insert rows, and register the DataOps resource. This is the ONLY collection tool that mutates data. Call it only after the user explicitly confirms the read-only plan in natural language (e.g. 确认/开始吧); never call it while the plan is still being edited.',
        parameters: {
          session_id: { type: 'string', required: true, description: 'Session id from dataops_collect_preview.' },
          data_source_urn: { type: 'string', required: true, description: 'Destination URN.' },
          mode: { type: 'string', required: true, description: 'CREATE_TABLE or EXISTING_TABLE.' },
          target_schema: { type: 'string', description: 'Target schema for EXISTING_TABLE.' },
          target_table: { type: 'string', description: 'Target table for EXISTING_TABLE.' },
          create_plan_json: { type: 'string', description: 'Only plan.createTable (tableName/tableChineseName/tableComment/columns). Do not send createSql/targetSchema/notes; if the user edits the table name, call dataops_collect_plan again and pass its createTable.' },
          mappings_json: { type: 'string', description: 'JSON array of {sourceKey,targetColumn} for EXISTING_TABLE.' },
          resource_name: { type: 'string', description: 'Resource display name drafted by the plan and confirmed by the user.' },
          resource_description: { type: 'string', description: 'Optional resource description.' },
          resource_tags: { type: 'array', items: { type: 'string' }, description: 'Optional resource tags.' },
          ai_visible: { type: 'boolean', description: 'Whether AI may retrieve this resource. Defaults to true.' },
          access_level: { type: 'string', description: 'PUBLIC, PROTECTED or PRIVATE. Defaults to PRIVATE.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          session_id: string
          data_source_urn: string
          mode: string
          target_schema?: string
          target_table?: string
          create_plan_json?: string
          mappings_json?: string
          resource_name?: string
          resource_description?: string
          resource_tags?: string[]
          ai_visible?: boolean
          access_level?: string
        }, exec) => {
          if (args.mode !== 'CREATE_TABLE' && args.mode !== 'EXISTING_TABLE') {
            throw new Error('dataops_collect_execute: mode must be CREATE_TABLE or EXISTING_TABLE')
          }
          const createPlan = normalizeCreatePlan(
            'dataops_collect_execute',
            parseJsonObject('dataops_collect_execute', 'create_plan_json', args.create_plan_json),
          )
          const mappings = parseJsonArray('dataops_collect_execute', 'mappings_json', args.mappings_json)
          if (args.mode === 'CREATE_TABLE' && createPlan === undefined) {
            throw new Error('dataops_collect_execute: create_plan_json is required for CREATE_TABLE')
          }
          if (args.mode === 'EXISTING_TABLE' && (!args.target_schema || !args.target_table)) {
            throw new Error('dataops_collect_execute: target_schema and target_table are required for EXISTING_TABLE')
          }
          const payload: Record<string, unknown> = {
            sessionId: args.session_id,
            dataSourceUrn: args.data_source_urn,
            mode: args.mode,
            mappings,
            ...(createPlan === undefined ? {} : { createPlan }),
            ...(args.target_schema && args.target_table
              ? { targetTable: { schema: args.target_schema, table: args.target_table } }
              : {}),
            ...(args.resource_name === undefined ? {} : { resourceName: args.resource_name }),
            ...(args.resource_description === undefined ? {} : { resourceDescription: args.resource_description }),
            ...(args.resource_tags === undefined ? {} : { resourceTags: args.resource_tags }),
            ...(args.ai_visible === undefined ? {} : { aiVisible: args.ai_visible }),
            ...(args.access_level === undefined ? {} : { accessLevel: args.access_level }),
          }
          const result = await collectApi.execute(payload)
          const resource = result.resource
          audit('dataops_collect_execute', exec, {
            sessionId: args.session_id,
            mode: args.mode,
            resourceId: resource?.id ?? null,
            importedRows: result.importedRows ?? null,
          })
          return result as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_resources',
      definition: defineTool({
        name: 'dataops_collect_resources',
        description: 'Search the current DataOps resource catalog for an append target. Read-only and scoped by DataOps resource visibility. Use it when the user chooses "追加到已有资源" instead of a remote select control.',
        parameters: {
          query: { type: 'string', description: 'Resource name, table name or URN keyword.' },
          limit: { type: 'number', description: 'Maximum rows (default 20, max 50).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { query?: string; limit?: number }) => {
          const resources = await collectApi.listResources(args.query ?? '', args.limit ?? 20)
          return { resources } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_open_resource_tab',
      definition: defineTool({
        name: 'dataops_open_resource_tab',
        description: 'Open or focus the DataOps resource tab in the right sidebar. This only navigates the browser: it does not grant access or mutate data. Use mode=focus after an import succeeds, grant for 分配权限, detail for 查看详情, and audit for 查看操作记录.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          resource_name: { type: 'string', description: 'Display name used as the tab subtitle.' },
          mode: { type: 'string', description: 'focus | grant | detail | audit. Defaults to focus.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number; resource_name?: string; mode?: string }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) {
            throw new Error('dataops_open_resource_tab: resource_id must be a positive integer')
          }
          const requested = args.mode ?? 'focus'
          const mode = requested === 'grant' || requested === 'detail' || requested === 'audit' ? requested : 'focus'
          const payload = collectHub.broadcast({
            resourceId: args.resource_id,
            resourceName: args.resource_name ?? null,
            mode,
            nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          })
          audit('dataops_open_resource_tab', exec, {
            resourceId: args.resource_id,
            mode,
            subscribers: collectHub.size(),
          })
          return {
            opened: collectHub.size() > 0,
            mode,
            resourceId: args.resource_id,
            requestId: payload.requestId,
            subscribers: collectHub.size(),
          }
        },
      }),
    },
    {
      name: 'dataops_resource_pending_list',
      definition: defineTool({
        name: 'dataops_resource_pending_list',
        description: 'List pending DataOps approval tasks and their active user tasks. Administrator only; the resource.manage connector capability must be on. Read-only.',
        parameters: {
          query: { type: 'string', description: 'Optional keyword over task title/code/requester.' },
          limit: { type: 'number', description: 'Maximum tasks (default 20, max 100).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { query?: string; limit?: number }) => {
          const limit = Math.max(1, Math.min(100, Math.round(args.limit ?? 20)))
          const tasks = await resourceManagementApi.listPendingTasks(args.query ?? '', limit)
          return {
            tasks: tasks.map((task) => ({
              id: task.id,
              code: task.code,
              title: task.title,
              status: task.status,
              requester: task.requester,
              requesterUserId: task.requesterUserId,
              workflow: task.workflow,
              userTasks: task.userTasks,
              updatedAt: task.updatedAt,
            })),
            count: tasks.length,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_list',
      definition: defineTool({
        name: 'dataops_resource_grant_list',
        description: 'List the current access grants of one DataOps resource. Administrator only; resource.manage capability must be on. Read-only.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number }) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          const grants = await resourceManagementApi.listGrants(args.resource_id)
          return { resourceId: args.resource_id, grants } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_batch',
      definition: defineTool({
        name: 'dataops_resource_grant_batch',
        description: 'Batch grant READ/MANAGE access on one DataOps resource to users, roles or departments. Administrator only; resource.manage capability must be on. The existing grants are preserved; the operation is audited by DataOps.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          application_id: { type: 'number', description: 'Application id used for the grants. Defaults to an existing grant application or the first selectable application.' },
          grants: {
            type: 'array',
            required: true,
            description: 'Targets to grant.',
            items: {
              type: 'object',
              properties: {
                targetType: { type: 'string', description: 'USER, ROLE, DEPARTMENT or APPLICATION.' },
                targetId: { type: 'string', description: 'User id, role code, department code or application id.' },
                permission: { type: 'string', description: 'READ or MANAGE. Defaults to READ.' },
                grantType: { type: 'string', description: 'REGULAR or TEMPORARY. Defaults to REGULAR.' },
                applicationId: { type: 'number', description: 'Optional per-grant application id override.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          resource_id: number
          application_id?: number
          grants: Array<{ targetType: string; targetId: string; permission?: string; grantType?: string; applicationId?: number }>
        }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          if (!Array.isArray(args.grants) || args.grants.length === 0) throw new Error('grants must be a non-empty array')
          const existing = await resourceManagementApi.listGrants(args.resource_id)
          let appId = args.application_id
          if (appId === undefined) appId = existing.map((g) => Number(g.applicationId)).find((id) => Number.isSafeInteger(id) && id > 0)
          if (appId === undefined) {
            const apps = await resourceManagementApi.listApplications()
            appId = apps.map((app) => Number(app.id)).find((id) => Number.isSafeInteger(id) && id > 0)
          }
          if (appId === undefined) throw new Error('no application is available for access grants')
          const merged = new Map<string, Record<string, unknown>>()
          for (const grant of existing) {
            const targetType = String(grant.targetType ?? '')
            const targetId = String(grant.targetId ?? '')
            if (!targetType || !targetId) continue
            const applicationId = Number(grant.applicationId) || appId
            merged.set(targetType + ':' + targetId + ':' + applicationId, {
              targetType,
              targetId,
              permission: String(grant.permission ?? 'READ'),
              grantType: String(grant.grantType ?? 'REGULAR'),
              applicationId,
            })
          }
          for (const grant of args.grants) {
            const targetType = String(grant.targetType ?? '').trim().toUpperCase()
            const targetId = String(grant.targetId ?? '').trim()
            if (!['USER', 'ROLE', 'DEPARTMENT', 'APPLICATION'].includes(targetType) || !targetId) {
              throw new Error('each grant needs targetType and targetId')
            }
            const permission = String(grant.permission ?? 'READ').trim().toUpperCase()
            if (!['READ', 'WRITE', 'MANAGE'].includes(permission)) throw new Error('permission must be READ, WRITE or MANAGE')
            const applicationId = grant.applicationId ?? appId
            merged.set(targetType + ':' + targetId + ':' + applicationId, {
              targetType,
              targetId,
              permission,
              grantType: String(grant.grantType ?? 'REGULAR').trim().toUpperCase(),
              applicationId,
            })
          }
          const grants = [...merged.values()]
          await resourceManagementApi.replaceGrants(args.resource_id, grants as never)
          audit('dataops_resource_grant_batch', exec, { resourceId: args.resource_id, count: grants.length, applicationId: appId })
          return { resourceId: args.resource_id, applicationId: appId, grants, count: grants.length } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_approval_decide',
      definition: defineTool({
        name: 'dataops_resource_approval_decide',
        description: 'Approve or reject pending DataOps user tasks in batch. Administrator only; resource.manage capability must be on. Each decision needs task_id and user_task_id; expected_version is read from the task when omitted.',
        parameters: {
          decisions: {
            type: 'array',
            required: true,
            description: 'Approval decisions.',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'number', description: 'DataOps task id.' },
                user_task_id: { type: 'string', description: 'BPMN user task UUID.' },
                decision: { type: 'string', description: 'approve or reject.' },
                comment: { type: 'string', description: 'Decision comment.' },
                expected_version: { type: 'number', description: 'Current taskVersion; read from task detail when omitted.' },
                idempotency_key: { type: 'string', description: 'Optional replay key; reuse the original key to retry a timed-out command.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          decisions: Array<{ task_id: number; user_task_id: string; decision: string; comment?: string; expected_version?: number; idempotency_key?: string }>
        }, exec) => {
          if (!Array.isArray(args.decisions) || args.decisions.length === 0) throw new Error('decisions must be a non-empty array')
          const results: Array<Record<string, unknown>> = []
          for (const decision of args.decisions) {
            const taskId = Number(decision.task_id)
            const userTaskId = String(decision.user_task_id ?? '')
            const action = String(decision.decision ?? '').toLowerCase()
            if (!Number.isSafeInteger(taskId) || taskId <= 0 || !userTaskId || (action !== 'approve' && action !== 'reject')) {
              results.push({ taskId, userTaskId, ok: false, error: 'invalid decision' })
              continue
            }
            try {
              let expectedVersion = decision.expected_version
              if (expectedVersion === undefined) {
                const task = await resourceManagementApi.getTask(taskId)
                const userTasks = Array.isArray(task.userTasks) ? task.userTasks as Array<Record<string, unknown>> : []
                const target = userTasks.find((item) => item.id === userTaskId)
                expectedVersion = typeof target?.taskVersion === 'number' ? target.taskVersion : 0
              }
              await resourceManagementApi.decideTask({
                taskId,
                userTaskId,
                decision: action,
                comment: decision.comment,
                expectedVersion,
                idempotencyKey: decision.idempotency_key,
              })
              results.push({ taskId, userTaskId, decision: action, ok: true })
            } catch (error) {
              results.push({ taskId, userTaskId, decision: action, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }
          audit('dataops_resource_approval_decide', exec, { count: results.length, ok: results.filter((item) => item.ok === true).length })
          return { results } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_revoke',
      definition: defineTool({
        name: 'dataops_resource_grant_revoke',
        description: 'Batch revoke access grants from one DataOps resource by target type and target id. Administrator only; resource.manage capability must be on. DataOps audits the resulting grant replacement.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          targets: {
            type: 'array',
            required: true,
            description: 'Targets to revoke.',
            items: {
              type: 'object',
              properties: {
                targetType: { type: 'string', description: 'USER, ROLE, DEPARTMENT or APPLICATION.' },
                targetId: { type: 'string', description: 'Target id/code.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number; targets: Array<{ targetType: string; targetId: string }> }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          if (!Array.isArray(args.targets) || args.targets.length === 0) throw new Error('targets must be a non-empty array')
          const existing = await resourceManagementApi.listGrants(args.resource_id)
          const keys = new Set(args.targets.map((target) => String(target.targetType).toUpperCase() + ':' + String(target.targetId)))
          let appId = existing.map((g) => Number(g.applicationId)).find((id) => Number.isSafeInteger(id) && id > 0)
          if (appId === undefined) {
            const apps = await resourceManagementApi.listApplications()
            appId = apps.map((app) => Number(app.id)).find((id) => Number.isSafeInteger(id) && id > 0)
          }
          if (appId === undefined) throw new Error('no application is available for access grants')
          const remaining = existing
            .filter((grant) => !keys.has(String(grant.targetType).toUpperCase() + ':' + String(grant.targetId)))
            .map((grant) => ({
              targetType: String(grant.targetType),
              targetId: String(grant.targetId),
              permission: String(grant.permission ?? 'READ'),
              grantType: String(grant.grantType ?? 'REGULAR'),
              applicationId: Number(grant.applicationId) || appId,
            }))
          const removed = existing.length - remaining.length
          if (removed === 0) throw new Error('no matching grant to revoke')
          await resourceManagementApi.replaceGrants(args.resource_id, remaining as never)
          audit('dataops_resource_grant_revoke', exec, { resourceId: args.resource_id, removed })
          return { resourceId: args.resource_id, removed, remaining, count: remaining.length } as unknown as Record<string, Json>
        },
      }),
    },
  ]

}