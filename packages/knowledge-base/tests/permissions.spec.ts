import { describe, expect, it } from 'vitest'
import {
  ACTION_LABELS,
  BUILT_IN_ROLES,
  CONCRETE_ACTIONS,
  DEPARTMENT_ADMIN_ROLE,
  KNOWLEDGE_ACTIONS,
  SUPER_ADMIN_ROLE,
  builtInRoleActionsOn,
  builtInRoleCoversPath,
  builtInRoleOf,
  collapseActions,
  coversActions,
  dataOpsActionsToPermissions,
  decideRoleAction,
  departmentScopeOf,
  expandActions,
  isBuiltInRole,
  isKnowledgeAction,
  permissionToDataOpsActions,
} from '../src/permissions.ts'
import {
  groupHoldingsByPrincipal,
  groupHoldingsByResource,
  summarizeActions,
} from '../src/client/KnowledgePermissionOverview.tsx'
import { buildRoleSummaries } from '../src/client/roleSummary.ts'

describe('the five knowledge permissions', () => {
  it('names exactly four concrete actions plus the union', () => {
    expect([...CONCRETE_ACTIONS]).toEqual(['read', 'create', 'update', 'delete'])
    expect([...KNOWLEDGE_ACTIONS]).toEqual(['read', 'create', 'update', 'delete', 'all'])
  })

  it('expands all into the four concrete actions, in a fixed order', () => {
    // The order matters: two callers holding the same privileges must produce the
    // same list, or comparing permissions would depend on input order.
    expect(expandActions(['all'])).toEqual(['read', 'create', 'update', 'delete'])
    expect(expandActions(['delete', 'read'])).toEqual(['read', 'delete'])
    expect(expandActions([])).toEqual([])
  })

  it('collapses a full house back to all and leaves a partial set explicit', () => {
    expect(collapseActions(['read', 'create', 'update', 'delete'])).toEqual(['all'])
    // Three of four is NOT all: showing `all` here would claim a privilege the
    // grant does not hold.
    expect(collapseActions(['read', 'create', 'update'])).toEqual(['read', 'create', 'update'])
    expect(collapseActions(['all'])).toEqual(['all'])
  })

  it('answers coverage from the held set, expanding both sides', () => {
    expect(coversActions(['all'], ['delete'])).toBe(true)
    expect(coversActions(['read'], ['read', 'delete'])).toBe(false)
    expect(coversActions(['read', 'delete'], ['read'])).toBe(true)
  })

  it('rejects a value that is not an action', () => {
    expect(isKnowledgeAction('read')).toBe(true)
    expect(isKnowledgeAction('all')).toBe(true)
    expect(isKnowledgeAction('manage')).toBe(false)
    expect(isKnowledgeAction(undefined)).toBe(false)
  })

  it('labels every action in both languages', () => {
    for (const action of KNOWLEDGE_ACTIONS) {
      expect(ACTION_LABELS[action].zh).not.toBe('')
      expect(ACTION_LABELS[action].en).not.toBe('')
    }
    expect(ACTION_LABELS.read.zh).toBe('查')
    expect(ACTION_LABELS.delete.zh).toBe('删')
    expect(ACTION_LABELS.all.zh).toBe('全部')
  })
})

describe('translating between product permissions and DataOps actions', () => {
  it('asks DataOps for the narrowest action that satisfies each permission', () => {
    expect(permissionToDataOpsActions('read')).toEqual(['read'])
    // DataOps has one `write` covering both creating and editing.
    expect(permissionToDataOpsActions('create')).toEqual(['write'])
    expect(permissionToDataOpsActions('update')).toEqual(['write'])
    expect(permissionToDataOpsActions('delete')).toEqual(['delete'])
    // One `manage`, not four grants: DataOps expands it, and four grants could
    // leave a half-applied state.
    expect(permissionToDataOpsActions('all')).toEqual(['manage'])
  })

  it('narrows DataOps actions into the permissions they actually justify', () => {
    expect(dataOpsActionsToPermissions(['read'])).toEqual(['read'])
    expect(dataOpsActionsToPermissions(['write'])).toEqual(['create', 'update'])
    expect(dataOpsActionsToPermissions(['manage'])).toEqual(['all'])
    expect(dataOpsActionsToPermissions(['read', 'delete'])).toEqual(['read', 'delete'])
  })

  it('ignores platform actions this plugin cannot enforce', () => {
    // `comment` and `share` would otherwise publish a permission with no effect.
    expect(dataOpsActionsToPermissions(['comment', 'share', 'audit'])).toEqual([])
    expect(dataOpsActionsToPermissions(['space_manage_page', 'page_write'])).toEqual([])
    expect(dataOpsActionsToPermissions([])).toEqual([])
  })
})

describe('built-in roles', () => {
  it('ships two roles, neither removable', () => {
    expect(BUILT_IN_ROLES.map(role => role.id)).toEqual([SUPER_ADMIN_ROLE, DEPARTMENT_ADMIN_ROLE])
    for (const role of BUILT_IN_ROLES) expect(role.removable).toBe(false)
    expect(isBuiltInRole(SUPER_ADMIN_ROLE)).toBe(true)
    expect(isBuiltInRole('some-custom-role')).toBe(false)
  })

  it('cannot be reached by a DataOps role of the same-ish name', () => {
    // The prefix is what keeps a platform role called `admin` from inheriting the
    // knowledge base's own super administrator.
    expect(builtInRoleOf('admin')).toBeUndefined()
    expect(builtInRoleOf('super-admin')).toBeUndefined()
  })

  it('lets the super administrator cover every path', () => {
    expect(builtInRoleCoversPath(SUPER_ADMIN_ROLE, 'global/制度.md', undefined)).toBe(true)
    expect(builtInRoleCoversPath(SUPER_ADMIN_ROLE, 'department/OPS/值班表.md', 'DEV')).toBe(true)
    expect(builtInRoleActionsOn(SUPER_ADMIN_ROLE, 'personal/u-1/笔记.md', undefined))
      .toEqual(['read', 'create', 'update', 'delete'])
  })

  it('limits the department administrator to its own department', () => {
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/值班表.md', 'OPS')).toBe(true)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/2026/计划.md', 'OPS')).toBe(true)
    // A prefix match would leak OPS2 into OPS's scope; the trailing slash in the
    // scope is what prevents it.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS2/计划.md', 'OPS')).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/DEV/计划.md', 'OPS')).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'global/制度.md', 'OPS')).toBe(false)
  })

  it('gives the department administrator the department bucket itself', () => {
    // Managing a folder includes managing the folder, not only its documents.
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department', 'OPS')).toBe(true)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS', 'OPS')).toBe(true)
  })

  it('covers nothing for a department administrator with no department', () => {
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', undefined)).toBe(false)
    expect(builtInRoleCoversPath(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', '')).toBe(false)
    expect(builtInRoleActionsOn(DEPARTMENT_ADMIN_ROLE, 'department/OPS/x.md', undefined)).toEqual([])
  })

  it('builds a department scope only from a real code', () => {
    expect(departmentScopeOf('OPS')).toBe('department/OPS/')
    expect(departmentScopeOf(undefined)).toBeUndefined()
    expect(departmentScopeOf('  ')).toBeUndefined()
  })
})

describe('deciding one role action with an explanation', () => {
  it('allows what the role covers', () => {
    const decision = decideRoleAction(SUPER_ADMIN_ROLE, 'global/制度.md', 'delete', undefined)
    expect(decision.covered).toBe(true)
    expect(decision.actions).toEqual(['read', 'create', 'update', 'delete'])
    expect(decision.reason).toBeUndefined()
  })

  it('names a path outside the department as the reason, not just "denied"', () => {
    const decision = decideRoleAction(DEPARTMENT_ADMIN_ROLE, 'department/DEV/x.md', 'read', 'OPS')
    expect(decision.covered).toBe(false)
    expect(decision.reason).toContain('OPS')
  })

  it('separates an unknown role from a permission problem', () => {
    // A stale screen and a permission request need different fixes, so they must
    // not read the same.
    const unknown = decideRoleAction('not-a-role', 'global/x.md', 'read', undefined)
    expect(unknown.reason).toContain('unknown role')
    const outside = decideRoleAction(DEPARTMENT_ADMIN_ROLE, 'global/x.md', 'read', 'OPS')
    expect(outside.reason).not.toContain('unknown role')
  })
})

describe('permission overview grouping', () => {
  it('summarizes a full house as all and a partial set explicitly', () => {
    expect(summarizeActions(['read', 'create', 'update', 'delete'])).toEqual(['all'])
    expect(summarizeActions(['all'])).toEqual(['all'])
    // Three of four is not all: claiming it would overstate the grant.
    expect(summarizeActions(['read', 'create', 'update'])).toEqual(['read', 'create', 'update'])
    expect(summarizeActions([])).toEqual([])
  })

  it('groups one person into one row even across several grants', () => {
    // "What does 张三 have" is a question about a person; splitting them per path
    // would answer it wrong.
    const people = groupHoldingsByPrincipal([
      { id: '1', relPath: 'global/a.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'global/b.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'write', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ], { 'user:u-1': '张三' })
    expect(people).toHaveLength(1)
    expect(people[0]?.label).toBe('张三')
    expect(people[0]?.paths).toEqual(['global/a.md', 'global/b.md'])
  })

  it('groups one resource with everyone who reaches it', () => {
    const resources = groupHoldingsByResource([
      { id: '1', relPath: 'global/a.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'global/a.md', kind: 'file', principalType: 'role', principalId: 'knowledge-dept-admin', action: 'manage', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ], { 'user:u-1': '张三', 'role:knowledge-dept-admin': '部门管理员' })
    expect(resources).toHaveLength(1)
    expect(resources[0]?.principals.map(p => p.label)).toEqual(['张三', '部门管理员'].sort())
  })

  it('reads roles out of role grants only, built-ins first', () => {
    const roles = buildRoleSummaries([
      { id: '1', relPath: 'global', kind: 'directory', principalType: 'role', principalId: 'knowledge-super-admin', action: 'manage', grantedBy: 'admin', grantedAt: '2026-01-01' },
      { id: '2', relPath: 'department/OPS', kind: 'directory', principalType: 'role', principalId: 'custom-role', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
      // A user grant is not a role; inventing one per user would flood the list.
      { id: '3', relPath: 'global/x.md', kind: 'file', principalType: 'user', principalId: 'u-1', action: 'read', grantedBy: 'admin', grantedAt: '2026-01-01' },
    ])
    expect(roles.map(r => r.id)).toEqual(['knowledge-super-admin', 'custom-role'])
    expect(roles[0]?.label).toBe('超级管理员')
    expect(roles[0]?.builtIn).toBe(true)
    expect(roles[1]?.builtIn).toBe(false)
  })
})
