/**
 * The permissions surface of the management page.
 *
 * This view reads and writes grants through the DSH Host, which forwards them to
 * the DataOps backend. It deliberately holds no policy of its own: the backend's
 * authorization resolves the principal, checks the caller's permission keys, and
 * enforces what a grant means. The page only presents the result, so a rule
 * change lands in one place.
 *
 * The page leads with its table. A grant list is what an operator opens this
 * surface to read, so the data is the body of the page and the two things that
 * CHANGE it -- creating a grant, revoking one -- are raised into dialogs. A form
 * parked above the table would push the answer below the fold to make room for
 * the question.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconWarningOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  KB_API,
  kbApiPath,
  type GrantView,
  type KnowledgeGrantSubjectType,
} from '../api.ts'
import { KnowledgePermissionOverview } from './KnowledgePermissionOverview.tsx'
import styles from './KnowledgePanel.module.css'
import tableStyles from './KnowledgePermissions.module.css'

/** Props for the permissions surface. */
export interface KnowledgePermissionsProps {
  /**
   * Publishes this page's primary control to the panel header.
   *
   * The header is the only band at the top of the page, so a page-level action has
   * to be handed up rather than drawn in a second title row.
   */
  onAction?: (action: ReactNode) => void
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
  /** Login name, for users only: two accounts can share a display name. */
  username?: string
  /**
   * Role codes this principal belongs to, for users whose directory reported them.
   *
   * Absent means the directory did not say, which the overview reports as unavailable
   * inheritance rather than as "this account has no role".
   */
  roleCodes?: string[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; grants: GrantView[]; supported: boolean }
  | { kind: 'error'; message: string }

/**
 * Flatten the four principal directories into one label lookup.
 *
 * The overview renders grants from every principal kind at once, so it needs a
 * single map rather than four lists. Keys carry the kind because an id is only
 * unique within its own kind: a role and a user could otherwise collide.
 *
 * @param directories - what each kind's directory answered, when it loaded.
 * @returns display names keyed by `principalType:principalId`.
 */
function labelsFromDirectory(
  directories: Partial<Record<KnowledgeGrantSubjectType, PrincipalOption[]>>,
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const [kind, options] of Object.entries(directories)) {
    for (const option of options ?? []) {
      labels[kind + ':' + option.id] = option.label
    }
  }
  return labels
}

/**
 * Read the reason out of a failed grant reply.
 *
 * The Host answers `{ error: string }` on every rejection. A nested
 * `{ error: { message } }` is also accepted because it is the shape the DataOps admin
 * API uses and this surface relays either: reading only one of the two silently
 * replaced the backend's own explanation with a bare status code, which is exactly the
 * text an operator needs when a grant is refused.
 *
 * @param payload - the parsed reply.
 * @param status - the HTTP status, used when the reply carries no reason.
 * @returns The message to show.
 */
function grantFailureMessage(payload: { error?: unknown }, status: number): string {
  const reason = payload.error
  if (typeof reason === 'string' && reason.trim() !== '') return reason
  if (reason !== null && typeof reason === 'object') {
    const message = (reason as { message?: unknown }).message
    if (typeof message === 'string' && message.trim() !== '') return message
  }
  return 'HTTP ' + String(status)
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
  const payload = (await response.json().catch(() => ({}))) as T & { error?: unknown }
  if (!response.ok) throw new Error(grantFailureMessage(payload, response.status))
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
  const { onAction } = props
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [subjectType, setSubjectType] = useState<KnowledgeGrantSubjectType>('user')
  const [subjectId, setSubjectId] = useState('')
  const [action, setAction] = useState('read')
  const [path, setPath] = useState(props.initialPath ?? '')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantNotice, setGrantNotice] = useState<string | undefined>(undefined)
  /**
   * The revoke a confirmation is currently asking about, if any.
   *
   * Holds the grants to remove and the name to print rather than a grouped
   * principal: the overview renders two row grains (a person, a resource), and the
   * dialog only needs "what will disappear" and what to call it.
   */
  const [confirming, setConfirming] = useState<{ grants: GrantView[]; label: string } | undefined>(undefined)
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
  // field follows it rather than keeping whatever it was seeded with. The dialog is
  // opened too: a right-click is a request to grant on that path, and leaving the
  // reader to find the button afterwards would drop the intent they just expressed.
  useEffect(() => {
    if (props.initialPath !== undefined) {
      setPath(props.initialPath)
      setGrantOpen(true)
    }
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
      setGrantNotice(c('grantNeedsPath'))
      return
    }
    // Catch the commonest mix-up before the round trip. A username in the user
    // slot makes the backend answer `授权主体不存在或未启用`, which reads as a
    // missing account rather than as the wrong identifier space.
    if (subjectType === 'user' && !UUID_PATTERN.test(subjectId.trim())) {
      setGrantNotice(c('grantNeedsUser'))
      return
    }
    setBusy(true); setGrantNotice(undefined)
    try {
      await callGrantApi(KB_API.grant, {
        mountPoint: props.mountPoint,
        relPath: path.trim(),
        principalType: subjectType,
        principalId: subjectId.trim(),
        action,
      })
      // The dialog closes on success: the row it created is now in the table
      // behind it, which is the confirmation that matters.
      setGrantOpen(false)
      setSubjectId('')
      setNotice(c('grantDone'))
      await load()
    } catch (error: unknown) {
      setGrantNotice(error instanceof Error ? error.message : c('grantFailed'))
    } finally { setBusy(false) }
  }

  /**
   * Revoke every grant one principal's row covers.
   *
   * Sequenced rather than issued together: the revoke endpoint takes one path at
   * a time, and a partial failure is the useful outcome -- the rows that did
   * remove are gone, and the message says so instead of claiming a clean sweep.
   */
  const revokeGrants = async (grants: readonly GrantView[]): Promise<void> => {
    setBusy(true); setNotice(undefined)
    let failed: unknown
    for (const entry of grants) {
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
    setConfirming(undefined)
  }

  /**
   * Directory labels, flattened once per render.
   *
   * The overview prints names for every principal kind at once, so it needs one
   * map rather than four lists. Keys carry the kind because an id is only unique
   * within its kind: a role and a user could otherwise collide.
   */
  const labels = labelsFromDirectory(directory)

  // Hoisted so the dependency list names a plain boolean instead of the whole
  // discriminated union (which would republish on every unrelated field change).
  const canAddGrant = state.kind === 'ready' && state.supported
  useEffect(() => {
    if (onAction === undefined) return
    onAction(
      <Button
        variant="primary"
        disabled={!canAddGrant}
        onClick={() => {
          setGrantNotice(undefined)
          setGrantOpen(true)
        }}
      >
        {c('permNew')}
      </Button>,
    )
  }, [onAction, canAddGrant, c])
  useEffect(() => () => { onAction?.(undefined) }, [onAction])

  return (
    <div className={`${styles.surface} ${styles.tableSurface}`}>
      {notice !== undefined && <p className={styles.notice}>{notice}</p>}

      {/* The overview IS the page body, not a summary above a second body.
          It carries both readings of one grant payload under tabs: "what does this
          person have" and "who can reach this path" are the two questions this
          surface is opened to answer, and an operator asks one of them, not both.
          The stat cards above the tabs are the same numbers in one line.

          Loading, error and unsupported keep their own message instead of letting
          the overview render: an empty table before the read returns would assert
          an empty authorization set the surface has not seen. */}
      {state.kind === 'loading' && (
        <p className={styles.muted} role="status">{c('loading')}</p>
      )}
      {state.kind === 'error' && (
        <p className={styles.notice} role="alert">
          <IconWarningOutlineRegular size={16} className={styles.emptyGlyph} />
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && !state.supported && (
        <p className={styles.muted}>{c('grantsManaged')}</p>
      )}

      {state.kind === 'ready' && state.supported && (
        <KnowledgePermissionOverview
          grants={state.grants}
          labels={labels}
          // The user directory doubles as the role-membership source: `/api/system/users`
          // reports each account's roles, which is the ONLY way to attribute a role
          // grant to the people who actually hold it. When that directory could not be
          // read the overview is told so, rather than being handed an empty list that
          // would render as "nobody has inherited access".
          directory={directory.user === undefined
            ? { kind: 'unavailable', reason: c('sourceUnavailable') }
            : {
              kind: 'available',
              users: directory.user.map(option => ({
                id: option.id,
                label: option.label,
                ...(option.username === undefined ? {} : { username: option.username }),
                ...(option.roleCodes === undefined ? {} : { roleCodes: option.roleCodes }),
              })),
            }}
          copy={{
            tabByPerson: c('overviewByPerson'),
            tabByRole: c('overviewByRole'),
            tabByResource: c('overviewByResource'),
            empty: c('grantsEmpty'),
            emptyByPerson: c('emptyByPerson'),
            emptyByRole: c('emptyByRole'),
            emptyByResource: c('emptyByResource'),
            sourceDirect: c('sourceDirect'),
            sourceViaRole: (role: string) => c('sourceViaRole').replace('{role}', role),
            sourceUnavailable: c('sourceUnavailable'),
            actionsUnknown: c('actionsUnknown'),
            actionsUnknownHint: c('actionsUnknownHint'),
            colAccount: c('colAccount'),
            colSource: c('colSource'),
            roleMemberCount: (count: number) => c('roleMemberCount').replace('{count}', String(count)),
            pagerPrev: c('auditPagePrev'),
            pagerNext: c('auditPageNext'),
            pagerStatus: (page: number, pageCount: number, total: number) => c('auditPageOf')
              .replace('{page}', String(page))
              .replace('{pages}', String(pageCount))
              .replace('{total}', String(total)) + ' · ' + c('auditPageTotal').replace('{total}', String(total)),
            pageSizeLabel: c('auditPageSize'),
            pageSizeOption: (size: number) => c('auditPageSizeOption').replace('{size}', String(size)),
            pathsHeld: (count: number) => c('overviewHeld').replace('{count}', String(count)),
            rolesHeld: c('overviewRoles'),
            actionsHeld: c('overviewActions'),
            noActions: c('overviewNoActions'),
            tabsLabel: c('overviewTabsLabel'),
            statPrincipals: c('overviewStatPrincipals'),
            statResources: c('overviewStatResources'),
            statGrants: c('overviewStatGrants'),
            statRoles: c('overviewStatRoles'),
            colPrincipal: c('colPrincipal'),
            colKind: c('colKind'),
            colPermission: c('colPermission'),
            colResources: c('colResources'),
            colExpiry: c('colExpiry'),
            colActions: c('actions'),
            colResource: c('overviewColResource'),
            colHolders: c('overviewColHolders'),
            colKindOfResource: c('overviewColKindOfResource'),
            revoke: c('revoke'),
            revokeBusy: c('revoking'),
            expiryNever: c('expiryNever'),
            kindFile: c('overviewKindFile'),
            kindDirectory: c('overviewKindDirectory'),
            grantsUnit: (count: number) => c('grantsUnit').replace('{count}', String(count)),
            resourcesUnit: (count: number) => c('resourcesUnit').replace('{count}', String(count)),
            kindLabel: (kind: KnowledgeGrantSubjectType) => c('subject.' + kind),
            actionLabel: (value: string) => (value === 'read' ? c('actionRead')
              : value === 'write' ? c('actionWrite')
                : value === 'manage' ? c('actionManage') : value),
          }}
          onRevoke={(grants: GrantView[], label: string) => { setConfirming({ grants: [...grants], label }) }}
          busy={busy}
        />
      )}

      {/* The create form, raised rather than parked above the data. */}
      <Modal
        open={grantOpen}
        onClose={() => { setGrantOpen(false) }}
        title={c('permNew')}
        closeLabel={c('cancel')}
        description={c('grantDialogHint')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setGrantOpen(false) }}>{c('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void grant() }}>
              {busy ? c('granting') : c('grant')}
            </Button>
          </>
        )}
      >
        <div className={tableStyles.dialogForm}>
          <label className={tableStyles.dialogField}>
            <span>{c('path')}</span>
            <Input
              value={path}
              placeholder={props.mountPoint + '/2024/report.md'}
              onChange={(event) => { setPath(event.target.value) }}
            />
          </label>
          {/* The kind is a closed, small set, so it is a segmented control rather
              than a dropdown: every option is visible and one click selects it. */}
          <div className={tableStyles.dialogField}>
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
          <label className={tableStyles.dialogField}>
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
                  className={tableStyles.dialogSelect}
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
          <div className={tableStyles.dialogField}>
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
          {grantNotice !== undefined && <p className={tableStyles.dialogNotice}>{grantNotice}</p>}
        </div>
      </Modal>

      {/* The revoke confirmation. It names what the click will remove, because a
          row can stand for several grants and the count is the part a reader
          cannot see from the button alone. */}
      <Modal
        open={confirming !== undefined}
        onClose={() => { setConfirming(undefined) }}
        title={c('revokeConfirmTitle')}
        closeLabel={c('cancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setConfirming(undefined) }}>{c('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => { if (confirming !== undefined) void revokeGrants(confirming.grants) }}
            >
              {busy ? c('revoking') : c('confirm')}
            </Button>
          </>
        )}
      >
        <p className={tableStyles.dialogNotice}>
          {confirming === undefined
            ? c('revokeConfirmNeeds')
            : c('revokeConfirmBody')
              .replace('{name}', confirming.label)
              .replace('{count}', String(confirming.grants.length))}
        </p>
      </Modal>
    </div>
  )
}
