import { describe, expect, it, vi } from 'vitest'
import { registerAiManagementTools } from '../src/tools.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

function setup(context: Record<string, unknown>, options: { outcome?: string; routes?: Record<string, unknown> } = {}) {
  const tools = new Map<string, Tool>()
  const approvals: Array<{ toolName: string; reason: string }> = []
  const audits: string[] = []
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const routes: Record<string, unknown> = {
    '/api/ai/review/context': { status: 200, body: context },
    '/api/ai/skill-plaza/skills?scope=mine': { status: 200, body: [{ id: 1, name: 'mine', reviewStatus: 'pending', sharedByMe: true, departmentCode: 'd1' }] },
    '/api/ai/skill-plaza/skills': { status: 200, body: [{ id: 2, name: 'public', reviewStatus: 'approved', sharedByMe: false, departmentCode: 'd1' }] },
    '/api/ai/skill-plaza/admin/skills': { status: 200, body: { skills: [{ id: 1, name: 'mine', reviewStatus: 'pending', enabled: false, sharedByMe: true, departmentCode: 'd1' }] } },
    '/api/ai/review-notifications?unreadOnly=true&limit=5': { status: 200, body: { items: [{ id: 'n1', read: false }], unread: 1 } },
    '/api/ai/review/decide': { status: 200, body: { decided: true } },
    '/api/ai/review/scan': { status: 200, body: { risk: 'low' } },
    '/api/ai/skill-plaza/skills/16/install': { status: 200, body: { uninstalled: true, removed: 1 } },
    '/api/ai/skill-plaza/skills/16': { status: 200, body: { success: true } },
    '/api/ai/skill-plaza/skills/16/permanent': { status: 200, body: { deleted: true } },
    ...options.routes,
  }
  const api = {
    request: async (path: string, init: RequestInit = {}) => {
      calls.push({ path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      return routes[path] ?? { status: 404, body: { error: 'not found' } }
    },
  }
  const ctx = {
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } },
    approval: { request: async (input: { toolName: string; reason: string }) => { approvals.push(input); return options.outcome ?? 'allowed-once' } },
    logger: { info: (line: string) => { audits.push(line) }, error: () => {} },
  }
  registerAiManagementTools(ctx as never, api as never)
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: new AbortController().signal }
  return { tools, approvals, audits, calls, exec }
}

const ORDINARY = { userId: 'u1', roleCodes: ['普通用户'], primaryRole: '普通用户', departmentCode: 'd1', review: { canReview: false } }
const ADMIN = { userId: 'a1', roleCodes: ['管理员'], primaryRole: '管理员', departmentCode: 'd1', review: { canReview: true, canReviewGlobal: true } }
const DEPT = { userId: 'd1', roleCodes: ['部门管理员'], primaryRole: '部门管理员', departmentCode: 'd1', dataScope: { departmentCodes: ['d1'] }, review: { canReview: true } }

describe('skill catalogue scope', () => {
  it('merges own pending rows with approved public rows for an ordinary user', async () => {
    const f = setup(ORDINARY)
    const value = await f.tools.get('skill_list')!.execute({ include_local: false }, f.exec) as { catalog: { pending: unknown[]; approved: unknown[] }; isAdmin: boolean }
    expect(value.catalog.pending).toHaveLength(1)
    expect(value.catalog.approved).toHaveLength(1)
    expect(value.isAdmin).toBe(false)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/admin/skills')).toBe(false)
  })

  it('reads the admin catalogue for an administrator', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_list')!.execute({ include_local: false }, f.exec) as { isAdmin: boolean }
    expect(value.isAdmin).toBe(true)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/admin/skills')).toBe(true)
  })
})

describe('write gates', () => {
  it('refuses skill_enable when the context carries no skill:manage key', async () => {
    const f = setup({ ...DEPT, permissions: ['skill:read'] })
    await expect(f.tools.get('skill_enable')!.execute({ skill_id: 1 }, f.exec)).rejects.toThrow(/403/)
    expect(f.approvals).toHaveLength(0)
  })

  it('requires authorization.confirmed=true for review_decide', async () => {
    const f = setup(ADMIN)
    await expect(f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: false }, f.exec)).rejects.toThrow(/confirmed=true/)
    expect(f.approvals).toHaveLength(0)
    expect(f.calls.some(call => call.path === '/api/ai/review/decide')).toBe(false)
  })

  it('refuses review_decide for an ordinary user', async () => {
    const f = setup(ORDINARY)
    await expect(f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true }, f.exec)).rejects.toThrow(/403/)
  })

  it('stops before DataOps when the user denies approval', async () => {
    const f = setup(ADMIN, { outcome: 'denied' })
    await expect(f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true }, f.exec)).rejects.toThrow(/approval was denied/)
    expect(f.calls.some(call => call.path === '/api/ai/review/decide')).toBe(false)
  })

  it('audits a successful decision without any secret', async () => {
    const f = setup(ADMIN)
    await f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true, note: 'ok' }, f.exec)
    expect(f.approvals).toHaveLength(1)
    expect(f.audits[0]).toContain('review_decide')
    expect(f.audits[0]).not.toMatch(/password|token|secret/i)
  })
})

describe('notifications and scan', () => {
  it('passes unread_only and limit to the notification endpoint', async () => {
    const f = setup(ORDINARY)
    const value = await f.tools.get('review_notifications_list')!.execute({ unread_only: true, limit: 5 }, f.exec) as { unread: number }
    expect(value.unread).toBe(1)
    expect(f.calls.some(call => call.path.includes('unreadOnly=true'))).toBe(true)
  })

  it('refuses review_scan for an ordinary user', async () => {
    const f = setup(ORDINARY)
    await expect(f.tools.get('review_scan')!.execute({ skills: [1] }, f.exec)).rejects.toThrow(/403/)
  })
})

describe('uninstall / unshare / delete semantics', () => {
  it('uninstall only removes the caller installation and never touches the plaza entry', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_uninstall')!.execute({ skill_id: 16 }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ uninstalled: true, removed: 1 })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16/install' && call.method === 'DELETE')).toBe(true)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16' && call.method === 'DELETE')).toBe(false)
  })

  it('unshare soft-unpublishes the entry', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_unshare')!.execute({ skill_id: 16 }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ unshared: 16, effect: 'plaza-sharing-disabled' })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16' && call.method === 'DELETE')).toBe(true)
  })

  it('delete needs confirm=true and calls the permanent endpoint', async () => {
    const f = setup(ADMIN)
    await expect(f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: false }, f.exec)).rejects.toThrow(/confirm=true/)
    expect(f.calls.some(call => call.path.endsWith('/permanent'))).toBe(false)
    const value = await f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: true }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ deleted: 16, permanent: true })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16/permanent' && call.method === 'DELETE')).toBe(true)
    expect(f.audits.some(line => line.includes('"permanent":true'))).toBe(true)
  })

  it('passes a 409 conflict through with the backend reason', async () => {
    const f = setup(ADMIN, { routes: { '/api/ai/skill-plaza/skills/16/permanent': { status: 409, body: { error: 'skill still has 2 installations' } } } })
    await expect(f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: true }, f.exec)).rejects.toThrow(/Conflict \(409\).*installations/)
  })
})

describe('skill:* permission enforcement', () => {
  it('denies a role whose context carries a permission list without the key', async () => {
    const f = setup({ ...ADMIN, permissions: [] })
    await expect(f.tools.get('skill_list')!.execute({ include_local: false }, f.exec)).rejects.toThrow(/skill:read/)
  })

  it('denies skill_enable without skill:manage even for a department administrator', async () => {
    const f = setup({ ...DEPT, permissions: ['skill:read', 'skill:review:decide'] })
    await expect(f.tools.get('skill_enable')!.execute({ skill_id: 16 }, f.exec)).rejects.toThrow(/skill:manage/)
  })

  it('requires skill:review:global to decide a global skill', async () => {
    const f = setup({ ...DEPT, permissions: ['skill:read', 'skill:review:decide'] }, { routes: {
      '/api/ai/skill-plaza/skills?scope=mine': { status: 200, body: [{ id: 16, name: 'global', reviewStatus: 'pending', departmentCode: null, sharedByMe: false }] },
      '/api/ai/skill-plaza/skills': { status: 200, body: [] },
    } })
    await expect(f.tools.get('review_decide')!.execute({ skills: [16], decision: 'approve', confirmed: true }, f.exec)).rejects.toThrow(/skill:review:global/)
  })

  it('allows a global reviewer with skill:review:global', async () => {
    const f = setup({ ...ADMIN, permissions: ['skill:read', 'skill:review:decide', 'skill:review:global'] })
    const value = await f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ decided: true })
  })
})
