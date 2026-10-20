/**
 * The settings surface of the management page.
 *
 * Two things live here, and they are different in kind. The review switch is a
 * DECISION: it changes whether other people's contributions take effect immediately,
 * so it is a control and it needs write access. The audit trail is a RECORD of what
 * already happened, so it is a read-only list. Presenting them together is deliberate:
 * the reason to turn review on is visible in the trail underneath it.
 *
 * The switch ships OFF. That is the product decision, not a default that drifted: an
 * operator who never opens this page keeps the behaviour they had, and turning review
 * on is a deliberate act with a visible consequence.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath } from '../api.ts'
import tableStyles from './KnowledgePermissions.module.css'
import styles from './KnowledgePanel.module.css'

/** This knowledge base's review settings, as the Host reports them. */
export interface KnowledgeSettingsView {
  /** Whether a write must be reviewed before it counts as published. */
  reviewRequired: boolean
}

/** One recorded change, as the Host reports it. */
export interface KnowledgeAuditEntryView {
  /** ISO timestamp of the action. */
  at: string
  /** DataOps user id that performed it: the identity the trail is checked against. */
  actor: string
  /**
   * That user's display name, when the entry carries one.
   *
   * Absent on entries written before it was recorded; the column falls back to the
   * id so an old line still identifies its actor.
   */
  actorLabel?: string
  /** What they did. Mirrors the Host's own action union. */
  action: 'create' | 'upload' | 'move' | 'approve' | 'reject' | 'edit'
  /** The path the action concerned. */
  relPath: string
  /** For a move, the destination path. */
  toRelPath?: string
  /** Whether it took effect immediately or was parked for review or refused. */
  outcome: 'applied' | 'pending' | 'rejected'
}

/** Props for the settings surface. */
export interface KnowledgeSettingsProps {
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
}

/** One submission waiting for review, as the Host reports it. */
export interface PendingWriteView {
  /** The parking name a decision is made against. */
  name: string
  /** Who submitted it. */
  userId: string
  /** The path it wants to occupy. */
  relPath: string
  /** When it was submitted. */
  at: string
  /** Size of the submitted bytes. */
  bytes: number
}

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      settings: KnowledgeSettingsView
      canEdit: boolean
      entries: KnowledgeAuditEntryView[]
      pending: PendingWriteView[]
      canDecide: boolean
    }
  | { kind: 'error'; message: string }

/**
 * Format an audit instant for a table cell.
 * @param value - ISO timestamp.
 * @returns The formatted instant, or a dash when unparseable.
 */
function formatWhen(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * Render the review switch and the audit trail.
 * @param props - copy resolver.
 * @returns The settings surface.
 */
export function KnowledgeSettings(props: KnowledgeSettingsProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [settingsResponse, auditResponse, pendingResponse] = await Promise.all([
        fetch(kbApiPath(KB_API.settingsGet), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        }),
        fetch(kbApiPath(KB_API.auditList), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        }),
        fetch(kbApiPath(KB_API.pendingList), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        }),
      ])
      if (!settingsResponse.ok) throw new Error('HTTP ' + String(settingsResponse.status))
      const settingsBody = (await settingsResponse.json()) as {
        settings?: KnowledgeSettingsView
        canEdit?: boolean
      }
      // The audit trail is allowed to fail on its own: an unreadable trail should not
      // blank the switch, which is the part the operator came here to change.
      let entries: KnowledgeAuditEntryView[] = []
      if (auditResponse.ok) {
        const auditBody = (await auditResponse.json()) as { entries?: KnowledgeAuditEntryView[] }
        entries = auditBody.entries ?? []
      }
      let pending: PendingWriteView[] = []
      let canDecide = false
      if (pendingResponse.ok) {
        const pendingBody = (await pendingResponse.json()) as {
          pending?: PendingWriteView[]
          canDecide?: boolean
        }
        pending = pendingBody.pending ?? []
        canDecide = pendingBody.canDecide === true
      }
      setState({
        kind: 'ready',
        settings: { reviewRequired: settingsBody.settings?.reviewRequired === true },
        canEdit: settingsBody.canEdit === true,
        entries,
        pending,
        canDecide,
      })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * Flip the review switch, then re-read so the shown value is the stored one.
   * @param next - the requested value.
   */
  const setReview = async (next: boolean): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.settingsSet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewRequired: next }),
        cache: 'no-store',
      })
      const body = (await response.json()) as { settings?: KnowledgeSettingsView; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'HTTP ' + String(response.status))
      setNotice(c('settingsSaved'))
      // Re-read rather than trusting the local value: the Host normalises, and the
      // rendered switch must show what is stored.
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('settingsSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Approve or reject one submission, then re-read the queue.
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
      // still queued, and the trail below gained an entry that must show.
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('pendingDecideFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') {
    return <div className={styles.notice}>{c('settingsLoading')}</div>
  }
  if (state.kind === 'error') {
    return <div className={styles.notice}>{c('settingsLoadFailed')}</div>
  }

  const { settings, canEdit, entries, pending, canDecide } = state

  return (
    <div className={styles.contentColumn}>
      {/* The panel header already names this surface; the h1 here repeated it. */}
      <section className={styles.surface}>
        <h2 className={styles.subhead}>{c('settingsReviewHeading')}</h2>
        {c('settingsReviewHint') === '' ? null : <p className={tableStyles.pageHint}>{c('settingsReviewHint')}</p>}
        <div className={styles.pair}>
          <Switch
            checked={settings.reviewRequired}
            disabled={!canEdit || busy}
            onChange={(next) => { void setReview(next) }}
            label={c('settingsReviewLabel')}
          />
          <span className={tableStyles.pageHint}>
            {settings.reviewRequired ? c('settingsReviewOn') : c('settingsReviewOff')}
          </span>
        </div>
        {!canEdit && <p className={tableStyles.pageHint}>{c('settingsReadOnly')}</p>}
        {notice !== undefined && <p className={tableStyles.pageHint}>{notice}</p>}
      </section>

      <section className={styles.surface}>
        <h2 className={styles.subhead}>{c('settingsPendingHeading')}</h2>
        {c('settingsPendingHint') === '' ? null : <p className={tableStyles.pageHint}>{c('settingsPendingHint')}</p>}
          {pending.length === 0 ? (
            <p className={tableStyles.emptyRow}>{c('settingsPendingEmpty')}</p>
          ) : (
            <table className={tableStyles.table}>
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
                {pending.map((entry) => (
                  <tr key={entry.name}>
                    <td>{formatWhen(entry.at)}</td>
                    <td>{entry.userId}</td>
                    <td>{entry.relPath}</td>
                    <td>{String(entry.bytes)} B</td>
                    <td>
                      <span className={tableStyles.actions}>
                        <Button
                          variant="primary"
                          disabled={!canDecide || busy}
                          onClick={() => { void decide(entry.name, 'approve') }}
                        >
                          {c('pendingApprove')}
                        </Button>
                        <Button
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
          )}
        {!canDecide && <p className={tableStyles.pageHint}>{c('pendingReadOnly')}</p>}
      </section>

      <section className={styles.surface}>
        <h2 className={styles.subhead}>{c('settingsAuditHeading')}</h2>
        {c('settingsAuditHint') === '' ? null : <p className={tableStyles.pageHint}>{c('settingsAuditHint')}</p>}
        <table className={tableStyles.table}>
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
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5} className={tableStyles.emptyRow}>{c('settingsAuditEmpty')}</td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.at + entry.action + entry.relPath}>
                  <td>{formatWhen(entry.at)}</td>
                  {/*
                    The display name is what a reader recognises; the id is what the
                    trail is checked against. Showing the name and keeping the id in the
                    tooltip preserves both without widening the column. An entry written
                    before labels were recorded falls back to its id.
                  */}
                  <td title={entry.actor}>{entry.actorLabel ?? entry.actor}</td>
                  <td>{c('auditAction' + entry.action.charAt(0).toUpperCase() + entry.action.slice(1))}</td>
                  <td>
                    {entry.relPath}
                    {entry.toRelPath !== undefined && ' → ' + entry.toRelPath}
                  </td>
                  <td>
                    <Tag tone={entry.outcome === 'applied' ? 'success' : 'warning'}>
                      {c('auditOutcome' + entry.outcome.charAt(0).toUpperCase() + entry.outcome.slice(1))}
                    </Tag>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
