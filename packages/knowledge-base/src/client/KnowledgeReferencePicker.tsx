/**
 * The `@`-mention picker: choose which conversation a knowledge file goes into.
 *
 * The explorer row's `@` button used to answer `if (sessionId === undefined) return`
 * -- a page with no conversation open simply dropped the click, so the button looked
 * broken. But "no conversation open" is exactly the state this page is in most of the
 * time: it is a management surface, not a chat. The reference still has to land
 * somewhere, so the click now asks where.
 *
 * Two things are deliberately borrowed rather than invented:
 *
 * The insertion itself is `referenceInChat`, the same contract the sidebar explorer
 * and the viewer's selection popup call. That function owns the whole policy this
 * dialog must not re-derive: which workspace root the mention is relative to, the
 * chip spelling for files versus folders, the quoted form for paths with spaces, and
 * the "degrade to a logged no-op" behaviour when a service is missing. Building a
 * second insertion path here would be the one way to make the two surfaces disagree.
 *
 * The session list and the navigation are the host's own services, resolved lazily
 * through `ctx.get` rather than injected: this dialog is mounted whether or not the
 * user has ever opened a conversation, and a page that cannot see `uiSession` must
 * still render (it would show an empty list, not crash).
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { referenceInChat } from 'dsh-better-sidebar/src/client/reference-in-chat.ts'
import styles from './KnowledgeReferencePicker.module.css'

/**
 * The bits of the host's client services this dialog reads.
 *
 * Structural rather than imported from the host packages: every field here is read
 * defensively (`?.`), because a deployment may mount this page without the session
 * UI, and a missing service has to mean "no rows" instead of a thrown render.
 */
interface SessionRow {
  readonly id: string
  readonly displayTitle?: string
  readonly title?: string
  readonly updatedAt?: number
  readonly blank?: boolean
}

/** The snapshot shape `ctx.uiSession.adapter` publishes (see KnowledgePanel). */
interface SessionAdapterLike {
  /** Current selection; `key` is the session id, absent before a session exists. */
  getSnapshot?: () => { key?: unknown }
}

/** What `ctx.sessions.list` publishes; only the fields this dialog renders. */
interface SessionListLike {
  getSnapshot: () => {
    ids?: readonly string[]
    byId?: Readonly<Record<string, SessionRow>>
    phase?: string
  }
  subscribe?: (listener: () => void) => () => void
}

/** The host session controller surface this dialog calls. */
interface SessionsLike {
  readonly list?: SessionListLike
  create?: (opts?: { workspaceId?: unknown; cwd?: string }) => Promise<string>
}

/** The workspace navigator that owns "show this conversation". */
interface UiWorkspaceLike {
  openSession?: (target: unknown) => void
  startSession?: (workspaceId?: unknown, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void
}

/** Props for the picker. */
export interface KnowledgeReferencePickerProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close without referencing anything. */
  onClose: () => void
  /** Absolute path of the entry the `@` button was pressed on. */
  path: string
  /** Whether that entry is a directory (a folder mention rather than a file chip). */
  isDir: boolean
  /** The client context; both the draft insert and the service lookups need it. */
  ctx: unknown
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
  /** Locale tag, so a session's timestamp reads in the reader's language. */
  locale?: string
  /**
   * The conversation the host currently has selected, read at call time.
   *
   * The New Session flow creates a conversation asynchronously and does not return
   * its id, so the only way to name it afterwards is to ask the page's own session
   * binding -- the same observable the file tree is scoped by. Reading it lazily
   * rather than as a prop is what makes it current by the time the draft is ready.
   */
  selectedSessionId?: () => string | undefined
  /**
   * Called once a reference was actually inserted, with the session that received it.
   *
   * The dialog closes itself either way; this exists so the page can report which
   * conversation the file went to, which is the only feedback a reader gets when the
   * target tab is not the one they were looking at.
   */
  onReferenced?: (sessionId: string) => void
}

/**
 * Absolute-path mention insertion for one session.
 *
 * `referenceInChat` returns void and answers a `false` internally on every degraded
 * path, so the dialog cannot tell "inserted" from "silently skipped" through it. It
 * is still the function called -- the contract must stay single-source -- and the
 * caller treats a closed dialog as "asked", not as "succeeded".
 * @param ctx - the client context.
 * @param sessionId - target conversation.
 * @param path - absolute entry path.
 * @param isDir - folder versus file.
 */
function referenceInto(ctx: unknown, sessionId: string, path: string, isDir: boolean): void {
  referenceInChat(ctx as never, sessionId, path, isDir)
}

/**
 * Format one session's last activity the way the sidebar's session list does.
 * @param value - epoch milliseconds, when the host supplied one.
 * @param locale - reader's locale tag.
 * @returns A short date/time, or an empty string when there is nothing to show.
 */
function formatWhen(value: number | undefined, locale: string | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale === undefined || locale === '' ? undefined : locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    // An unsupported locale tag must not break the list; the numeric date is
    // still readable.
    return date.toISOString().slice(5, 16).replace('T', ' ')
  }
}

/**
 * The `@`-mention session picker.
 * @param props - the entry to reference and the dialog's state.
 * @returns The dialog, or null while closed.
 */
export function KnowledgeReferencePicker(props: KnowledgeReferencePickerProps) {
  const { open, onClose, path, isDir, ctx, t, locale, selectedSessionId } = props
  const [term, setTerm] = useState('')
  /** Bumped after a failed create so the row's error is not a stale one. */
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  /**
   * Subscribe to the host's session catalog.
   *
   * Read through `ctx.get` instead of a prop so a host that mounts this page
   * without the session UI still renders: an absent service yields no rows, which
   * the dialog states as "no conversation to choose from" rather than crashing.
   */
  const sessions = useMemo(() => {
    const services = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof services !== 'function') return undefined
    try {
      return services.call(ctx, 'sessions') as SessionsLike | undefined
    } catch {
      return undefined
    }
  }, [ctx])

  const workspaceId = useMemo(() => {
    const services = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof services !== 'function') return undefined
    try {
      const workspaces = services.call(ctx, 'workspaces') as
        | { list?: { getSnapshot?: () => { items?: ReadonlyArray<{ id?: unknown }> } } }
        | undefined
      const snapshot = workspaces?.list?.getSnapshot?.()
      return snapshot?.items?.[0]?.id
    } catch {
      return undefined
    }
  }, [ctx])

  const [rows, setRows] = useState<readonly SessionRow[]>([])

  /** Pull the catalog into local state, tolerating every missing piece. */
  const reload = useCallback((): void => {
    try {
      const snapshot = sessions?.list?.getSnapshot()
      const ids = snapshot?.ids ?? []
      const byId = snapshot?.byId ?? {}
      const next: SessionRow[] = []
      for (const id of ids) {
        const row = byId[id]
        if (row === undefined) continue
        next.push(row)
      }
      // Newest first, which is the order a reader picks from: the conversation
      // they were just in is almost always the answer.
      next.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      setRows(next)
    } catch {
      setRows([])
    }
  }, [sessions])

  // Load on open, and follow the catalog while it is showing: a session created in
  // another tab should appear without reopening the dialog.
  useEffect(() => {
    if (!open) return
    reload()
    const subscribe = (sessions?.list as { subscribe?: (listener: () => void) => () => void } | undefined)?.subscribe
    if (typeof subscribe !== 'function') return
    try {
      return subscribe.call(sessions?.list, reload)
    } catch {
      return
    }
  }, [open, reload, sessions])

  // A reopened dialog starts from a clean filter rather than the previous search.
  useEffect(() => {
    if (open) {
      setTerm('')
      setError(undefined)
    }
  }, [open])

  /** Rows after the local keyword filter, over title and id. */
  const visible = useMemo(() => {
    const needle = term.trim().toLocaleLowerCase()
    if (needle === '') return rows
    return rows.filter((row) => {
      const name = (row.displayTitle ?? row.title ?? row.id).toLocaleLowerCase()
      const id = row.id.toLocaleLowerCase()
      return name.includes(needle) || id.includes(needle)
    })
  }, [rows, term])

  /** Insert into one existing conversation and switch to it. */
  const choose = useCallback((sessionId: string): void => {
    referenceInto(ctx, sessionId, path, isDir)
    // Navigate after inserting: the draft belongs to that session, and showing it
    // is what lets the reader see the chip they just asked for.
    try {
      const navigator = (ctx as { get?: (name: string) => unknown } | undefined)?.get
      const workspace = typeof navigator === 'function'
        ? navigator.call(ctx, 'uiWorkspace') as UiWorkspaceLike | undefined
        : undefined
      workspace?.openSession?.({ kind: 'known', sessionId })
    } catch {
      // The reference is already in that session's draft; failing to switch is a
      // navigation problem the reader can solve by opening the session themselves.
    }
    props.onReferenced?.(sessionId)
    onClose()
  }, [ctx, isDir, onClose, path, props])

  /** Create a fresh conversation, put the reference in it, and go there. */
  const createNew = useCallback((): void => {
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        const navigator = (ctx as { get?: (name: string) => unknown } | undefined)?.get
        const workspace = typeof navigator === 'function'
          ? navigator.call(ctx, 'uiWorkspace') as UiWorkspaceLike | undefined
          : undefined
        // `startSession` is the host's own New Session flow: it creates the
        // conversation, selects it, and understands the workspace. Preferred over
        // `sessions.create` because it also owns the navigation half, which a bare
        // create does not.
        if (typeof workspace?.startSession === 'function') {
          workspace.startSession(workspaceId)
          // The conversation is created asynchronously and its id is not returned.
          // Resolve it from the catalog on the next tick, then insert: the draft
          // service needs a session scope, so inserting before it exists would
          // degrade to the no-op path and lose the reference.
          setTimeout(() => {
            try {
              const snapshot = sessions?.list?.getSnapshot()
              const ids = snapshot?.ids ?? []
              // Ask the page's own session binding which conversation the New
              // Session flow just selected. It is the same observable the file tree
              // is scoped by, so it cannot disagree with what is on screen.
              const selected = selectedSessionId?.()
              const target = typeof selected === 'string' && selected !== ''
                ? selected
                : ids[ids.length - 1]
              if (typeof target === 'string' && target !== '') {
                referenceInto(ctx, target, path, isDir)
                props.onReferenced?.(target)
              }
            } catch {
              // Best effort: the conversation exists even if the reference could
              // not be inserted, and the reader can drop it in by hand.
            }
            onClose()
          }, 0)
          return
        }
        // No navigator (an older or stripped host): create through the controller.
        // Nothing switches the view, so this path cannot show the result -- it is
        // the fallback that still puts the reference somewhere.
        const id = await sessions?.create?.({ ...(workspaceId === undefined ? {} : { workspaceId }) })
        if (typeof id === 'string' && id !== '') {
          referenceInto(ctx, id, path, isDir)
          props.onReferenced?.(id)
        } else {
          setError(t('refPickerNoTarget'))
        }
        onClose()
      } catch {
        setError(t('refPickerCreateFailed'))
      } finally {
        setBusy(false)
      }
    })()
  }, [ctx, isDir, onClose, path, props, sessions, t, workspaceId])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('refPickerTitle')}
      closeLabel={t('cancel')}
      description={t('refPickerHint')}
    >
      <div className={styles.body}>
        <Input
          value={term}
          placeholder={t('refPickerSearch')}
          aria-label={t('refPickerSearch')}
          onChange={(event) => { setTerm(event.target.value) }}
          // The modal focuses the control carrying this marker, which is the
          // primitive's own way to land the caret in the search box without a
          // React ref (the Input wrapper does not forward one).
          data-modal-autofocus
        />

        {/* The new-conversation door is the first row rather than a footer button:
            "start a new one" is one of the two answers to the question the dialog
            asks, and putting it at the top is what makes it comparable with the
            list instead of looking like a dialog-level action. */}
        <ul className={styles.list} aria-label={t('refPickerTitle')}>
          <li>
            <MenuItemButton disabled={busy} onSelect={createNew}>
              <span className={styles.rowName}>{busy ? t('refPickerCreating') : t('refPickerNew')}</span>
              <span className={styles.rowHint}>{t('refPickerNewHint')}</span>
            </MenuItemButton>
          </li>

          {visible.length === 0 && (
            <li className={styles.empty}>
              {/* Two different empties, stated differently: nothing matches the
                  filter is the reader's own typing, while an empty catalog means
                  there is nothing to choose from yet. */}
              {term.trim() === '' ? t('refPickerNoSessions') : t('refPickerNoMatch')}
            </li>
          )}

          {visible.map((row) => {
            const name = row.displayTitle ?? row.title ?? row.id
            const when = formatWhen(row.updatedAt, locale)
            return (
              <li key={row.id}>
                <MenuItemButton onSelect={() => { choose(row.id) }}>
                  <span className={styles.rowName}>{name}</span>
                  {when !== '' && <span className={styles.rowWhen}>{when}</span>}
                </MenuItemButton>
              </li>
            )
          })}
        </ul>

        {error !== undefined && <p className={styles.error} role="alert">{error}</p>}
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Modal>
  )
}
