/**
 * The audit surface: what is waiting for a decision, and what has already happened.
 *
 * These two belong on one page and were previously two sections of Settings, which
 * was the wrong shelf for either. A review queue is a WORKLIST -- something an
 * operator opens to get through -- and a trail is a RECORD of what the worklist
 * already settled. Setting them under the review switch made the viewer scroll past
 * configuration to find today's arrivals, and put a record of the past next to a
 * control that governs the future.
 *
 * They share a page because they are one loop seen from two ends: a submission
 * entering, and a decision leaving. Deciding in the first tab appends to the second,
 * so keeping both on screen (one click apart) is what makes the loop legible.
 *
 * Both readings are loaded together and the tabs only choose which table is drawn,
 * so the two can never show different answers to "is the queue empty".
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath } from '../api.ts'
import type {
  KnowledgeAuditEntryView,
  PendingWriteView,
} from './KnowledgeSettings.tsx'
import tableStyles from './KnowledgePermissions.module.css'
import styles from './KnowledgeAudit.module.css'
import panelStyles from './KnowledgePanel.module.css'

/** Which half of the loop the tabs are showing. */
type AuditTab = 'review' | 'log'

/** Props for the audit surface. */
export interface KnowledgeAuditProps {
  /** Locale-bound copy resolver for this package's namespace. */
  t: (key: string) => string
}

/** What one read of the two routes produced. */
interface AuditData {
  /** Submissions waiting for a decision. */
  pending: PendingWriteView[]
  /** Whether the caller may decide them, as the Host answers. */
  canDecide: boolean
  /** Recorded changes, newest first as the Host orders them. */
  entries: KnowledgeAuditEntryView[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: AuditData }
  | { kind: 'error'; message: string }

/**
 * Format an audit instant for a table cell.
 *
 * DataOps' own surfaces print `YYYY/MM/DD HH:mm`, and a reader comparing this trail
 * against one of those should see the same date rather than a second dialect.
 * @param value - ISO timestamp.
 * @returns The formatted instant, or a dash when unparseable.
 */
export function formatAuditWhen(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * Read both routes once.
 *
 * Deliberately tolerant per route: a queue that cannot be read must not blank the
 * trail, and vice versa. They come from different stores, and a token that reaches
 * one but not the other is a real deployment state this page should still show.
 * @returns The two lists and whether the caller may decide.
 */
async function readAudit(): Promise<AuditData> {
  type Route = Parameters<typeof kbApiPath>[0]
  const post = async (route: Route): Promise<Response> => fetch(kbApiPath(route), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })

  const [pendingResponse, auditResponse] = await Promise.all([
    post(KB_API.pendingList),
    post(KB_API.auditList),
  ])

  let pending: PendingWriteView[] = []
  let canDecide = false
  if (pendingResponse.ok) {
    const body = (await pendingResponse.json()) as { pending?: PendingWriteView[]; canDecide?: boolean }
    pending = body.pending ?? []
    canDecide = body.canDecide === true
  }

  let entries: KnowledgeAuditEntryView[] = []
  if (auditResponse.ok) {
    const body = (await auditResponse.json()) as { entries?: KnowledgeAuditEntryView[] }
    entries = body.entries ?? []
  }

  // Both failed: this is not a partially degraded page, it is an unreadable one, and
  // saying so beats rendering two empty tables that claim nothing is queued.
  if (!pendingResponse.ok && !auditResponse.ok) {
    throw new Error('HTTP ' + String(pendingResponse.status))
  }

  return { pending, canDecide, entries }
}

/**
 * Render the audit page: one tab per end of the review loop.
 * @param props - copy resolver.
 * @returns The audit surface.
 */
export function KnowledgeAudit(props: KnowledgeAuditProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [tab, setTab] = useState<AuditTab>('review')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', data: await readAudit() })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * Approve or reject one submission, then re-read both lists.
   * @param name - the submission to decide.
   * @param decision - which way to decide it.
   */
  const decide = async (name: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const route = decision === 'approve' ? KB_API.pendingApprove : KB_API.pendingReject
      const response = await fetch(kbApiPath(route), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        cache: 'no-store',
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'HTTP ' + String(response.status))
      setNotice(decision === 'approve' ? c('pendingApproved') : c('pendingRejected'))
      // Re-read rather than splicing locally: the Host is the authority on what is
      // still queued, and the log tab gained an entry that must show.
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('pendingDecideFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') {
    return <div className={panelStyles.notice}>{c('settingsLoading')}</div>
  }
  if (state.kind === 'error') {
    return <div className={panelStyles.notice}>{c('settingsLoadFailed')}</div>
  }

  const { pending, canDecide, entries } = state.data

  return (
    <div className={styles.audit}>
      {/* The outcome of the last decision, over both tabs: a decision moves an item
          from one tab to the other, so the confirmation belongs to the page rather
          than to the tab it was made in. */}
      {notice !== undefined && <p className={panelStyles.notice} role="status">{notice}</p>}

      <SegmentedTabs<AuditTab>
        items={[
          {
            value: 'review',
            // The count belongs on the tab, not in a heading below it: "is anything
            // waiting for me" is the question this page is opened with, and the tab
            // strip is where that is answered without a click.
            label: c('auditTabReview') + ' (' + String(pending.length) + ')',
            id: 'kb-audit-tab-review',
            panelId: 'kb-audit-panel',
          },
          { value: 'log', label: c('auditTabLog'), id: 'kb-audit-tab-log', panelId: 'kb-audit-panel' },
        ]}
        value={tab}
        onChange={setTab}
        label={c('auditTabsLabel')}
        className={styles.tabs}
      />

      <div id="kb-audit-panel" role="tabpanel" aria-labelledby={'kb-audit-tab-' + tab}>
        {tab === 'review' ? renderQueue() : renderTrail()}
      </div>
    </div>
  )

  /** The worklist: one row per submission, both decisions on the row. */
  function renderQueue() {
    return (
      <>
        {c('settingsPendingHint') === '' ? null : (
          <p className={tableStyles.pageHint}>{c('settingsPendingHint')}</p>
        )}
        <table className={tableStyles.table} data-kb-audit="pending">
          <thead>
            <tr>
              <th>{c('colPendingWhen')}</th>
              <th>{c('colPendingSubmitter')}</th>
              <th>{c('colPendingTarget')}</th>
              <th>{c('colPendingSize')}</th>
              <th>{c('colPendingDecision')}</th>
            </tr>
          </thead>
          <tbody>
            {/* The empty state keeps the header: a table that removes its own
                columns reads as a different page. */}
            {pending.length === 0
              ? (
                <tr className={tableStyles.emptyRow} role="status">
                  <td colSpan={5}>{c('settingsPendingEmpty')}</td>
                </tr>
              )
              : pending.map(entry => (
                <tr key={entry.name} data-kb-pending={entry.name}>
                  <td>{formatAuditWhen(entry.at)}</td>
                  <td>{entry.userId}</td>
                  <td className={styles.pathCell}>{entry.relPath}</td>
                  <td className={tableStyles.countCell}>{String(entry.bytes)} B</td>
                  <td>
                    <span className={tableStyles.actions}>
                      {/* Both decisions stay visible when the caller cannot act, and
                          are disabled rather than hidden: a hidden button would make
                          review look like something this deployment does not have.
                          Only the primary one is primary-coloured -- approving is the
                          action a reviewer is here to take, rejecting the exception. */}
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!canDecide || busy}
                        onClick={() => { void decide(entry.name, 'approve') }}
                      >
                        {c('pendingApprove')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canDecide || busy}
                        onClick={() => { void decide(entry.name, 'reject') }}
                      >
                        {c('pendingReject')}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!canDecide && <p className={tableStyles.pageHint}>{c('pendingReadOnly')}</p>}
      </>
    )
  }

  /** The trail: one row per recorded change, newest first as the Host sends it. */
  function renderTrail() {
    return (
      <>
        {c('settingsAuditHint') === '' ? null : (
          <p className={tableStyles.pageHint}>{c('settingsAuditHint')}</p>
        )}
        <table className={tableStyles.table} data-kb-audit="log">
          <thead>
            <tr>
              <th>{c('colAuditWhen')}</th>
              <th>{c('colAuditActor')}</th>
              <th>{c('colAuditAction')}</th>
              <th>{c('colAuditTarget')}</th>
              <th>{c('colAuditOutcome')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0
              ? (
                <tr className={tableStyles.emptyRow} role="status">
                  <td colSpan={5}>{c('settingsAuditEmpty')}</td>
                </tr>
              )
              : entries.map(entry => (
                <tr key={entry.at + entry.action + entry.relPath}>
                  <td>{formatAuditWhen(entry.at)}</td>
                  {/*
                    The display name is what a reader recognises; the id is what the
                    trail is checked against. Showing the name and keeping the id in
                    the tooltip preserves both without widening the column. An entry
                    written before labels were recorded falls back to its id.
                  */}
                  <td title={entry.actor}>{entry.actorLabel ?? entry.actor}</td>
                  {/* The action word comes from the locale table, so a new action the
                      Host adds later shows its raw value instead of a blank cell. */}
                  <td>{actionLabel(entry.action, c)}</td>
                  <td className={styles.pathCell}>
                    {entry.relPath}
                    {entry.toRelPath !== undefined && ' → ' + entry.toRelPath}
                  </td>
                  <td>
                    {/* `rejected` is not a warning about a healthy system -- it is a
                        decision someone made -- so only the parked state gets the
                        attention colour, and a refusal reads as a plain fact. */}
                    <Tag tone={entry.outcome === 'applied' ? 'success' : entry.outcome === 'pending' ? 'warning' : 'neutral'}>
                      {c('auditOutcome' + entry.outcome.charAt(0).toUpperCase() + entry.outcome.slice(1))}
                    </Tag>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </>
    )
  }
}

/**
 * The localized word for one recorded action.
 *
 * Falls back to the raw value: an action a newer Host writes would otherwise render
 * as an empty cell, and a blank is worse than an untranslated word.
 * @param action - the action as the Host records it.
 * @param c - copy resolver.
 * @returns The localized action name.
 */
function actionLabel(action: string, c: (key: string) => string): string {
  const key = 'auditAction' + action.charAt(0).toUpperCase() + action.slice(1)
  const label = c(key)
  // The resolver answers the key itself when it has no entry; showing that would be
  // no more readable than the raw action, so the raw value wins.
  return label === key ? action : label
}
