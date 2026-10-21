/**
 * The pure half of the permissions overview: how one grant table reads two ways.
 *
 * Kept apart from the rendering module for a real reason, not for tidiness: a
 * component module imports the primitives package, which imports CSS, and a Node
 * test runner cannot load a `.css` file. The grouping rules are the part worth
 * testing without a DOM, so they live somewhere a plain import can reach.
 *
 * @module @sparkelf/dsh-knowledge-base/client/permissionRows
 */

import type { GrantView, KnowledgeGrantSubjectType } from '../api.ts'

/** One person's holdings, as the person view renders them. */
export interface PersonHoldings {
  /** Principal id the grants name. */
  principalId: string
  /** Principal kind, so the type column can name it. */
  principalType: KnowledgeGrantSubjectType
  /** Display name when a directory entry resolved one, else the id. */
  label: string
  /** Distinct paths this person may touch. */
  paths: string[]
  /** Which actions the person holds, collapsed so a full house reads `all`. */
  actions: string[]
  /**
   * Roles the person reaches through a `role` grant they belong to.
   *
   * Empty when the directory does not know the membership: a role grant names the
   * ROLE, not the people in it, so this is only populated when a directory entry
   * declared the membership.
   */
  roles: string[]
  /** Most recent grant instant across this person's rows, ISO-8601. */
  latestAt: string
  /** The grants this row covers, so a revoke can name exactly what it removes. */
  grants: GrantView[]
}

/** One resource and everyone who may reach it. */
export interface ResourceHoldings {
  /** Path, relative to the mount point. */
  relPath: string
  /** Whether it is a file or a directory. */
  kind: 'file' | 'directory'
  /** Everyone holding any action on it, grouped by principal kind. */
  principals: Array<{
    principalType: KnowledgeGrantSubjectType
    principalId: string
    label: string
    actions: string[]
    latestAt: string
    grants: GrantView[]
  }>
}

/**
 * Actions in the order the product shows them.
 *
 * These are the words DataOps stores, lowercased by its grant summary: `read`,
 * `write`, `manage`. They are NOT the words of the create/edit form (`create`,
 * `update`, `delete`), which describe an operation the reader performs rather than a
 * level held on a resource.
 *
 * Mixing the two vocabularies is a real defect that shipped: the summariser filtered
 * against `create`/`update`/`delete`, so every `write` and `manage` grant was dropped
 * and an administrator holding read+write+manage displayed as "read only". A reader
 * who can actually upload and move documents was told they could not. Keep this list
 * aligned with `ResourcePermissionAction` in the backend, not with the form.
 */
const ACTION_ORDER = ['read', 'write', 'manage'] as const

/**
 * The result of reading a set of grants as permissions.
 *
 * `known: false` carries a reason rather than an empty list, because "we could not
 * work this out" and "this principal holds nothing" must not render the same way: the
 * first is a fault the reader should see, and collapsing it into an empty set is how a
 * denial gets invented. See {@link resolveActions}.
 */
export interface ResolvedActions {
  /** Actions held, in display order. Empty when `known` is false. */
  actions: string[]
  /**
   * Whether the full set could be determined.
   *
   * False when part of the input could not be read -- an inheritance path that was
   * unavailable, or a grant whose action is a word this build does not know.
   */
  known: boolean
  /** Why the set is incomplete, when it is. Shown to the reader beside the actions. */
  reason?: string
}

/**
 * Union a principal's grants into the permission set it actually holds.
 *
 * UNION, never intersection and never "the first row": a principal reaches a resource
 * through several grants (a direct one and one inherited from each role), and what
 * they may do is everything any of those grants allows. Reading one row is what made
 * an administrator display as read-only.
 *
 * An unrecognised action word makes the whole answer unknown rather than being
 * skipped. Skipping it would under-report, and under-reporting a permission is the
 * direction that misleads an operator into thinking access is safe to ignore.
 *
 * @param actions - every action string from every grant reaching this principal.
 * @returns The unioned set, or an explicit unknown with the reason.
 */
export function resolveActions(actions: readonly string[]): ResolvedActions {
  const held = new Set<string>()
  const unknownWords: string[] = []
  for (const raw of actions) {
    const action = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (action === '') continue
    if ((ACTION_ORDER as readonly string[]).includes(action)) {
      held.add(action)
      continue
    }
    // `all` was the old collapsing word for a full house. Honour it rather than
    // treating it as unrecognised: an older grant row may still carry it.
    if (action === 'all') {
      for (const actionWord of ACTION_ORDER) held.add(actionWord)
      continue
    }
    unknownWords.push(action)
  }
  if (unknownWords.length > 0) {
    return {
      actions: ACTION_ORDER.filter(action => held.has(action)),
      known: false,
      reason: 'unrecognised permission ' + JSON.stringify(unknownWords[0]),
    }
  }
  return { actions: ACTION_ORDER.filter(action => held.has(action)), known: true }
}

/**
 * Whether a resolved set confers the ability to change a document.
 *
 * Used by the page to check itself against what the reader can actually do. `manage`
 * implies write in this model: it is the full-control level, and a principal holding
 * it can move and delete.
 * @param resolved - the unioned permission set.
 * @returns true when writing is possible, or unknown.
 */
export function canWriteWith(resolved: ResolvedActions): boolean | undefined {
  if (!resolved.known) return undefined
  return resolved.actions.includes('write') || resolved.actions.includes('manage')
}

/**
 * Collapse a set of action strings into the shortest describing list.
 *
 * A thin view over {@link resolveActions} so there is ONE vocabulary and ONE union
 * rule in the browser: this used to be a second implementation filtering on
 * `create`/`update`/`delete`, which silently dropped every `write` and `manage` grant.
 *
 * Kept as an exported name because the older callers and their tests use it.
 * @param actions - raw action strings from grants.
 * @returns The unioned actions in display order; unknown words are dropped here,
 *   which is why a surface that must not under-report calls {@link resolveActions}.
 */
export function summarizeActions(actions: readonly string[]): string[] {
  return resolveActions(actions).actions
}

/**
 * The newest `grantedAt` across a set of grants.
 *
 * Compared as instants rather than as strings: an ISO-8601 string sorts
 * lexicographically only while every value carries the same offset, which the
 * backend does not promise. A value that will not parse keeps the running answer
 * instead of poisoning it.
 *
 * @param grants - the grants whose instants to compare.
 * @returns the newest ISO-8601 instant, or the first raw value when none parse.
 */
function latestGrantedAt(grants: readonly GrantView[]): string {
  let best = ''
  let bestMs = Number.NEGATIVE_INFINITY
  for (const grant of grants) {
    const ms = new Date(grant.grantedAt).getTime()
    if (Number.isNaN(ms)) {
      if (best === '') best = grant.grantedAt
      continue
    }
    if (ms > bestMs) {
      bestMs = ms
      best = grant.grantedAt
    }
  }
  return best
}

/**
 * Group grants by the principal they name.
 *
 * A principal appearing in several grants is one row: "what does 张三 have" is a
 * question about a person, and splitting them across rows because they hold two
 * paths would answer it wrong.
 *
 * @param grants - the grant table.
 * @param labels - display names by `principalType:principalId`, optional.
 * @returns one entry per principal, ordered by label then id.
 */
export function groupHoldingsByPrincipal(
  grants: readonly GrantView[],
  labels: Readonly<Record<string, string>> = {},
): PersonHoldings[] {
  const byPrincipal = new Map<string, {
    type: KnowledgeGrantSubjectType
    id: string
    paths: Set<string>
    actions: Set<string>
    roles: Set<string>
    grants: GrantView[]
  }>()
  for (const grant of grants) {
    const key = grant.principalType + ':' + grant.principalId
    let entry = byPrincipal.get(key)
    if (entry === undefined) {
      entry = { type: grant.principalType, id: grant.principalId, paths: new Set(), actions: new Set(), roles: new Set(), grants: [] }
      byPrincipal.set(key, entry)
    }
    entry.paths.add(grant.relPath)
    entry.actions.add(grant.action)
    entry.grants.push(grant)
    // A role grant names the role; the people in it are a directory fact this view
    // can only report when the caller supplied one.
    if (grant.principalType === 'role') entry.roles.add(grant.principalId)
  }
  return [...byPrincipal.values()]
    .map((entry) => {
      const key = entry.type + ':' + entry.id
      return {
        principalId: entry.id,
        principalType: entry.type,
        label: labels[key] ?? entry.id,
        paths: [...entry.paths].sort(),
        actions: summarizeActions([...entry.actions]),
        roles: [...entry.roles].sort(),
        latestAt: latestGrantedAt(entry.grants),
        grants: entry.grants,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Group grants by the resource they cover.
 *
 * @param grants - the grant table.
 * @param labels - display names by `principalType:principalId`, optional.
 * @returns one entry per path, ordered by path.
 */
export function groupHoldingsByResource(
  grants: readonly GrantView[],
  labels: Readonly<Record<string, string>> = {},
): ResourceHoldings[] {
  const byPath = new Map<string, {
    kind: 'file' | 'directory'
    holders: Map<string, {
      type: KnowledgeGrantSubjectType
      id: string
      actions: Set<string>
      grants: GrantView[]
    }>
  }>()
  for (const grant of grants) {
    let entry = byPath.get(grant.relPath)
    if (entry === undefined) {
      entry = { kind: grant.kind, holders: new Map() }
      byPath.set(grant.relPath, entry)
    }
    const key = grant.principalType + ':' + grant.principalId
    let holder = entry.holders.get(key)
    if (holder === undefined) {
      holder = { type: grant.principalType, id: grant.principalId, actions: new Set(), grants: [] }
      entry.holders.set(key, holder)
    }
    holder.actions.add(grant.action)
    holder.grants.push(grant)
  }
  return [...byPath.entries()]
    .map(([relPath, entry]) => ({
      relPath,
      kind: entry.kind,
      principals: [...entry.holders.values()]
        .map(holder => ({
          principalType: holder.type,
          principalId: holder.id,
          label: labels[holder.type + ':' + holder.id] ?? holder.id,
          actions: summarizeActions([...holder.actions]),
          latestAt: latestGrantedAt(holder.grants),
          grants: holder.grants,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/**
 * Format a grant instant the way the reference table does.
 *
 * DataOps' permission preview prints `YYYY/MM/DD HH:mm` and a dash for a missing
 * value, so a reader comparing the two surfaces sees the same date. The raw
 * ISO-8601 string the API returns is not that.
 * @param value - ISO-8601 instant, or an empty string when the backend sent none.
 * @returns The formatted instant, or a dash when there is nothing to show.
 */
export function formatGrantInstant(value: string): string {
  if (value === '') return '-'
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * One DataOps account as the user directory reports it, reduced to what grouping needs.
 *
 * `roles` is what makes inheritance visible: a role grant names the ROLE, so without
 * the membership list the page can only show role grants as belonging to nobody. The
 * directory is the only source for it, and it is administrator-only -- see
 * {@link DirectoryState}.
 */
export interface DirectoryUser {
  /** DataOps user id, which is what a `user` grant names. */
  userId: string
  /** Login name, shown beside the display name so two "张伟" can be told apart. */
  username: string
  /** Display name, when the account has one. */
  displayName: string
  /** Role codes this account belongs to. */
  roleCodes: string[]
}

/**
 * Whether the user directory could be read.
 *
 * Three states, not two. "Nobody holds a role" and "we could not look" produce the same
 * empty membership map, and rendering them the same way is how a page ends up telling
 * an operator that nobody has inherited access when the truth is that the read failed.
 */
export type DirectoryState =
  | { kind: 'available'; users: readonly DirectoryUser[] }
  | { kind: 'unavailable'; reason: string }

/** One account's holdings, as the by-person view renders them. */
export interface AccountHoldings {
  /** The account id. */
  userId: string
  /** Login name, for disambiguating identical display names. */
  username?: string
  /** Display name, or the id when the account is not in the directory. */
  label: string
  /** Distinct paths this account reaches, directly or through a role. */
  paths: string[]
  /** The unioned permission set, never narrowed by a single grant. */
  resolved: ResolvedActions
  /** Direct grants the account holds itself. */
  directGrants: GrantView[]
  /**
   * Role codes the account inherits through.
   *
   * Empty when the directory could not be read; {@link inheritanceKnown} says which.
   */
  viaRoles: string[]
  /** Whether the inheritance half of this row was actually determined. */
  inheritanceKnown: boolean
  /** Why inheritance is unknown, when it is. */
  inheritanceReason?: string
  /** Most recent grant instant across the rows this account covers. */
  latestAt: string
}

/** One role's holdings, as the by-role view renders them. */
export interface RoleHoldings {
  /** Role code, which is what a `role` grant names. */
  roleCode: string
  /** Role display name when the directory resolved one, else the code. */
  label: string
  /** Distinct paths the role covers. */
  paths: string[]
  /** The unioned permission set for this role. */
  resolved: ResolvedActions
  /** Grants that name this role. */
  grants: GrantView[]
  /** How many directory accounts belong to this role, when the directory is known. */
  memberCount?: number
  /** Most recent grant instant across this role's rows. */
  latestAt: string
}

/**
 * Union the actions of a set of grants, keeping the union rule in one place.
 * @param grants - grants reaching one principal.
 * @returns The unioned action set.
 */
function actionsOfGrants(grants: readonly GrantView[]): ResolvedActions {
  return resolveActions(grants.map(grant => grant.action))
}

/** Sort strings, leaving the input untouched. */
function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

/**
 * Group grants by the DataOps ACCOUNT that holds them.
 *
 * The account is the row grain because "who can see this" is a question about people.
 * A role grant confers access on every member of that role, so its paths are attributed
 * to each member here -- otherwise a reader whose access is entirely role-derived would
 * appear on no row at all, and the page would say "nobody has access" to somebody who
 * can write.
 *
 * Three sources are merged, and the merge is a UNION:
 * 1. direct `user` grants;
 * 2. grants held by any role the account belongs to (inherited);
 * 3. nothing else -- the built-in administrator levels are already rows in the grant
 *    table (`source: 'seed'`), so hard-coding them here would create a second authority
 *    that could disagree with the backend.
 *
 * @param grants - the whole grant table.
 * @param directory - the user directory, or the reason it could not be read.
 * @param labels - display names by `principalType:principalId`, optional.
 * @returns One row per account that holds or inherits at least one grant, sorted by label.
 */
export function groupHoldingsByAccount(
  grants: readonly GrantView[],
  directory: DirectoryState,
  labels: Readonly<Record<string, string>> = {},
): AccountHoldings[] {
  /** Role code -> paths/actions/grants that role carries. */
  const byRole = new Map<string, GrantView[]>()
  for (const grant of grants) {
    if (grant.principalType !== 'role') continue
    const list = byRole.get(grant.principalId) ?? []
    list.push(grant)
    byRole.set(grant.principalId, list)
  }
  /** Account id -> direct grants. */
  const byAccount = new Map<string, GrantView[]>()
  for (const grant of grants) {
    if (grant.principalType !== 'user') continue
    const list = byAccount.get(grant.principalId) ?? []
    list.push(grant)
    byAccount.set(grant.principalId, list)
  }

  const directoryUsers = directory.kind === 'available' ? directory.users : []
  /** Accounts to render: everyone in the directory, plus any id the grants name. */
  const accountIds = new Set<string>(directoryUsers.map(user => user.userId))
  for (const id of byAccount.keys()) accountIds.add(id)

  const rows: AccountHoldings[] = []
  for (const userId of accountIds) {
    const direct = byAccount.get(userId) ?? []
    const user = directoryUsers.find(candidate => candidate.userId === userId)
    const roleCodes = user?.roleCodes ?? []
    const inheritedGrants: GrantView[] = []
    for (const roleCode of roleCodes) {
      inheritedGrants.push(...(byRole.get(roleCode) ?? []))
    }
    // A row with nothing at all is not interesting: a directory account that holds no
    // grant and inherits none would be a page of people who cannot see anything.
    if (direct.length === 0 && inheritedGrants.length === 0) continue

    const all = [...direct, ...inheritedGrants]
    const resolved = actionsOfGrants(all)
    const inheritanceKnown = directory.kind === 'available'
    rows.push({
      userId,
      ...(user === undefined ? {} : { username: user.username }),
      label: user?.displayName !== undefined && user.displayName !== ''
        ? user.displayName
        : (labels['user:' + userId] ?? user?.username ?? userId),
      paths: sorted(new Set(all.map(grant => grant.relPath))),
      resolved,
      directGrants: direct,
      viaRoles: sorted(new Set(roleCodes.filter(code => (byRole.get(code) ?? []).length > 0))),
      inheritanceKnown,
      ...(inheritanceKnown ? {} : { inheritanceReason: directory.kind === 'unavailable' ? directory.reason : '' }),
      latestAt: latestGrantedAt(all),
    })
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Group grants by the ROLE they name.
 *
 * The same grants the old "by person" table showed, now labelled as what they are: a
 * role is not a person, and putting it under "by person" told the reader that the
 * administrators were the only people with access.
 *
 * A role whose grants are all unreadable still gets a row with `known: false`: that is
 * the safety net against rendering "no permission" for a read failure.
 *
 * @param grants - the whole grant table.
 * @param labels - display names by `principalType:principalId`, optional.
 * @param memberCounts - role code -> member count, when the directory is known.
 * @returns One row per role named by at least one grant, sorted by label.
 */
export function groupHoldingsByRole(
  grants: readonly GrantView[],
  labels: Readonly<Record<string, string>> = {},
  memberCounts?: ReadonlyMap<string, number>,
): RoleHoldings[] {
  const byRole = new Map<string, GrantView[]>()
  for (const grant of grants) {
    if (grant.principalType !== 'role') continue
    const list = byRole.get(grant.principalId) ?? []
    list.push(grant)
    byRole.set(grant.principalId, list)
  }
  const rows: RoleHoldings[] = []
  for (const [roleCode, roleGrants] of byRole) {
    const resolved = actionsOfGrants(roleGrants)
    const count = memberCounts?.get(roleCode)
    rows.push({
      roleCode,
      label: labels['role:' + roleCode] ?? roleCode,
      paths: sorted(new Set(roleGrants.map(grant => grant.relPath))),
      resolved,
      grants: roleGrants,
      ...(count === undefined ? {} : { memberCount: count }),
      latestAt: latestGrantedAt(roleGrants),
    })
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Build the role -> member-count map from a directory.
 *
 * Only meaningful when the directory is known; returns undefined otherwise so the row
 * omits the count rather than claiming zero members.
 * @param directory - the user directory state.
 * @returns Counts by role code, or undefined when unavailable.
 */
export function roleMemberCounts(directory: DirectoryState): Map<string, number> | undefined {
  if (directory.kind !== 'available') return undefined
  const counts = new Map<string, number>()
  for (const user of directory.users) {
    for (const roleCode of user.roleCodes) {
      counts.set(roleCode, (counts.get(roleCode) ?? 0) + 1)
    }
  }
  return counts
}
