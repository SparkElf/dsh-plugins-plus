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
import { Button, SegmentedTabs, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrantView, KnowledgeGrantSubjectType } from '../api.ts'
import {
  groupHoldingsByPrincipal,
  groupHoldingsByResource,
  summarizeActions,
  type ResourceHoldings,
} from './permissionRows.ts'
import { buildRoleSummaries, type RoleSummary } from './roleSummary.ts'
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
export type OverviewTab = 'person' | 'resource'

/** Copy for the overview, supplied by the caller's locale record. */
export interface OverviewCopy {
  tabByPerson: string
  tabByResource: string
  empty: string
  pathsHeld: (count: number) => string
  rolesHeld: string
  actionsHeld: string
  builtInRoles: string
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
  /** Built-in role summaries, so the person view can explain what a role means. */
  roles?: readonly RoleSummary[]
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
 * Render the permission overview as stat cards over a two-tab table.
 *
 * @param props - grants, labels, role summaries, locale copy and the revoke hook.
 */
export function KnowledgePermissionOverview(props: KnowledgePermissionOverviewProps) {
  const { grants, labels = {}, copy, onRevoke, busy = false } = props
  const people = useMemo(() => groupHoldingsByPrincipal(grants, labels), [grants, labels])
  const resources = useMemo(() => groupHoldingsByResource(grants, labels), [grants, labels])
  const roles = useMemo(
    () => props.roles ?? buildRoleSummaries(grants),
    [grants, props.roles],
  )
  const [tab, setTab] = useState<OverviewTab>('person')

  const stats: Array<{ key: string; label: string; value: number }> = [
    { key: 'principals', label: copy.statPrincipals, value: people.length },
    { key: 'resources', label: copy.statResources, value: resources.length },
    { key: 'grants', label: copy.statGrants, value: grants.length },
    { key: 'roles', label: copy.statRoles, value: roles.length },
  ]

  return (
    <div className={styles.overview} data-kb-overview="ready">
      {/* The numbers first: they are the page's answer at a glance, and they stay
          put while the tabs below change which detail is on screen. */}
      <div className={styles.statRow} data-kb-overview="stats">
        {stats.map(stat => (
          <div key={stat.key} className={styles.statCard} data-kb-stat={stat.key}>
            <span className={styles.statValue}>{stat.value}</span>
            <span className={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </div>

      {roles.length > 0 && (
        <section className={styles.roleStrip} data-kb-overview="roles">
          <h4 className={styles.roleStripHeading}>{copy.builtInRoles}</h4>
          <div className={styles.roleStripList}>
            {roles.map(role => (
              <span key={role.id} className={styles.roleChip} data-kb-role={role.id}>
                <span className={styles.roleChipName}>{role.label}</span>
                {role.actions.length === 0
                  ? <Tag tone="quiet">{copy.noActions}</Tag>
                  : role.actions.map(action => (
                    <Tag key={action} tone={actionTone(action)}>{copy.actionLabel(action)}</Tag>
                  ))}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* The two readings of the same payload. Switching the tab changes the row
          grain, never the data: both derive from `grants`. */}
      <SegmentedTabs<OverviewTab>
        items={[
          { value: 'person', label: copy.tabByPerson, id: 'kb-perm-tab-person', panelId: 'kb-perm-panel' },
          { value: 'resource', label: copy.tabByResource, id: 'kb-perm-tab-resource', panelId: 'kb-perm-panel' },
        ]}
        value={tab}
        onChange={setTab}
        label={copy.tabsLabel}
        className={styles.tabs}
      />

      {grants.length === 0
        ? <p className={styles.overviewEmpty} role="status">{copy.empty}</p>
        : (
          <div
            id="kb-perm-panel"
            role="tabpanel"
            aria-labelledby={tab === 'person' ? 'kb-perm-tab-person' : 'kb-perm-tab-resource'}
          >
            {tab === 'person' ? renderPersonTable() : renderResourceTable()}
          </div>
        )}
    </div>
  )

  /** One row per principal: what it may do, and which paths that covers. */
  function renderPersonTable() {
    return (
      <table className={styles.table} data-kb-table="person">
        <thead>
          <tr>
            <th>{copy.colPrincipal}</th>
            <th>{copy.colKind}</th>
            <th>{copy.colPermission}</th>
            <th>{copy.colResources}</th>
            <th>{copy.colExpiry}</th>
            <th>{copy.colActions}</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.principalId} data-kb-person={person.principalId}>
              <td>
                <div className={styles.principalName}>{person.label}</div>
                {/* Both counts are labelled: a bare "4 · 3" made the reader guess
                    what the 4 counted. */}
                <div className={styles.principalMeta}>
                  {copy.grantsUnit(person.grants.length)}
                  {' · '}
                  {copy.resourcesUnit(person.paths.length)}
                </div>
                {person.label !== person.principalId && (
                  <div className={styles.principalId}>{person.principalId}</div>
                )}
              </td>
              <td><Tag tone="neutral">{copy.kindLabel(person.principalType)}</Tag></td>
              <td>
                <div className={styles.chips}>
                  {person.actions.length === 0
                    ? <Tag tone="quiet">{copy.noActions}</Tag>
                    : person.actions.map(action => (
                      <Tag key={action} tone={actionTone(action)}>{copy.actionLabel(action)}</Tag>
                    ))}
                </div>
              </td>
              <td>
                <ul className={styles.paths}>
                  {person.paths.map(path => <li key={path} className={styles.path}>{path}</li>)}
                </ul>
              </td>
              <td>
                {/* A grant carries no end date anywhere in the backend model, so
                    the honest value is the one the schema implies. An expiry the
                    store cannot express must not be invented as a date. */}
                <span className={styles.placeholder}>{copy.expiryNever}</span>
              </td>
              <td className={styles.actionCell}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => { onRevoke(person.grants, person.label) }}
                >
                  {busy ? copy.revokeBusy : copy.revoke}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  /** One row per path: who can reach it, and how. */
  function renderResourceTable() {
    return (
      <table className={styles.table} data-kb-table="resource">
        <thead>
          <tr>
            <th>{copy.colResource}</th>
            <th>{copy.colKindOfResource}</th>
            <th>{copy.colHolders}</th>
            <th>{copy.colPermission}</th>
            <th>{copy.colExpiry}</th>
            <th>{copy.colActions}</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => {
            // The row's revoke covers every holder on this path. Summed once so a
            // multi-holder row removes exactly what its count claims.
            const all = resource.principals.flatMap(holder => holder.grants)
            const actions = summarizeActions(resource.principals.flatMap(holder => holder.actions))
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
                <td>
                  <div className={styles.chips}>
                    {actions.length === 0
                      ? <Tag tone="quiet">{copy.noActions}</Tag>
                      : actions.map(action => (
                        <Tag key={action} tone={actionTone(action)}>{copy.actionLabel(action)}</Tag>
                      ))}
                  </div>
                </td>
                <td><span className={styles.placeholder}>{copy.expiryNever}</span></td>
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
    )
  }
}
