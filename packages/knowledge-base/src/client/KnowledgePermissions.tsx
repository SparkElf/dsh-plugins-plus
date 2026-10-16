/**
 * The permissions surface of the management page.
 *
 * This view reads and writes grants through the DSH Host, which forwards them to
 * the DataOps backend. It deliberately holds no policy of its own: the backend's
 * authorization resolves the principal, checks the caller's permission keys, and
 * enforces what a grant means. The page only presents the result, so a rule
 * change lands in one place.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconWarningOutlineRegular,
  Input,
  SegmentedControl,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  KB_API,
  kbApiPath,
  type GrantView,
  type KnowledgeGrantSubjectType,
} from '../api.ts'
import styles from './KnowledgePanel.module.css'
import tableStyles from './KnowledgePermissions.module.css'

/** Props for the permissions surface. */
export interface KnowledgePermissionsProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Mount point the grants are scoped to. */
  mountPoint: string
  /** Path the user selected, when the surface opened from a file row. */
  initialPath?: string
  /**
   * Changes when a row's context menu picks a new path.
   *
   * The form's path field is seeded from `initialPath` once; without a signal that
   * the seed changed, a second right-click would leave the field on the first path.
   */
  reloadToken?: number
}

/** The principal kinds the backend accepts. */
const SUBJECT_TYPES: readonly KnowledgeGrantSubjectType[] = ['user', 'role', 'department', 'group']

/** Shape the backend's user lookup expects, since it matches on the primary key. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * What the backend matches a principal id against, per kind.
 *
 * The permission store looks a principal up by a different column per kind, and
 * only `user` uses the primary key: a username in that slot answers
 * `授权主体不存在或未启用` rather than naming the mismatch. The label and the
 * example therefore change with the kind instead of offering one generic field.
 */
const SUBJECT_ID_FIELDS: Record<KnowledgeGrantSubjectType, { label: string; hint: string }> = {
  user: { label: 'subject.user', hint: 'subject.user.hint' },
  role: { label: 'subject.role', hint: 'subject.role.hint' },
  department: { label: 'subject.department', hint: 'subject.department.hint' },
  group: { label: 'subject.group', hint: 'subject.group.hint' },
}

/** One selectable principal, as the Host relays it. */
interface PrincipalOption {
  /** Value the grant must carry. */
  id: string
  /** Human-facing name. */
  label: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; grants: GrantView[]; supported: boolean }
  | { kind: 'error'; message: string }

/** One principal and every grant it holds, in a stable order. */
interface PrincipalGroup {
  /** Principal kind, as the grant names it. */
  principalType: KnowledgeGrantSubjectType
  /** Principal id within its kind. */
  principalId: string
  /** Every grant this principal holds, newest first. */
  grants: GrantView[]
  /** Distinct paths, in first-seen order, so a directory reads before its files. */
  paths: string[]
  /** Distinct actions, in the fixed read → write → manage order. */
  actions: string[]
}

/** The order actions read in: least to most capability. */
const ACTION_ORDER = ['read', 'write', 'manage']

/**
 * Format a grant instant the way the reference table does.
 *
 * DataOps' permission preview prints `YYYY/MM/DD HH:mm` and a dash for a missing
 * value, so a reader comparing the two surfaces sees the same date. The raw
 * ISO-8601 string the API returns is not that.
 * @param value - ISO-8601 instant, or an empty string when the backend sent none.
 * @returns The formatted instant, or an em dash when there is nothing to show.
 */
function formatGrantedAt(value: string): string {
  if (value === '') return '—'
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * Group a flat grant list by the principal it names.
 *
 * This is the whole of the one-to-many shape: the backend answers one row per
 * (principal, path, action) grant, and an operator reading that flat list cannot
 * answer "what may this person see". Grouping here rather than on the Host keeps
 * the plugin's single authority for the data where it already is -- the grants
 * query -- and adds no endpoint.
 *
 * Sorting is total so the table does not reshuffle between reads: principals by
 * kind then id; a group's grants newest first; paths and actions in a fixed
 * order.
 * @param grants - the flat grant list as the Host relays it.
 * @param locale - optional locale tag, so ids compare under the reader's
 *   collation; the runtime default is used when the slot passes none.
 * @returns One entry per principal, sorted.
 */
export function groupGrantsByPrincipal(grants: GrantView[], locale?: string): PrincipalGroup[] {
  const groups = new Map<string, PrincipalGroup>()
  for (const grant of grants) {
    // A kind and id pair identifies a principal across kinds, since a role code
    // and a user UUID are drawn from different spaces.
    const key = grant.principalType + '\u0000' + grant.principalId
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        principalType: grant.principalType,
        principalId: grant.principalId,
        grants: [],
        paths: [],
        actions: [],
      }
      groups.set(key, group)
    }
    group.grants.push(grant)
    if (!group.paths.includes(grant.relPath)) group.paths.push(grant.relPath)
    if (!group.actions.includes(grant.action)) group.actions.push(grant.action)
  }
  for (const group of groups.values()) {
    group.grants.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
    group.actions.sort((a, b) => {
      const ai = ACTION_ORDER.indexOf(a)
      const bi = ACTION_ORDER.indexOf(b)
      // An action the backend adds later sorts after the known ones rather than
      // jumping the queue at index -1.
      return (ai === -1 ? ACTION_ORDER.length : ai) - (bi === -1 ? ACTION_ORDER.length : bi)
    })
  }
  return [...groups.values()].sort((a, b) => {
    if (a.principalType !== b.principalType) return a.principalType.localeCompare(b.principalType)
    return a.principalId.localeCompare(b.principalId, locale)
  })
}

/**
 * Call one grant method with a JSON body.
 * @param method - method name from {@link KB_API}.
 * @param body - request payload.
 * @returns The parsed response body.
 */
async function callGrantApi<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const payload = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? 'HTTP ' + String(response.status))
  return payload
}

/**
 * Render the permission editor.
 * @param props - copy resolver and the mount point grants are scoped to.
 * @returns The permission surface.
 */
export function KnowledgePermissions(props: KnowledgePermissionsProps) {
  // Bound once: every visible string on this surface resolves through the slot's
  // namespace resolver, so no copy is written into the component.
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [subjectType, setSubjectType] = useState<KnowledgeGrantSubjectType>('user')
  const [subjectId, setSubjectId] = useState('')
  const [action, setAction] = useState('read')
  const [path, setPath] = useState(props.initialPath ?? '')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncResult, setSyncResult] = useState<string | undefined>(undefined)
  /**
   * One directory per principal kind, so a row can print a name rather than the
   * id the grant stores.
   *
   * All four kinds load once rather than only the selected one: the table groups
   * grants across kinds, so a row for a role would otherwise have no directory to
   * resolve against while the form was showing users. A kind that fails to load
   * leaves its own entries unresolved and the rest unaffected.
   */
  const [directory, setDirectory] = useState<Partial<Record<KnowledgeGrantSubjectType, PrincipalOption[]>>>({})

  // A row's context menu picks a path at a time the form is already mounted, so the
  // field follows it rather than keeping whatever it was seeded with.
  useEffect(() => {
    if (props.initialPath !== undefined) setPath(props.initialPath)
  }, [props.initialPath, props.reloadToken])

  const load = useCallback(async () => {
    try {
      const result = await callGrantApi<{ grants: GrantView[]; supported?: boolean }>(
        KB_API.grants,
        { mountPoint: props.mountPoint },
      )
      setState({ kind: 'ready', grants: result.grants, supported: result.supported !== false })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : c('readFailed') })
    }
  }, [props.mountPoint])

  useEffect(() => {
    let cancelled = false
    void Promise.all(SUBJECT_TYPES.map(async (kind) => {
      try {
        const result = await callGrantApi<{ options: PrincipalOption[] }>(
          KB_API.principals,
          { principalType: kind },
        )
        return [kind, result.options] as const
      } catch {
        // The directories are a convenience over fields that also accept a typed
        // value, so a caller who may not read one can still grant by hand.
        return [kind, []] as const
      }
    })).then((entries) => {
      if (cancelled) return
      setDirectory(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { void load() }, [load])

  /** The directory for the kind the form is currently offering. */
  const options = directory[subjectType] ?? []

  /** Grant the entered subject access to the entered path. */
  const grant = async (): Promise<void> => {
    if (path.trim() === '' || subjectId.trim() === '') {
      setNotice(c('grantNeedsPath'))
      return
    }
    // Catch the commonest mix-up before the round trip. A username in the user
    // slot makes the backend answer `授权主体不存在或未启用`, which reads as a
    // missing account rather than as the wrong identifier space.
    if (subjectType === 'user' && !UUID_PATTERN.test(subjectId.trim())) {
      setNotice(c('grantNeedsUser'))
      return
    }
    setBusy(true); setNotice(undefined)
    try {
      await callGrantApi(KB_API.grant, {
        mountPoint: props.mountPoint,
        relPath: path.trim(),
        principalType: subjectType,
        principalId: subjectId.trim(),
        action,
      })
      setNotice(c('grantDone'))
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('grantFailed'))
    } finally { setBusy(false) }
  }

  /**
   * Rebuild the caller's visible tree from what DataOps resolves for them.
   *
   * A grant is a statement about what a user MAY read; it puts nothing on disk by
   * itself. The workspace mounts the shared export, so without this step every user
   * sees every file and the grant has no effect. Offering it here, next to the
   * grants a user just edited, is what makes the edit observable.
   */
  const syncView = async (): Promise<void> => {
    setSyncBusy(true); setSyncResult(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.viewsSync), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as {
        resolved?: number
        considered?: number
        linked?: string[]
        unlinked?: string[]
        error?: string
      }
      if (!response.ok) throw new Error(body.error ?? 'HTTP ' + String(response.status))
      // The delta is the answer to "did my edit take effect", and an unchanged set
      // is a meaningful result rather than a no-op worth hiding.
      setSyncResult(c('viewSynced')
        .replace('{considered}', String(body.considered ?? 0))
        .replace('{resolved}', String(body.resolved ?? 0))
        .replace('{linked}', String(body.linked?.length ?? 0))
        .replace('{unlinked}', String(body.unlinked?.length ?? 0)))
    } catch (error: unknown) {
      setSyncResult(error instanceof Error ? error.message : c('viewSyncFailed'))
    } finally { setSyncBusy(false) }
  }

  /**
   * Revoke every grant one principal's row covers.
   *
   * Sequenced rather than issued together: the revoke endpoint takes one path at
   * a time, and a partial failure is the useful outcome -- the rows that did
   * remove are gone, and the message says so instead of claiming a clean sweep.
   */
  const revokeGroup = async (group: PrincipalGroup): Promise<void> => {
    setBusy(true); setNotice(undefined)
    let failed: unknown
    for (const entry of group.grants) {
      try {
        await callGrantApi(KB_API.revoke, {
          mountPoint: props.mountPoint,
          relPath: entry.relPath,
          principalType: entry.principalType,
          principalId: entry.principalId,
          action: entry.action,
        })
      } catch (error: unknown) {
        failed = error
      }
    }
    // Reload either way: whatever succeeded is already gone on the backend, and
    // showing the pre-revoke list would invite revoking it a second time.
    await load()
    setNotice(failed === undefined
      ? c('revokeDone')
      : (failed instanceof Error ? failed.message : c('revokeFailed')))
    setBusy(false)
  }

  // Grouped once per render: the group list is a pure function of the loaded
  // grants, so a second copy in state could drift from them.
  const groups = state.kind === 'ready' ? groupGrantsByPrincipal(state.grants) : []

  return (
    <div className={styles.surface}>

      {state.kind === 'loading' && (
        <div className={styles.empty} role="status" aria-label={c('loading')}>
          <p className={styles.emptyTitle}>{c('loading')}</p>
        </div>
      )}
      {state.kind === 'error' && (
        <div className={styles.empty}>
          <IconWarningOutlineRegular size={24} className={styles.emptyGlyph} />
          <p className={styles.emptyTitle} role="alert">{state.message}</p>
        </div>
      )}

      {state.kind === 'ready' && !state.supported && (
        <p className={styles.muted}>
          {c('grantsManaged')}
        </p>
      )}

      <div className={styles.form}>
        <label className={styles.field}>
          <span>{c('path')}</span>
          <Input
            value={path}
            placeholder={props.mountPoint + '/2024/report.md'}
            onChange={(event) => { setPath(event.target.value) }}
          />
        </label>
        {/* The kind is a closed, small set, so it is a segmented control rather
            than a dropdown: every option is visible and one click selects it. */}
        <div className={styles.field}>
          <span>{c('subjectType')}</span>
          <SegmentedControl
            id="kb-subject-type"
            label={c('subjectType')}
            value={subjectType}
            options={SUBJECT_TYPES.map(kind => ({ value: kind, label: c('subject.' + kind) }))}
            onChange={(next) => {
              // The id space changes with the kind, so a value entered for the
              // previous one would be sent against a column that cannot match it.
              setSubjectType(next)
              setSubjectId('')
            }}
          />
        </div>
        <label className={styles.field}>
          <span>{c(SUBJECT_ID_FIELDS[subjectType].label)}</span>
          {options.length === 0
            ? (
              <Input
                value={subjectId}
                placeholder={c(SUBJECT_ID_FIELDS[subjectType].hint)}
                onChange={(event) => { setSubjectId(event.target.value) }}
              />
            )
            : (
              // The directory answered, so the value comes from it. A UUID typed
              // by hand is the failure this replaced, and the label is what makes
              // the choice reviewable.
              <select
                className={styles.input}
                value={subjectId}
                onChange={(event) => { setSubjectId(event.target.value) }}
              >
                <option value="">{c('chooseOption')}</option>
                {options.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label === option.id ? option.id : option.label + '（' + option.id + '）'}
                  </option>
                ))}
              </select>
            )}
        </label>
        {/* Three fixed actions: likewise a segmented control, so the granted
            scope reads at a glance instead of hiding behind a closed select. */}
        <div className={styles.field}>
          <span>{c('permission')}</span>
          <SegmentedControl
            id="kb-action"
            label={c('permission')}
            value={action}
            options={[
              { value: 'read', label: c('actionRead') },
              { value: 'write', label: c('actionWrite') },
              { value: 'manage', label: c('actionManage') },
            ]}
            onChange={(next) => { setAction(next) }}
          />
        </div>
        <Button variant="primary" disabled={busy} onClick={() => { void grant() }}>
          {c('grant')}
        </Button>
      </div>

      {notice !== undefined && <p className={styles.notice}>{notice}</p>}

      <h3 className={styles.subhead}>{c('viewSection')}</h3>
      <p className={styles.muted}>{c('viewExplainer')}</p>
      <Button
        variant="primary"
        // Unavailable before the surface knows whether a backend answered: a sync
        // with no permission service would resolve every path to nothing and
        // silently empty the tree.
        disabled={syncBusy || state.kind !== 'ready' || !state.supported}
        onClick={() => { void syncView() }}
      >
        {syncBusy ? c('viewSyncing') : c('viewSync')}
      </Button>
      {syncResult !== undefined && <p className={styles.notice}>{syncResult}</p>}

      {/* One row per principal, its grants listed inside it.
          The shape follows DataOps' permission preview (the application-detail
          table in `PermissionsPrototypePage.vue`): a heavier name with dimmer
          supporting lines in the first cell, tags for the classification, and a
          `<br>`-separated multi-target block. Reading a flat grant list could not
          answer "what may this person see", which is the question this page is
          opened for. */}
      <div className={styles.tableHead}>
        <h3 className={styles.tableTitle}>{c('grantsByPrincipal')}</h3>
        {groups.length > 0 && (
          <p className={styles.tableHint}>{c('grantsByPrincipalHint')}</p>
        )}
      </div>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>{c('colPrincipal')}</th>
            <th>{c('colKind')}</th>
            <th>{c('colPermission')}</th>
            <th>{c('colResources')}</th>
            <th>{c('colLatest')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {/* "No grants" is only true once the read came back. While the grants
              are still loading, or after the read failed, the same row would
              assert an empty authorization set the surface has not seen -- so it
              says which state it is in instead. */}
          {state.kind !== 'ready' && (
            <tr className={tableStyles.emptyRow} role="status">
              <td colSpan={6}>{c('loading')}</td>
            </tr>
          )}
          {state.kind === 'ready' && groups.length === 0 && (
            <tr className={tableStyles.emptyRow}>
              {/* The reference's centered muted empty row. */}
              <td colSpan={6}>{c('grantsEmpty')}</td>
            </tr>
          )}
          {groups.map((group) => {
            const named = (directory[group.principalType] ?? [])
              .find(option => option.id === group.principalId)
            const latest = group.grants[0]?.grantedAt ?? ''
            return (
              <tr key={group.principalType + '\u0000' + group.principalId}>
                <td>
                  {/* A directory hit prints the human name; without one the id
                      still shows, so a principal outside the directory stays
                      legible rather than blank. */}
                  <div className={tableStyles.principalName}>{named?.label ?? group.principalId}</div>
                  {/* Both counts are labelled: a bare "4 · 3 个路径" made the
                      reader guess what the 4 counted. */}
                  <div className={tableStyles.principalMeta}>
                    {c('grantsUnit').replace('{count}', String(group.grants.length))}
                    {' · '}
                    {c('resourcesUnit').replace('{count}', String(group.paths.length))}
                  </div>
                  <div className={tableStyles.principalId}>{group.principalId}</div>
                </td>
                <td>
                  <div className={tableStyles.kinds}>
                    <Tag tone="neutral">{c('subject.' + group.principalType)}</Tag>
                  </div>
                </td>
                <td>
                  <div className={tableStyles.actions}>
                    {group.actions.map(action => (
                      <Tag key={action} tone="info">
                        {action === 'read' ? c('actionRead')
                          : action === 'write' ? c('actionWrite')
                            : action === 'manage' ? c('actionManage') : action}
                      </Tag>
                    ))}
                  </div>
                </td>
                <td>
                  {/* The multi-target block: one path per line, as the
                      reference's `<br>`-joined targets read. */}
                  <ul className={tableStyles.paths}>
                    {group.paths.map(path => (
                      <li key={path} className={tableStyles.path}>{path}</li>
                    ))}
                  </ul>
                </td>
                <td className={tableStyles.principalMeta}>{formatGrantedAt(latest)}</td>
                <td className={tableStyles.actionCell}>
                  {/* Revoking stays per-grant, because a grant is what the
                      endpoint removes; the group only makes the set readable. */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void revokeGroup(group) }}
                  >
                    {group.grants.length > 1
                      ? c('revoke') + ' ' + c('grantsUnit').replace('{count}', String(group.grants.length))
                      : c('revoke')}
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
