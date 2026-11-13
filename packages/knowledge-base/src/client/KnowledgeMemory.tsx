/**
 * The 记忆 page: the user-facing view over their personal memory.
 *
 * The page is deliberately small and quiet. It answers four questions — is memory
 * on, what has been remembered, where did it come from, and how do I correct or
 * forget it — and it never exposes the machinery behind those answers. Rows show a
 * short title, a type, a human source label and a relative time; session ids,
 * tool names, paths, SOP lifecycle and JSON stay out of the surface. The switch
 * never flips on click: both directions open a confirmation, and only the
 * confirmation calls the Host.
 *
 * `KnowledgeMemory` owns the API state; `KnowledgeMemoryView` is the pure render
 * used by tests. Keeping the split means the table, the confirmation copy and the
 * empty state can be asserted without mounting a fetch lifecycle.
 *
 * @module @sparkelf/dsh-knowledge-base/client/KnowledgeMemory
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API_PREFIX, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeMemory.module.css'

/** A source pointer attached to one memory. `sessionId` is never rendered. */
export interface MemorySourceRef {
  /** Human label snapshotted when the memory was written, e.g. 驾驶舱下钻. */
  label?: string
  /** ISO-8601 instant of the source. */
  at?: string
  /** Internal locator used only by the host's 查看原文 action. */
  sessionId?: string
  /** Evidence event positions, used only by the host action. */
  eventSeqs?: number[]
  /** Whether the source can still be opened; absent means derive from sessionId. */
  resolvable?: boolean
}

/** One memory as the page renders it. */
export interface MemoryEntryView {
  id: string
  title: string
  content?: string
  /** preference / pitfall / fact / sop / episodic; unknown values render as Other. */
  type?: string
  /** normal / private / sensitive / secret. */
  privacy?: string
  updatedAt?: string
  /** Primary source pointer. */
  source?: MemorySourceRef
  /** Flat source label, for callers that do not nest the source. */
  sourceLabel?: string
  /** Flat source instant, for callers that do not nest the source. */
  sourceAt?: string
  /** List-row source instant used by the memory route. */
  sourceTime?: string
  /** More sources merged into this memory; the detail lists all of them. */
  sourceRefs?: MemorySourceRef[]
  /** Explicit resolvability override. */
  sourceResolvable?: boolean
}

/** List lifecycle the view renders. */
export interface MemoryListSnapshot {
  status: 'loading' | 'ready' | 'error'
  entries: MemoryEntryView[]
  error?: string
}

/** Props for the pure memory renderer. */
export interface KnowledgeMemoryViewProps {
  t: (key: string) => string
  locale?: string
  enabled: boolean
  settingsLoading: boolean
  settingsError?: string
  list: MemoryListSnapshot
  query: string
  typeFilter: string
  onQueryChange: (value: string) => void
  onTypeFilterChange: (value: string) => void
  /** Ask to flip the switch; the container opens the confirmation. */
  onToggleRequest: (enabled: boolean) => void
  /** Target state while a confirmation is open. */
  pendingEnabled?: boolean
  toggleBusy: boolean
  toggleError?: string
  onCancelToggle: () => void
  onConfirmToggle: () => void
  detail?: MemoryEntryView
  detailLoading: boolean
  onOpenDetail: (entry: MemoryEntryView) => void
  onCloseDetail: () => void
  editing?: { id: string; content: string }
  editBusy: boolean
  editError?: string
  onEditContent: (value: string) => void
  onStartEdit: (entry: MemoryEntryView) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  forgetTarget?: MemoryEntryView
  forgetBusy: boolean
  forgetError?: string
  onStartForget: (entry: MemoryEntryView) => void
  onCancelForget: () => void
  onConfirmForget: () => void
  onRetrySettings: () => void
  onRetryList: () => void
  /** Open the source conversation; omitted hides 查看原文. */
  onOpenSource?: (entry: MemoryEntryView) => void
}

/** Props for the stateful memory page. */
export interface KnowledgeMemoryProps {
  t: (key: string) => string
  locale?: string
  /** Host hook that opens the source conversation. */
  onOpenSource?: (entry: MemoryEntryView) => void
}

/** Local copy of the documented API names; api.ts is owned by another surface. */
type MemoryRoute =
  | 'memory.list'
  | 'memory.get'
  | 'memory.update'
  | 'memory.forget'
  | 'memory.settings'
  | 'memory.set-enabled'

/** POST one memory route and parse the answer without trusting it to be JSON. */
async function memoryRequest<T extends Record<string, unknown>>(
  route: MemoryRoute,
  body: Record<string, unknown> = {},
): Promise<T & { error?: string }> {
  const response = await fetch(KB_API_PREFIX + '/' + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return readKnowledgeJson<T>(response)
}

/** Turn an unknown failure into the one sentence the page can show. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The type label key for one stored type. */
function typeKey(type: string | undefined): string {
  if (type === 'preference') return 'memoryTypePreference'
  if (type === 'pitfall') return 'memoryTypePitfall'
  if (type === 'fact') return 'memoryTypeFact'
  if (type === 'sop') return 'memoryTypeSop'
  if (type === 'episodic') return 'memoryTypeEpisodic'
  return 'memoryTypeOther'
}

/** The privacy label key for one stored privacy value. */
function privacyKey(privacy: string | undefined): string {
  if (privacy === 'normal') return 'memoryPrivacyNormal'
  if (privacy === 'private') return 'memoryPrivacyPrivate'
  if (privacy === 'sensitive') return 'memoryPrivacySensitive'
  if (privacy === 'secret') return 'memoryPrivacySecret'
  return 'memoryPrivacyOther'
}

/** Copy for a relative instant, falling back to the raw date beyond a week. */
function relativeTime(t: (key: string) => string, value: string | undefined, locale?: string): string {
  if (value === undefined || value === '') return '—'
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return '—'
  const delta = Date.now() - instant.getTime()
  if (delta < 60_000) return t('memoryTimeJustNow')
  if (delta < 3_600_000) return t('memoryTimeMinutes').replace('{n}', String(Math.floor(delta / 60_000)))
  if (delta < 86_400_000) return t('memoryTimeHours').replace('{n}', String(Math.floor(delta / 3_600_000)))
  if (delta < 7 * 86_400_000) return t('memoryTimeDays').replace('{n}', String(Math.floor(delta / 86_400_000)))
  try {
    return instant.toLocaleDateString(locale)
  } catch {
    return instant.toLocaleDateString()
  }
}

/** All source pointers for one memory, primary first. */
function sourcesOf(entry: MemoryEntryView): MemorySourceRef[] {
  if (entry.sourceRefs !== undefined && entry.sourceRefs.length > 0) return entry.sourceRefs
  if (entry.source !== undefined) return [entry.source]
  if (entry.sourceLabel !== undefined || entry.sourceAt !== undefined || entry.sourceTime !== undefined) {
    return [{ label: entry.sourceLabel, at: entry.sourceAt ?? entry.sourceTime }]
  }
  return []
}

/** Whether 查看原文 can be offered for this entry. */
function sourceResolvable(entry: MemoryEntryView, hasHandler: boolean): boolean {
  if (!hasHandler) return false
  if (entry.sourceResolvable !== undefined) return entry.sourceResolvable
  const source = sourcesOf(entry)[0]
  if (source?.resolvable !== undefined) return source.resolvable
  return typeof source?.sessionId === 'string' && source.sessionId !== ''
}

/** The source label the list shows, never a session id. */
function sourceLabel(t: (key: string) => string, entry: MemoryEntryView): string {
  return sourcesOf(entry)[0]?.label ?? t('memorySourceUnknown')
}

/** The source instant the list shows. */
function sourceAt(entry: MemoryEntryView): string | undefined {
  return sourcesOf(entry)[0]?.at ?? entry.sourceAt ?? entry.sourceTime
}

/**
 * Merge the detail/update payload into the row the page already holds.
 *
 * `memory.get` and `memory.update` answer with `{ entry, title, content, source }`,
 * while a list row carries `sourceLabel/sourceTime` and no body. Only the display
 * fields are copied across, so the route's internal entry (including `path`) never
 * becomes renderable by accident.
 */
function detailFromPayload(body: Record<string, unknown>, fallback: MemoryEntryView): MemoryEntryView {
  const entry = typeof body.entry === 'object' && body.entry !== null
    ? body.entry as Record<string, unknown>
    : {}
  const source = typeof body.source === 'object' && body.source !== null
    ? body.source as MemorySourceRef
    : fallback.source
  return {
    ...fallback,
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.content === 'string' ? { content: body.content } : {}),
    ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
    ...(typeof entry.privacy === 'string' ? { privacy: entry.privacy } : {}),
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
    ...((typeof entry.sourceLabel === 'string' || typeof entry.sourceTime === 'string')
      ? { sourceLabel: typeof entry.sourceLabel === 'string' ? entry.sourceLabel : fallback.sourceLabel,
          sourceTime: typeof entry.sourceTime === 'string' ? entry.sourceTime : fallback.sourceTime }
      : {}),
    ...(source === undefined
      ? {}
      : { source, sourceResolvable: typeof source.sessionId === 'string' && source.sessionId !== '' }),
  }
}

/** One type option in the filter. */
const TYPE_OPTIONS = ['preference', 'pitfall', 'fact', 'sop'] as const

/** Match one entry against the search term and type filter. */
function matches(entry: MemoryEntryView, query: string, typeFilter: string): boolean {
  if (typeFilter !== '' && entry.type !== typeFilter) return false
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return (entry.title ?? '').toLowerCase().includes(needle)
    || (entry.content ?? '').toLowerCase().includes(needle)
}

/** Row actions shared by the table and the detail footer. */
function rowActions(
  t: (key: string) => string,
  entry: MemoryEntryView,
  props: KnowledgeMemoryViewProps,
): ReactNode {
  return (
    <span className={styles.rowActions}>
      <Button variant="ghost" size="sm" onClick={() => { props.onOpenDetail(entry) }}>
        {t('memoryActionView')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => { props.onStartEdit(entry) }}>
        {t('memoryActionCorrect')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => { props.onStartForget(entry) }}>
        {t('memoryActionForget')}
      </Button>
    </span>
  )
}

/**
 * Render the memory page from an explicit snapshot.
 *
 * @param props - locale copy, page state and the callbacks the container owns.
 * @returns The header, filters, table and dialogs.
 */
export function KnowledgeMemoryView(props: KnowledgeMemoryViewProps): ReactNode {
  const { t } = props
  const visible = props.list.status === 'ready'
    ? props.list.entries.filter(entry => matches(entry, props.query, props.typeFilter))
    : []
  const detail = props.detail
  const editing = props.editing
  const forgetTarget = props.forgetTarget

  return (
    <div className={styles.page} data-testid="memory-page">
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 className={styles.title}>{t('menu.memory')}</h2>
          <p className={styles.hint}>{t('memoryHint')}</p>
        </div>
        <div className={styles.switchGroup}>
          <span className={styles.switchState}>
            {props.enabled ? t('memoryEnabled') : t('memoryPaused')}
          </span>
          <Switch
            checked={props.enabled}
            disabled={props.settingsLoading || props.toggleBusy}
            onChange={(next: boolean) => { props.onToggleRequest(next) }}
            label={t('memorySwitchLabel')}
          />
        </div>
      </header>

      {props.settingsError !== undefined && (
        <div className={styles.noticeRow} role="alert">
          <span>{t('memorySettingsFailed')}</span>
          <Button variant="ghost" size="sm" onClick={props.onRetrySettings}>{t('memoryRetry')}</Button>
        </div>
      )}
      {!props.enabled && props.settingsError === undefined && (
        <p className={styles.pausedNotice}>{t('memoryPausedNotice')}</p>
      )}

      <div className={styles.toolbar}>
        <Input
          type="search"
          className={styles.search}
          value={props.query}
          placeholder={t('memorySearchPlaceholder')}
          aria-label={t('memorySearchPlaceholder')}
          onChange={(event: { target: { value: string } }) => { props.onQueryChange(event.target.value) }}
        />
        <select
          className={styles.select}
          value={props.typeFilter}
          aria-label={t('memoryFilterLabel')}
          onChange={(event: { target: { value: string } }) => { props.onTypeFilterChange(event.target.value) }}
        >
          <option value="">{t('memoryFilterAll')}</option>
          {TYPE_OPTIONS.map(type => (
            <option key={type} value={type}>{t(typeKey(type))}</option>
          ))}
        </select>
      </div>

      {props.list.status === 'loading' && (
        <p className={styles.notice} data-testid="memory-loading">{t('memoryListLoading')}</p>
      )}
      {props.list.status === 'error' && (
        <div className={styles.state} role="alert" data-testid="memory-error">
          <p className={styles.error}>{t('memoryListFailed')}</p>
          {props.list.error !== undefined && <p className={styles.errorDetail}>{props.list.error}</p>}
          <Button variant="ghost" size="sm" onClick={props.onRetryList}>{t('memoryRetry')}</Button>
        </div>
      )}
      {props.list.status === 'ready' && props.list.entries.length === 0 && (
        <div className={styles.empty} data-testid="memory-empty">
          <p className={styles.emptyTitle}>{t('memoryEmptyTitle')}</p>
          <p className={styles.emptyBody}>{t('memoryEmptyBody')}</p>
        </div>
      )}
      {props.list.status === 'ready' && props.list.entries.length > 0 && visible.length === 0 && (
        <p className={styles.notice} data-testid="memory-no-matches">{t('memoryNoMatches')}</p>
      )}
      {props.list.status === 'ready' && visible.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table} aria-label={t('menu.memory')}>
            <thead>
              <tr>
                <th>{t('memoryColumnMemory')}</th>
                <th>{t('memoryColumnType')}</th>
                <th>{t('memoryColumnSource')}</th>
                <th>{t('memoryColumnUpdated')}</th>
                <th>{t('memoryColumnPrivacy')}</th>
                <th className={styles.actionsHead}>{t('memoryColumnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(entry => (
                <tr key={entry.id} data-testid="memory-row">
                  <td className={styles.memoryCell}>
                    <button type="button" className={styles.memoryTitle} onClick={() => { props.onOpenDetail(entry) }}>
                      {entry.title}
                    </button>
                  </td>
                  <td><span className={styles.typeChip}>{t(typeKey(entry.type))}</span></td>
                  <td>
                    <span className={styles.sourceLabel}>{sourceLabel(t, entry)}</span>
                    <span className={styles.sourceTime}>{relativeTime(t, sourceAt(entry), props.locale)}</span>
                    {sourcesOf(entry).length > 1 && (
                      <span className={styles.sourceMore} title={t('memoryMoreSources').replace('{n}', String(sourcesOf(entry).length - 1))}>
                        +{sourcesOf(entry).length - 1}
                      </span>
                    )}
                  </td>
                  <td className={styles.timeCell}>{relativeTime(t, entry.updatedAt, props.locale)}</td>
                  <td><span className={styles.privacyChip}>{t(privacyKey(entry.privacy))}</span></td>
                  <td className={styles.actionsCell}>{rowActions(t, entry, props)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={props.pendingEnabled !== undefined}
        onClose={props.onCancelToggle}
        title={props.pendingEnabled === true ? t('memoryEnableTitle') : t('memoryPauseTitle')}
        closeLabel={t('memoryClose')}
        footer={(
          <div className={styles.footer}>
            <Button variant="ghost" disabled={props.toggleBusy} onClick={props.onCancelToggle}>{t('cancel')}</Button>
            <Button variant="primary" disabled={props.toggleBusy} onClick={props.onConfirmToggle}>
              {props.pendingEnabled === true ? t('memoryConfirmEnable') : t('memoryConfirmPause')}
            </Button>
          </div>
        )}
      >
        <p>{props.pendingEnabled === true ? t('memoryEnableBody') : t('memoryPauseBody')}</p>
        {props.toggleError !== undefined && <p className={styles.error} role="alert">{props.toggleError}</p>}
      </Modal>

      <Modal
        open={detail !== undefined}
        onClose={props.onCloseDetail}
        title={detail?.title ?? t('memoryDetailTitle')}
        closeLabel={t('memoryClose')}
        footer={detail === undefined ? undefined : (
          <div className={styles.footer}>
            <Button variant="ghost" onClick={props.onCloseDetail}>{t('memoryClose')}</Button>
            <Button variant="ghost" onClick={() => { props.onStartEdit(detail) }}>{t('memoryActionCorrect')}</Button>
            <Button variant="primary" onClick={() => { props.onStartForget(detail) }}>{t('memoryActionForget')}</Button>
          </div>
        )}
      >
        {detail !== undefined && (
          <div className={styles.detailBody}>
            <p className={styles.detailMeta}>
              {t(typeKey(detail.type))} · {t(privacyKey(detail.privacy))} · {relativeTime(t, detail.updatedAt, props.locale)}
            </p>
            {props.detailLoading
              ? <p className={styles.notice}>{t('memoryDetailLoading')}</p>
              : (
                <>
                  <section>
                    <h3 className={styles.detailLabel}>{t('memoryDetailContent')}</h3>
                    <p className={styles.detailContent}>{detail.content ?? t('memoryNoContent')}</p>
                  </section>
                  <section>
                    <h3 className={styles.detailLabel}>{t('memoryDetailSource')}</h3>
                    {sourcesOf(detail).length === 0
                      ? <p className={styles.detailContent}>{t('memorySourceUnknown')}</p>
                      : (
                        <ul className={styles.sourceList}>
                          {sourcesOf(detail).map((source, index) => (
                            <li key={index}>
                              <span>{source.label ?? t('memorySourceUnknown')}</span>
                              <span className={styles.sourceTime}>{relativeTime(t, source.at, props.locale)}</span>
                            </li>
                          ))}
                        </ul>
                        )}
                    {sourceResolvable(detail, props.onOpenSource !== undefined) && (
                      <div className={styles.evidence}>
                        <span className={styles.detailLabel}>{t('memoryDetailEvidence')}</span>
                        <Button variant="ghost" size="sm" onClick={() => { props.onOpenSource?.(detail) }}>
                          {t('memoryViewSource')}
                        </Button>
                      </div>
                    )}
                  </section>
                </>
                )}
          </div>
        )}
      </Modal>

      <Modal
        open={editing !== undefined}
        onClose={props.onCancelEdit}
        title={t('memoryEditTitle')}
        closeLabel={t('memoryClose')}
        footer={(
          <div className={styles.footer}>
            <Button variant="ghost" disabled={props.editBusy} onClick={props.onCancelEdit}>{t('cancel')}</Button>
            <Button variant="primary" disabled={props.editBusy} onClick={props.onSaveEdit}>{t('memorySave')}</Button>
          </div>
        )}
      >
        <label className={styles.detailLabel} htmlFor="memory-edit-content">{t('memoryEditContentLabel')}</label>
        <textarea
          id="memory-edit-content"
          className={styles.textarea}
          value={editing?.content ?? ''}
          onChange={(event: { target: { value: string } }) => { props.onEditContent(event.target.value) }}
        />
        {props.editError !== undefined && <p className={styles.error} role="alert">{props.editError}</p>}
      </Modal>

      <Modal
        open={forgetTarget !== undefined}
        onClose={props.onCancelForget}
        title={t('memoryForgetTitle')}
        closeLabel={t('memoryClose')}
        footer={(
          <div className={styles.footer}>
            <Button variant="ghost" disabled={props.forgetBusy} onClick={props.onCancelForget}>{t('cancel')}</Button>
            <Button variant="primary" disabled={props.forgetBusy} onClick={props.onConfirmForget}>{t('memoryForgetConfirm')}</Button>
          </div>
        )}
      >
        <p>{t('memoryForgetBody')}</p>
        {props.forgetError !== undefined && <p className={styles.error} role="alert">{props.forgetError}</p>}
      </Modal>
    </div>
  )
}

/**
 * The stateful memory page: read settings and the list, then run the confirmed
 * write actions against the Host.
 *
 * @param props - locale copy and the optional source opener.
 * @returns The page with its live state.
 */
export function KnowledgeMemory(props: KnowledgeMemoryProps): ReactNode {
  const { t, locale, onOpenSource } = props
  const [enabled, setEnabled] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<string | undefined>()
  const [list, setList] = useState<MemoryListSnapshot>({ status: 'loading', entries: [] })
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>()
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleError, setToggleError] = useState<string | undefined>()
  const [detail, setDetail] = useState<MemoryEntryView | undefined>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [editing, setEditing] = useState<{ id: string; content: string } | undefined>()
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | undefined>()
  const [forgetTarget, setForgetTarget] = useState<MemoryEntryView | undefined>()
  const [forgetBusy, setForgetBusy] = useState(false)
  const [forgetError, setForgetError] = useState<string | undefined>()
  const detailRequest = useRef(0)

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettingsLoading(true)
    setSettingsError(undefined)
    try {
      const body = await memoryRequest('memory.settings')
      if (body.error !== undefined) throw new Error(body.error)
      setEnabled(body.enabled === true)
    } catch (error: unknown) {
      setSettingsError(failureText(error))
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  const loadList = useCallback(async (): Promise<void> => {
    setList(current => ({ status: 'loading', entries: current.entries }))
    try {
      const body = await memoryRequest('memory.list')
      if (body.error !== undefined) throw new Error(body.error)
      const entries = Array.isArray(body.entries)
        ? (body.entries as MemoryEntryView[]).filter(entry => typeof entry?.id === 'string' && typeof entry.title === 'string')
        : []
      setList({ status: 'ready', entries })
    } catch (error: unknown) {
      setList({ status: 'error', entries: [], error: failureText(error) })
    }
  }, [])

  useEffect(() => {
    void loadSettings()
    void loadList()
  }, [loadList, loadSettings])

  const openDetail = useCallback((entry: MemoryEntryView): void => {
    const request = detailRequest.current + 1
    detailRequest.current = request
    setDetail(entry)
    setDetailLoading(true)
    void memoryRequest('memory.get', { id: entry.id })
      .then((body) => {
        if (request !== detailRequest.current) return
        if (body.error === undefined) setDetail(current => current === undefined ? current : detailFromPayload(body, current))
      })
      .catch(() => undefined)
      .finally(() => {
        if (request === detailRequest.current) setDetailLoading(false)
      })
  }, [])

  const closeDetail = useCallback((): void => {
    detailRequest.current += 1
    setDetail(undefined)
    setDetailLoading(false)
  }, [])

  const requestToggle = useCallback((next: boolean): void => {
    setToggleError(undefined)
    setPendingEnabled(next)
  }, [])

  const confirmToggle = useCallback(async (): Promise<void> => {
    const target = pendingEnabled
    if (target === undefined) return
    setToggleBusy(true)
    setToggleError(undefined)
    try {
      const body = await memoryRequest('memory.set-enabled', { enabled: target })
      if (body.error !== undefined) throw new Error(body.error)
      setEnabled(typeof body.enabled === 'boolean' ? body.enabled : target)
      setPendingEnabled(undefined)
    } catch (error: unknown) {
      setToggleError(failureText(error))
    } finally {
      setToggleBusy(false)
    }
  }, [pendingEnabled])

  const startEdit = useCallback((entry: MemoryEntryView): void => {
    setDetail(undefined)
    setEditError(undefined)
    setEditing({ id: entry.id, content: entry.content ?? '' })
  }, [])

  const saveEdit = useCallback(async (): Promise<void> => {
    if (editing === undefined) return
    setEditBusy(true)
    setEditError(undefined)
    try {
      const body = await memoryRequest('memory.update', { id: editing.id, content: editing.content })
      if (body.error !== undefined) throw new Error(body.error)
      setList(current => current.status !== 'ready' ? current : {
        status: 'ready',
        entries: current.entries.map(entry => entry.id === editing.id
          ? detailFromPayload(body, { ...entry, content: editing.content })
          : entry),
      })
      setEditing(undefined)
    } catch (error: unknown) {
      setEditError(failureText(error))
    } finally {
      setEditBusy(false)
    }
  }, [editing])

  const startForget = useCallback((entry: MemoryEntryView): void => {
    setDetail(undefined)
    setForgetError(undefined)
    setForgetTarget(entry)
  }, [])

  const confirmForget = useCallback(async (): Promise<void> => {
    if (forgetTarget === undefined) return
    setForgetBusy(true)
    setForgetError(undefined)
    try {
      const body = await memoryRequest('memory.forget', { id: forgetTarget.id })
      if (body.error !== undefined) throw new Error(body.error)
      setList(current => current.status !== 'ready' ? current : {
        status: 'ready',
        entries: current.entries.filter(entry => entry.id !== forgetTarget.id),
      })
      setForgetTarget(undefined)
    } catch (error: unknown) {
      setForgetError(failureText(error))
    } finally {
      setForgetBusy(false)
    }
  }, [forgetTarget])

  return (
    <KnowledgeMemoryView
      t={t}
      {...(locale === undefined ? {} : { locale })}
      enabled={enabled}
      settingsLoading={settingsLoading}
      {...(settingsError === undefined ? {} : { settingsError })}
      list={list}
      query={query}
      typeFilter={typeFilter}
      onQueryChange={setQuery}
      onTypeFilterChange={setTypeFilter}
      onToggleRequest={requestToggle}
      {...(pendingEnabled === undefined ? {} : { pendingEnabled })}
      toggleBusy={toggleBusy}
      {...(toggleError === undefined ? {} : { toggleError })}
      onCancelToggle={() => { setPendingEnabled(undefined) }}
      onConfirmToggle={() => { void confirmToggle() }}
      {...(detail === undefined ? {} : { detail })}
      detailLoading={detailLoading}
      onOpenDetail={openDetail}
      onCloseDetail={closeDetail}
      {...(editing === undefined ? {} : { editing })}
      editBusy={editBusy}
      {...(editError === undefined ? {} : { editError })}
      onEditContent={(content) => { setEditing(current => current === undefined ? current : { ...current, content }) }}
      onStartEdit={startEdit}
      onCancelEdit={() => { setEditing(undefined) }}
      onSaveEdit={() => { void saveEdit() }}
      {...(forgetTarget === undefined ? {} : { forgetTarget })}
      forgetBusy={forgetBusy}
      {...(forgetError === undefined ? {} : { forgetError })}
      onStartForget={startForget}
      onCancelForget={() => { setForgetTarget(undefined) }}
      onConfirmForget={() => { void confirmForget() }}
      onRetrySettings={() => { void loadSettings() }}
      onRetryList={() => { void loadList() }}
      {...(onOpenSource === undefined ? {} : { onOpenSource })}
    />
  )
}