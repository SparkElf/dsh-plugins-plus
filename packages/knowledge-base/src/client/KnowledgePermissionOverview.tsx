/**
 * The permissions surface: one grant table, read two ways.
 *
 * A grant says "this principal may do this action to this path". That is the right
 * shape to STORE and the wrong shape to AUDIT: an administrator asking "what does
 * 张三 have" and "who can see 制度.md" is asking two questions that one
 * row-per-grant layout cannot answer without being read line by line.
 *
 * So the page has one body and two readings of it. The tabs switch which question
 * is being asked; both render the same loaded grants, so the two can never
 * disagree. No second endpoint exists because there is no second truth.
 *
 * The tables are the page's own body rather than a summary above one. An earlier
 * version stacked both readings as bulleted lists and *also* drew a third,
 * row-per-principal table underneath: three renderings of one payload, so the
 * reader had to work out which of the three was authoritative before reading any
 * of them. Two tabs over one table removes that question.
 *
 * @module @sparkelf/dsh-knowledge-base/client/KnowledgePermissionOverview
 */

import { useMemo, useState } from 'react'
import { Button, SegmentedControl, SegmentedTabs, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrantView, KnowledgeGrantSubjectType } from '../api.ts'
import {
  groupHoldingsByAccount,
  groupHoldingsByResource,
  groupHoldingsByRole,
  resolveActions,
  roleMemberCounts,
  type AccountHoldings,
  type DirectoryState,
  type ResourceHoldings,
  type RoleHoldings,
} from './permissionRows.ts'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, paginate } from './paging.ts'
import styles from './KnowledgePermissions.module.css'

/**
 * Which palette a permission point gets.
 *
 * Colour is the second signal, never the only one: every chip carries the action's
 * own localized word, so a reader who cannot separate the hues still reads
 * "Manage" rather than a blue dot. The mapping orders capability, not health —
 * `danger` would say a permission is broken, and a broad grant is not broken, it
 * is broad.
 * @param action - raw action string from a grant.
 * @returns the tag tone to paint it with.
 */
function actionTone(action: string): TagTone {
  switch (action) {
    case 'manage':
    case 'all':
      return 'solid'
    case 'write':
    case 'create':
    case 'update':
    case 'delete':
      return 'info'
    default:
      return 'outline'
  }
}

/** Which reading of the grant table the tabs are showing. */
export type OverviewTab = 'person' | 'role' | 'resource'

/** Copy for the overview, supplied by the caller's locale record. */
export interface OverviewCopy {
  tabByPerson: string
  tabByRole: string
  tabByResource: string
  empty: string
  /** Empty state per view, so "nobody is directly granted" is not shown for a role. */
  emptyByPerson: string
  emptyByRole: string
  emptyByResource: string
  /** Where a principal's access comes from. */
  sourceDirect: string
  /** Format "inherited via role X": `{role}` is replaced by the role code. */
  sourceViaRole: (role: string) => string
  /** Shown when the user directory could not be read, so inheritance is unknowable. */
  sourceUnavailable: string
  /** Word for a permission set that could not be fully determined. */
  actionsUnknown: string
  actionsUnknownHint: string
  /** Column headers unique to the three views. */
  colAccount: string
  colSource: string
  /** "{count} member(s)". */
  roleMemberCount: (count: number) => string
  /** Pager copy, shared with the audit table's wording. */
  pagerPrev: string
  pagerNext: string
  pagerStatus: (page: number, pageCount: number, total: number) => string
  pageSizeLabel: string
  pageSizeOption: (size: number) => string
  pathsHeld: (count: number) => string
  rolesHeld: string
  actionsHeld: string
  noActions: string
  /** Accessible name for the tab strip, for readers who arrive at it by keyboard. */
  tabsLabel: string
  /** Stat-card labels: the four numbers the page leads with. */
  statPrincipals: string
  statResources: string
  statGrants: string
  statRoles: string
  /** Shared column headers, person reading. */
  colPrincipal: string
  colKind: string
  colPermission: string
  colResources: string
  colExpiry: string
  colActions: string
  /** Shared column headers, resource reading. */
  colResource: string
  colHolders: string
  colKindOfResource: string
  revoke: string
  revokeBusy: string
  expiryNever: string
  kindFile: string
  kindDirectory: string
  /** Formats "N grants · M paths" under a person's name. */
  grantsUnit: (count: number) => string
  resourcesUnit: (count: number) => string
  /**
   * Resolves a principal kind and an action to its localized word.
   *
   * Supplied as callbacks rather than as a keyed map so this component never
   * reaches into the locale record itself: a caller with its own wording (a test,
   * another surface) can pass its own, and the type checker still enforces that
   * every kind and action the table can print has a word.
   */
  kindLabel: (kind: KnowledgeGrantSubjectType) => string
  actionLabel: (action: string) => string
}

/** Props the parent panel supplies. */
export interface KnowledgePermissionOverviewProps {
  /** The grant table already loaded by the permissions page. */
  grants: readonly GrantView[]
  /** Display names by `principalType:principalId`. */
  labels?: Readonly<Record<string, string>>
  /**
   * The DataOps account directory, when the caller could read it.
   *
   * Absent means the same as an unavailable read: inheritance cannot be attributed, and
   * the page says so instead of listing accounts that look like they hold nothing.
   */
  directory?: {
    kind: 'available'
    users: ReadonlyArray<{ id: string; label: string; username?: string; roleCodes?: string[] }>
  } | { kind: 'unavailable'; reason: string }
  /** Locale copy. */
  copy: OverviewCopy
  /**
   * Asks the parent to confirm revoking the grants one row covers.
   *
   * The confirmation lives in the parent because it is a dialog, and a dialog in
   * the middle of a table's row renderer would make the table responsible for
   * ownership of the overlay. This component says *what* to revoke; the parent
   * decides whether to ask first and then performs it.
   */
  onRevoke: (grants: GrantView[], label: string) => void
  /** Disables every revoke control while a write is in flight. */
  busy?: boolean
}

/**
 * The pager row every table shares.
 *
 * One component for three tables so the wording, the control set and the hide-on-one-
 * page rule cannot drift between them. Renders nothing when there is a single page:
 * a pager on a three-row table is furniture that implies the reader is missing rows.
 *
 * @param props - current page, size, totals and the setters.
 * @returns The pager, or null when everything fits on one page.
 */
function TablePager(props: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  copy: OverviewCopy
  onPage: (page: number) => void
  onPageSize: (size: number) => void
  /** Distinguishes the three tables' controls for tests and a11y. */
  tableKey: string
}) {
  const { page, pageCount, total, pageSize, copy, onPage, onPageSize, tableKey } = props
  if (pageCount <= 1) return null
  return (
    <div className={styles.pager} data-kb-pager={tableKey}>
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => { onPage(page - 1) }}
        data-kb-pager-prev={tableKey}
      >
        {copy.pagerPrev}
      </Button>
      <span className={styles.pagerStatus} data-kb-pager-status={tableKey}>
        {copy.pagerStatus(page, pageCount, total)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= pageCount}
        onClick={() => { onPage(page + 1) }}
        data-kb-pager-next={tableKey}
      >
        {copy.pagerNext}
      </Button>
      <SegmentedControl<string>
        id={'kb-perm-pagesize-' + tableKey}
        value={String(pageSize)}
        options={PAGE_SIZES.map(size => ({ value: String(size), label: copy.pageSizeOption(size) }))}
        onChange={(next) => { onPageSize(Number(next)) }}
        label={copy.pageSizeLabel}
        className={styles.pageSize}
      />
    </div>
  )
}

/**
 * Render the permission overview as stat cards over a three-tab table.
 *
 * THREE views, not two, because the old pair answered different questions under one
 * heading: "by person" listed ROLE grants, so the only rows were 管理员 and 超级管理员
 * and a reader concluding "these are the people with access" was reading the page
 * correctly and being told something false. A role is not a person.
 *
 * @param props - grants, labels, directory, role summaries, copy and the revoke hook.
 */
export function KnowledgePermissionOverview(props: KnowledgePermissionOverviewProps) {
  const {
    grants, labels = {}, copy, onRevoke, busy = false, directory,
  } = props
  // The two older readings, kept because they are still exactly right for their grain.
  const resources = useMemo(() => groupHoldingsByResource(grants, labels), [grants, labels])
  // The directory state, normalised once: a missing prop and a failed read are the same
  // fact to this surface -- membership is unknowable -- and both must say so rather than
  // render an account list that looks complete.
  const directoryState: DirectoryState = useMemo(() => {
    if (directory === undefined) return { kind: 'unavailable', reason: copy.sourceUnavailable }
    if (directory.kind === 'unavailable') return directory
    return {
      kind: 'available',
      users: directory.users.map(user => ({
        userId: user.id,
        username: user.username ?? '',
        displayName: user.label,
        roleCodes: user.roleCodes ?? [],
      })),
    }
  }, [directory, copy.sourceUnavailable])

  const accounts = useMemo(
    () => groupHoldingsByAccount(grants, directoryState, labels),
    [grants, directoryState, labels],
  )
  const roleRows = useMemo(
    () => groupHoldingsByRole(grants, labels, roleMemberCounts(directoryState)),
    [grants, directoryState, labels],
  )
  const [tab, setTab] = useState<OverviewTab>('person')
  // Three independent pager states, one per view. Sharing one would carry page 3 from
  // the role table into a shorter account table, which is the clamp case all over again.
  const [personPaging, setPersonPaging] = useState({ page: 1, size: DEFAULT_PAGE_SIZE })
  const [rolePaging, setRolePaging] = useState({ page: 1, size: DEFAULT_PAGE_SIZE })
  const [resourcePaging, setResourcePaging] = useState({ page: 1, size: DEFAULT_PAGE_SIZE })

  const stats: Array<{ key: string; label: string; value: number }> = [
    { key: 'principals', label: copy.statPrincipals, value: accounts.length },
    { key: 'resources', label: copy.statResources, value: resources.length },
    { key: 'grants', label: copy.statGrants, value: grants.length },
    { key: 'roles', label: copy.statRoles, value: roleRows.length },
  ]

  const personPage = paginate(accounts, personPaging.page, personPaging.size)
  const rolePage = paginate(roleRows, rolePaging.page, rolePaging.size)
  const resourcePage = paginate(resources, resourcePaging.page, resourcePaging.size)

  /** Reset a view to page 1 whenever its tab is opened. */
  const selectTab = (next: OverviewTab): void => {
    setTab(next)
    // A tab switch is a new question; starting it on page 4 of the previous answer is
    // never what the reader meant.
    if (next === 'person') setPersonPaging(current => ({ ...current, page: 1 }))
    if (next === 'role') setRolePaging(current => ({ ...current, page: 1 }))
    if (next === 'resource') setResourcePaging(current => ({ ...current, page: 1 }))
  }

  return (
    <div className={styles.overview} data-kb-overview="ready">
      <div className={styles.statRow} data-kb-overview="stats">
        {stats.map(stat => (
          <div key={stat.key} className={styles.statCard} data-kb-stat={stat.key}>
            <span className={styles.statValue}>{stat.value}</span>
            <span className={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Three readings of one payload. Switching changes the row GRAIN, never the data. */}
      <SegmentedTabs<OverviewTab>
        items={[
          { value: 'person', label: copy.tabByPerson, id: 'kb-perm-tab-person', panelId: 'kb-perm-panel' },
          { value: 'role', label: copy.tabByRole, id: 'kb-perm-tab-role', panelId: 'kb-perm-panel' },
          { value: 'resource', label: copy.tabByResource, id: 'kb-perm-tab-resource', panelId: 'kb-perm-panel' },
        ]}
        value={tab}
        onChange={selectTab}
        label={copy.tabsLabel}
        className={styles.tabs}
      />

      {/* The empty state is per view: "no role is granted access" and "no account is
          granted access directly" are different facts, and one sentence for both would
          misreport whichever view the reader happens to be on. */}
      <div
        id="kb-perm-panel"
        role="tabpanel"
        aria-labelledby={'kb-perm-tab-' + tab}
      >
        {tab === 'person' && (grants.length === 0 || accounts.length === 0)
          ? <p className={styles.overviewEmpty} role="status">{copy.emptyByPerson}</p>
          : tab === 'role' && roleRows.length === 0
            ? <p className={styles.overviewEmpty} role="status">{copy.emptyByRole}</p>
            : tab === 'resource' && resources.length === 0
              ? <p className={styles.overviewEmpty} role="status">{copy.emptyByResource}</p>
              : tab === 'person'
                ? renderAccountTable(personPage, personPaging, setPersonPaging)
                : tab === 'role'
                  ? renderRoleTable(rolePage, rolePaging, setRolePaging)
                  : renderResourceTable(resourcePage, resourcePaging, setResourcePaging)}
      </div>
    </div>
  )

  /** Where a principal's access comes from, as one readable cell. */
  function renderSource(cell: { viaRoles: string[]; inheritanceKnown: boolean; inheritanceReason?: string }) {
    if (!cell.inheritanceKnown) {
      // Never silently omits the inherited half: that would render an administrator as
      // holding only their direct grants, which reads as "no permission".
      return (
        <div className={styles.sourceCell}>
          <Tag tone="quiet">{copy.sourceUnavailable}</Tag>
          {cell.inheritanceReason === undefined || cell.inheritanceReason === ''
            ? null
            : <div className={styles.sourceHint}>{cell.inheritanceReason}</div>}
        </div>
      )
    }
    if (cell.viaRoles.length === 0) return <Tag tone="quiet">{copy.sourceDirect}</Tag>
    return (
      <div className={styles.sourceCell}>
        {cell.viaRoles.map(role => (
          <Tag key={role} tone="neutral">{copy.sourceViaRole(role)}</Tag>
        ))}
      </div>
    )
  }

  /** The permission chips for one resolved set, including the unknown case. */
  function renderActions(resolved: { actions: string[]; known: boolean; reason?: string }) {
    if (!resolved.known) {
      // The safety net: a set that could not be determined must not render as a smaller
      // permission than it is. "Read only" for a full administrator is the exact bug.
      return (
        <div className={styles.chips}>
          <Tag tone="warning">{copy.actionsUnknown}</Tag>
          {/* The reason travels as text rather than a tooltip: a title attribute is
              unreachable by keyboard and invisible on touch, and this is the sentence
              that stops an operator trusting a permission number. */}
          <span className={styles.sourceHint}>{resolved.reason ?? copy.actionsUnknownHint}</span>
        </div>
      )
    }
    if (resolved.actions.length === 0) return <div className={styles.chips}><Tag tone="quiet">{copy.noActions}</Tag></div>
    return (
      <div className={styles.chips}>
        {resolved.actions.map(action => (
          <Tag key={action} tone={actionTone(action)}>{copy.actionLabel(action)}</Tag>
        ))}
      </div>
    )
  }

  /** One row per DataOps ACCOUNT: what they hold directly, what they inherit, and how. */
  function renderAccountTable(
    page: { rows: AccountHoldings[]; page: number; pageCount: number; total: number },
    paging: { page: number; size: number },
    setPaging: (next: { page: number; size: number }) => void,
  ) {
    return (
      <>
        <table className={styles.table} data-kb-table="person">
          <thead>
            <tr>
              <th>{copy.colAccount}</th>
              <th>{copy.colPermission}</th>
              <th>{copy.colSource}</th>
              <th>{copy.colResources}</th>
              <th>{copy.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map(account => (
              <tr key={account.userId} data-kb-person={account.userId}>
                <td>
                  <div className={styles.principalName}>{account.label}</div>
                  <div className={styles.principalMeta}>
                    {account.username === undefined || account.username === ''
                      ? account.userId
                      : account.username + ' · ' + account.userId}
                  </div>
                </td>
                <td>{renderActions(account.resolved)}</td>
                <td>{renderSource(account)}</td>
                <td>
                  <ul className={styles.paths}>
                    {account.paths.map(path => <li key={path} className={styles.path}>{path}</li>)}
                  </ul>
                </td>
                <td className={styles.actionCell}>
                  {/* Revoking an INHERITED grant from here would remove it for every
                      member of that role, so the control is offered only for the
                      grants this account holds in its own right. */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || account.directGrants.length === 0}
                    onClick={() => { onRevoke(account.directGrants, account.label) }}
                  >
                    {busy ? copy.revokeBusy : copy.revoke}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePager
          page={page.page}
          pageCount={page.pageCount}
          total={page.total}
          pageSize={paging.size}
          copy={copy}
          tableKey="person"
          onPage={next => { setPaging({ ...paging, page: next }) }}
          onPageSize={size => { setPaging({ page: 1, size }) }}
        />
      </>
    )
  }

  /** One row per ROLE: which paths it covers and what it lets its members do. */
  function renderRoleTable(
    page: { rows: RoleHoldings[]; page: number; pageCount: number; total: number },
    paging: { page: number; size: number },
    setPaging: (next: { page: number; size: number }) => void,
  ) {
    return (
      <>
        <table className={styles.table} data-kb-table="role">
          <thead>
            <tr>
              <th>{copy.colPrincipal}</th>
              <th>{copy.colPermission}</th>
              <th>{copy.colResources}</th>
              <th>{copy.revoke === '' ? '' : copy.statPrincipals}</th>
              <th>{copy.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map(role => (
              <tr key={role.roleCode} data-kb-role-row={role.roleCode}>
                <td>
                  <div className={styles.principalName}>{role.label}</div>
                  <div className={styles.principalMeta}>
                    {role.memberCount === undefined
                      ? copy.sourceUnavailable
                      : copy.roleMemberCount(role.memberCount)}
                  </div>
                </td>
                <td>{renderActions(role.resolved)}</td>
                <td>
                  <ul className={styles.paths}>
                    {role.paths.map(path => <li key={path} className={styles.path}>{path}</li>)}
                  </ul>
                </td>
                <td>
                  <ul className={styles.holders}>
                    {role.grants.map(grant => (
                      <li key={grant.id} className={styles.holder}>
                        <span className={styles.holderName}>{grant.relPath}</span>
                        <span className={styles.holderKind}>{copy.actionLabel(grant.action)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={styles.actionCell}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => { onRevoke(role.grants, role.label) }}
                  >
                    {busy ? copy.revokeBusy : copy.revoke}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePager
          page={page.page}
          pageCount={page.pageCount}
          total={page.total}
          pageSize={paging.size}
          copy={copy}
          tableKey="role"
          onPage={next => { setPaging({ ...paging, page: next }) }}
          onPageSize={size => { setPaging({ page: 1, size }) }}
        />
      </>
    )
  }

  /** One row per path: every principal that can reach it, and how. */
  function renderResourceTable(
    page: { rows: ResourceHoldings[]; page: number; pageCount: number; total: number },
    paging: { page: number; size: number },
    setPaging: (next: { page: number; size: number }) => void,
  ) {
    return (
      <>
        <table className={styles.table} data-kb-table="resource">
          <thead>
            <tr>
              <th>{copy.colResource}</th>
              <th>{copy.colKindOfResource}</th>
              <th>{copy.colHolders}</th>
              <th>{copy.colPermission}</th>
              <th>{copy.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((resource) => {
              const all = resource.principals.flatMap(holder => holder.grants)
              const resolved = resolveActions(resource.principals.flatMap(holder => holder.actions))
              return (
                <tr key={resource.relPath} data-kb-resource={resource.relPath}>
                  <td><span className={styles.path}>{resource.relPath}</span></td>
                  <td>
                    <Tag tone="neutral">
                      {resource.kind === 'directory' ? copy.kindDirectory : copy.kindFile}
                    </Tag>
                  </td>
                  <td>
                    <ul className={styles.holders}>
                      {resource.principals.map(holder => (
                        <li key={holder.principalType + ':' + holder.principalId} className={styles.holder}>
                          <span className={styles.holderName}>{holder.label}</span>
                          <span className={styles.holderKind}>{copy.kindLabel(holder.principalType)}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>{renderActions(resolved)}</td>
                  <td className={styles.actionCell}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => { onRevoke(all, resource.relPath) }}
                    >
                      {busy ? copy.revokeBusy : copy.revoke}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <TablePager
          page={page.page}
          pageCount={page.pageCount}
          total={page.total}
          pageSize={paging.size}
          copy={copy}
          tableKey="resource"
          onPage={next => { setPaging({ ...paging, page: next }) }}
          onPageSize={size => { setPaging({ page: 1, size }) }}
        />
      </>
    )
  }
}
