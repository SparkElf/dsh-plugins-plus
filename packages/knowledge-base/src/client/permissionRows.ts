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

/** Actions in the order the product shows them. */
const ACTION_ORDER = ['read', 'create', 'update', 'delete', 'all'] as const

/**
 * Collapse a set of action strings into the shortest describing list.
 *
 * Mirrors the server's collapse rule without importing it: this file is bundled
 * for the browser and must not pull the server module in. Keeping the rule in
 * two places is a real cost, so it is stated once here and covered by the same
 * expectations as the server's own test.
 *
 * @param actions - raw action strings from grants.
 * @returns `['all']` when everything is held, else the concrete subset in order.
 */
export function summarizeActions(actions: readonly string[]): string[] {
  const concrete = new Set(actions.filter(action => action !== 'all'))
  if (actions.includes('all')) {
    return ['all']
  }
  if (['read', 'create', 'update', 'delete'].every(action => concrete.has(action))) {
    return ['all']
  }
  return ACTION_ORDER.filter(action => concrete.has(action))
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
