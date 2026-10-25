/**
 * Model tools for the skill centre and the shared review queues.
 *
 * Every tool reads the caller's DataOps role from `/api/ai/review/context` and asks DataOps on
 * every call; the Host never caches an authorization decision. Mutations require user approval
 * and write an audit line. Secret material is never a parameter and never a return value: the
 * API only sees the workspace JWT that the credential service already holds.
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
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ReviewApi } from './review-api.ts'
import { readLocalSkills } from './skill-plaza.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const open = { type: 'object', additionalProperties: true } as const
type ToolContent = { type: 'text'; text: string }
const render = (_args: unknown, value: unknown): ToolContent[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** The subset of `/api/ai/review/context` these tools decide with. */
interface ReviewScope {
  userId?: string
  username?: string
  roleCodes?: string[]
  primaryRole?: string
  departmentCode?: string
  permissions?: string[]
  permissionKeys?: string[]
  dataScope?: { all?: boolean; self?: boolean; departmentCodes?: string[] }
  review?: { canReview?: boolean; canReviewGlobal?: boolean; canManagePermissions?: boolean }
}

const roleSet = (scope: ReviewScope): Set<string> => new Set(scope.roleCodes ?? [])
const isSuper = (scope: ReviewScope): boolean => roleSet(scope).has('超级管理员') || scope.primaryRole === '超级管理员'
const isAdmin = (scope: ReviewScope): boolean => isSuper(scope) || roleSet(scope).has('管理员') || scope.primaryRole === '管理员'
const isDeptAdmin = (scope: ReviewScope): boolean => roleSet(scope).has('部门管理员') || scope.primaryRole === '部门管理员'
const canReview = (scope: ReviewScope): boolean => scope.review?.canReview === true || isAdmin(scope) || isDeptAdmin(scope)
const forbidden = (message: string): Error => new Error('Forbidden (403): ' + message)

/** Permission codes from the context, tolerating either field name during rollout. */
const permissionsOf = (scope: ReviewScope): Set<string> => new Set(scope.permissions ?? scope.permissionKeys ?? [])

/**
 * Whether the caller holds one `skill:*` capability.
 *
 * The context is the authority once it carries a permission list; before task-70 ships,
 * the role-name fallback keeps the existing four-role behavior. A present-but-empty list is
 * a denial, not a reason to fall back: an authenticated user with no keys must not inherit
 * administrator powers from their role label alone.
 */
const hasSkillPermission = (scope: ReviewScope, key: string): boolean => {
  const permissions = permissionsOf(scope)
  if (scope.permissions !== undefined || scope.permissionKeys !== undefined) return permissions.has(key)
  if (isAdmin(scope)) return true
  if (isDeptAdmin(scope)) return key !== 'skill:review:global'
  return key === 'skill:read' || key === 'skill:install' || key === 'skill:submit'
}

const requireSkillPermission = (scope: ReviewScope, key: string): void => {
  if (!hasSkillPermission(scope, key)) throw forbidden('missing permission ' + key)
}

/** Fetch and validate the caller's DataOps scope. */
async function loadScope(api: ReviewApi): Promise<ReviewScope> {
  const result = await api.request('/api/ai/review/context')
  if (result.status === 401) throw new Error('Unauthorized (401): DataOps session expired')
  if (result.status === 403) throw forbidden('no review context')
  if (result.status !== 200) throw new Error('review context failed: HTTP ' + result.status.toString())
  const body = result.body as Record<string, unknown> | null
  if (body === null || typeof body.roleCodes !== 'object' || !Array.isArray(body.roleCodes)) throw new Error('review context is missing roleCodes')
  return body as ReviewScope
}

/** Parse one plaza response body into rows without trusting its shape. */
function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  if (typeof body === 'object' && body !== null && Array.isArray((body as { skills?: unknown }).skills)) {
    return ((body as { skills: unknown[] }).skills).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  }
  return []
}

/** Register the skill-centre and review tools. */
export function registerAiManagementTools(ctx: Context, reviewApi: ReviewApi): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => { disposers.push(ctx.tools.register(tool)) }

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

  const listSkills = async (scope: ReviewScope, includeLocal: boolean): Promise<Record<string, unknown>> => {
    requireSkillPermission(scope, 'skill:read')
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
    return { catalog, canReview: canReview(scope), isAdmin: isAdmin(scope), isDepartmentAdmin: isDeptAdmin(scope), departmentCode: scope.departmentCode ?? null, skills: rows }
  }

  register(defineTool({
    name: 'skill_list',
    description: 'List skills in the DataOps skill centre: local workspace skills plus the caller\'s pending/rejected submissions and the approved plaza entries they may install. Scope follows the caller role (department admins see their department; ordinary users see their own and approved entries). Read-only.',
    parameters: {
      include_local: { type: 'boolean', description: 'Include local workspace skills (default true).' },
    },
    output: { schema: open, render },
    execute: async (args: { include_local?: boolean }) => {
      const scope = await loadScope(reviewApi)
      return listSkills(scope, args.include_local !== false) as Promise<Record<string, Json>>
    },
  }))

  register(defineTool({
    name: 'skill_get',
    description: 'Read one skill-centre entry by id: description, instruction, review status, review note, risk report and visibility. Only entries visible to the caller can be read.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Skill/plaza id from skill_list.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }) => {
      const scope = await loadScope(reviewApi)
      const listing = await listSkills(scope, false)
      const rows = listing.skills as Array<Record<string, unknown>>
      const found = rows.find(row => row.id === args.skill_id)
      if (found === undefined) throw new Error('Skill not found or not visible: ' + args.skill_id.toString())
      return found as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'skill_submit',
    description: 'Submit the caller\'s own skill for plaza review. When the workspace review switch is off DataOps approves immediately; otherwise the entry becomes pending. Requires user approval; audited.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Own skill/plaza id.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:submit')
      await approve('skill_submit', exec, 'Submit skill ' + args.skill_id.toString() + ' for review')
      const value = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/submit', { method: 'POST', body: '{}' })
      audit('skill_submit', exec, { skillId: args.skill_id })
      return value as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'skill_install',
    description: 'Install one approved, visible plaza skill into the caller\'s workspace. Requires user approval; audited. The secret-free result reports the local skill key.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:install')
      await approve('skill_install', exec, 'Install skill ' + args.skill_id.toString())
      const value = await call('/api/ai/skill-plaza/install', { method: 'POST', body: JSON.stringify({ skillId: args.skill_id }) })
      audit('skill_install', exec, { skillId: args.skill_id })
      return value as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'skill_uninstall',
    description: 'Uninstall one skill from the caller\'s own workspace only: deletes the current user\'s installation record. The plaza entry, its review status, visibility and enabled flag are unchanged and no “unpublished” notification is sent. Requires user approval; audited.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:install')
      await approve('skill_uninstall', exec, 'Uninstall skill ' + args.skill_id.toString() + ' from the current workspace')
      const result = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/install', { method: 'DELETE' }) as { uninstalled?: unknown; removed?: unknown }
      audit('skill_uninstall', exec, { skillId: args.skill_id, scope: 'installation-only', removed: result.removed ?? null })
      return { uninstalled: result.uninstalled === true, removed: typeof result.removed === 'number' ? result.removed : 0 }
    },
  }))

  const setEnabled = (enabled: boolean) => defineTool({
    name: enabled ? 'skill_enable' : 'skill_disable',
    description: (enabled ? 'Enable' : 'Disable') + ' one plaza skill for distribution. Administrator only. Requires user approval; audited.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:manage')
      await approve(enabled ? 'skill_enable' : 'skill_disable', exec, (enabled ? 'Enable' : 'Disable') + ' skill ' + args.skill_id.toString())
      await call('/api/ai/skill-plaza/admin/skills/' + args.skill_id.toString() + '/status', { method: 'PATCH', body: JSON.stringify({ enabled }) })
      audit(enabled ? 'skill_enable' : 'skill_disable', exec, { skillId: args.skill_id, enabled })
      return { skillId: args.skill_id, enabled }
    },
  })
  register(setEnabled(true))
  register(setEnabled(false))

  register(defineTool({
    name: 'skill_unshare',
    description: 'Stop sharing one plaza skill (soft unpublish): the entry and its installations remain, review status/visibility are kept, and DataOps sends an “unpublished” notification. Owners may unshare their own entries; 超级管理员/管理员 any entry; 部门管理员 their department. Requires user approval; audited.',
    parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
    output: { schema: open, render },
    execute: async (args: { skill_id: number }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:manage')
      if (!isAdmin(scope) && !isDeptAdmin(scope)) {
        const listing = await listSkills(scope, false)
        const found = (listing.skills as Array<Record<string, unknown>>).find(row => row.id === args.skill_id)
        if (found === undefined || found.sharedByMe !== true) throw forbidden('only the owner or an administrator may unshare this skill')
      }
      await approve('skill_unshare', exec, 'Unshare skill ' + args.skill_id.toString())
      await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString(), { method: 'DELETE' })
      audit('skill_unshare', exec, { skillId: args.skill_id, effect: 'soft-unpublish' })
      return { unshared: args.skill_id, effect: 'plaza-sharing-disabled' }
    },
  }))

  register(defineTool({
    name: 'skill_delete',
    description: 'Permanently delete one plaza skill. This is not unshare: the record is removed, DataOps sends a “deleted” notification (not “unpublished”), and the audit entry records the permanent action. Requires confirm=true as a second confirmation; owners may delete their own entries, 超级管理员/管理员 any entry, 部门管理员 their department. If installations still exist the backend returns 409 and the error is passed through. Requires user approval; audited.',
    parameters: {
      skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true: explicitly confirms permanent deletion.' },
    },
    output: { schema: open, render },
    execute: async (args: { skill_id: number; confirm: boolean }, exec) => {
      if (args.confirm !== true) throw new Error('skill_delete requires confirm=true (permanent deletion)')
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:manage')
      if (!isAdmin(scope) && !isDeptAdmin(scope)) {
        const listing = await listSkills(scope, false)
        const found = (listing.skills as Array<Record<string, unknown>>).find(row => row.id === args.skill_id)
        if (found === undefined || found.sharedByMe !== true) throw forbidden('only the owner or an administrator may delete this skill')
      }
      await approve('skill_delete', exec, 'Permanently delete skill ' + args.skill_id.toString())
      await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/permanent', { method: 'DELETE' })
      audit('skill_delete', exec, { skillId: args.skill_id, permanent: true })
      return { deleted: args.skill_id, permanent: true }
    },
  }))

  register(defineTool({
    name: 'review_scan',
    description: 'Run the DataOps AI risk scan for skill and/or workflow ids. Reviewers only (超级管理员/管理员/部门管理员 with review capability); ordinary users receive 403. Read-only.',
    parameters: {
      skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids to scan.' },
      workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids to scan.' },
    },
    output: { schema: open, render },
    execute: async (args: { skills?: number[]; workflows?: string[] }) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:read')
      if (!canReview(scope)) throw forbidden('the current role cannot review')
      return await call('/api/ai/review/scan', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [] }) }) as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'review_decide',
    description: 'Approve or reject skills/workflows. Requires authorization.confirmed=true (the administrator explicitly confirmed), reviewer role and department scope; requires a second user approval at tool level and writes an audit entry. Ordinary users receive 403.',
    parameters: {
      skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids.' },
      workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids.' },
      decision: { type: 'string', required: true, description: 'approve or reject.' },
      note: { type: 'string', description: 'Review note (max 2000 chars).' },
      confirmed: { type: 'boolean', required: true, description: 'Must be true: the administrator confirmed this decision.' },
    },
    output: { schema: open, render },
    execute: async (args: { skills?: number[]; workflows?: string[]; decision: string; note?: string; confirmed: boolean }, exec) => {
      const scope = await loadScope(reviewApi)
      requireSkillPermission(scope, 'skill:review:decide')
      if (!canReview(scope)) throw forbidden('the current role cannot review')
      if (args.confirmed !== true) throw new Error('authorization.confirmed=true is required for review_decide')
      if (args.decision !== 'approve' && args.decision !== 'reject') throw new Error('decision must be approve or reject')
      if ((args.skills ?? []).length === 0 && (args.workflows ?? []).length === 0) throw new Error('at least one skill or workflow id is required')
      if (!isAdmin(scope) && isDeptAdmin(scope)) {
        const listing = await listSkills(scope, false)
        const rows = listing.skills as Array<Record<string, unknown>>
        const allowed = new Set(scope.dataScope?.departmentCodes ?? (scope.departmentCode === undefined ? [] : [scope.departmentCode]))
        for (const id of args.skills ?? []) {
          const row = rows.find(item => item.id === id)
          if (row !== undefined && (row.departmentCode === null || row.departmentCode === undefined)) {
            requireSkillPermission(scope, 'skill:review:global')
          }
          if (row !== undefined && row.departmentCode !== null && row.departmentCode !== undefined && !allowed.has(String(row.departmentCode))) {
            throw forbidden('department administrators may only review their own department')
          }
        }
      }
      await approve('review_decide', exec, 'Review ' + args.decision + ' for ' + (args.skills ?? []).length.toString() + ' skill(s) / ' + (args.workflows ?? []).length.toString() + ' workflow(s)')
      const value = await call('/api/ai/review/decide', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [], decision: args.decision, note: args.note ?? '', authorization: { confirmed: true } }) })
      audit('review_decide', exec, { decision: args.decision, skills: args.skills ?? [], workflows: args.workflows ?? [], confirmed: true })
      return value as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'review_notifications_list',
    description: 'List the caller\'s review notifications and unread count. Read-only and always scoped to the current DataOps user.',
    parameters: {
      unread_only: { type: 'boolean', description: 'Only unread notifications.' },
      limit: { type: 'number', description: 'Maximum rows (default 20).' },
    },
    output: { schema: open, render },
    execute: async (args: { unread_only?: boolean; limit?: number }) => {
      await loadScope(reviewApi)
      const query = new URLSearchParams({ unreadOnly: args.unread_only === true ? 'true' : 'false', limit: String(args.limit ?? 20) })
      return await call('/api/ai/review-notifications?' + query.toString()) as Record<string, Json>
    },
  }))

  register(defineTool({
    name: 'review_notifications_read',
    description: 'Mark the caller\'s review notifications as read, either selected ids or all. Scoped to the current DataOps user; no secret is involved.',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Notification ids to mark read.' },
      all: { type: 'boolean', description: 'Mark every notification read.' },
    },
    output: { schema: open, render },
    execute: async (args: { ids?: string[]; all?: boolean }, exec) => {
      await loadScope(reviewApi)
      const value = await call('/api/ai/review-notifications/read', { method: 'POST', body: JSON.stringify({ ids: args.ids ?? [], all: args.all === true }) })
      audit('review_notifications_read', exec, { count: args.ids?.length ?? 0, all: args.all === true })
      return value as Record<string, Json>
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
