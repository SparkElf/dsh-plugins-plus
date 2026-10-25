/**
 * The progress notification button and its panel.
 *
 * Uploading a document and extracting its text are two waits a reader cannot see
 * otherwise: a dropped file looks like nothing happened until the bytes land, and a
 * scanned PDF looks uploaded while its `.md` sibling is still being produced.
 *
 * This is the notification form of that information: a bell in the panel header whose
 * badge counts the work still in flight, opening a panel that names every task. It
 * replaces an earlier strip pinned to the panel's foot, which was too narrow -- file
 * names were cut to a few characters ("中电信桂【2025】150号…"), which is exactly the
 * detail a reader needs to tell two uploads apart.
 *
 * Only the PRESENTATION lives here. The upload rows come from the panel's own upload
 * code and the extraction rows from `extract.status`; this module reads and retries,
 * it does not own either data path.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, FileTypeIcon, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type ExtractionStatusView, type ExtractionTaskView } from '../api.ts'
import { canRetryExtraction, classifyExtractionFailure, mergeOptimistic, pendingCount, survivingClientFailures, tallyExtraction, tallyUploads } from './progressRules.ts'
import type { FailedExtractionView, OptimisticExtraction } from './progressRules.ts'
import type { UploadTaskView } from './progressRules.ts'
import styles from './KnowledgeProgressPopover.module.css'

/** Props for the notification button and panel. */
export interface KnowledgeProgressPopoverProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** The batch currently uploading, oldest first; empty when nothing is in flight. */
  uploads: readonly UploadTaskView[]
  /**
   * Whether to read extraction progress at all.
   *
   * False on a surface that cannot extract (no mount): polling a route whose answer can
   * never be acted on costs a request per reader and buys nothing.
   */
  watchExtraction: boolean
  /** Called after a retry was accepted, so the caller can refresh its own views. */
  onRetried?: (relPath: string) => void
  /**
   * A counter the page bumps when extraction changed outside this panel's own polling.
   *
   * The panel polls only while it already knows about pending work, so an extraction
   * queued from a context menu -- exactly the case where it knows about none -- would
   * never appear. Watching a counter makes that one re-read reachable without adding a
   * second timer.
   */
  refreshSignal?: number
  /**
   * Documents the reader asked to extract that the Host has not reported yet.
   *
   * Drawn as a "queued" row so the click has a visible answer before the round trip
   * finishes. Each entry is replaced by the Host's own task the moment `extract.status`
   * mentions it, and expires on its own when it is never confirmed.
   */
  optimistic?: readonly OptimisticExtraction[]
  /**
   * Requests this page session saw refused before the Host created a task.
   *
   * `extract.retry` answers 404/403 before it enqueues anything, so the Host's snapshot
   * never mentions those failures. Without these rows the panel would show an empty state
   * right after the reader watched an extraction fail -- the exact silence this panel
   * exists to remove. The page owns the store; this component only draws it.
   */
  failures?: readonly FailedExtractionView[]
}

/** How often to re-read extraction progress while something is pending. */
const POLL_MS = 1_500

/** Which extraction states are still worth polling for. */
const ACTIVE_STATES = new Set(['pending', 'running'])

/**
 * Render one extraction task's state as a sentence.
 * @param task - the task from the Host.
 * @param t - copy resolver.
 * @returns The sentence and whether a retry would make sense.
 */
function describeExtraction(
  task: ExtractionTaskView,
  t: (key: string) => string,
): { text: string; canRetry: boolean } {
  if (task.state === 'pending') return { text: t('progressPending'), canRetry: canRetryExtraction(task.state) }
  if (task.state === 'running') {
    if (task.step === 'chunk') return { text: t('progressStepChunk'), canRetry: true }
    if (task.step === 'index') return { text: t('progressStepIndex'), canRetry: true }
    if (task.step === 'done') return { text: t('progressStepDone'), canRetry: false }
    return {
      text: task.via === undefined ? t('progressStepParse') : t('progressExtractingVia').replace('{via}', task.via),
      canRetry: canRetryExtraction(task.state),
    }
  }
  if (task.state === 'succeeded') return { text: t('progressSucceeded'), canRetry: canRetryExtraction(task.state) }
  // Already Markdown: the reader asked for an extraction and there is nothing to do. A
  // success, not a failure -- reporting it as "no extractor" told them their own Markdown
  // file was unreadable.
  if (task.state === 'already-markdown') return { text: t('progressAlreadyMarkdown'), canRetry: false }
  if (task.state === 'unsupported') return { text: t('progressUnsupported'), canRetry: canRetryExtraction(task.state) }
  // The badge states the outcome; the reason belongs on its own line under the name,
  // where the reader can read it instead of hunting for a cut-off badge.
  return { text: t('progressFailedTitle'), canRetry: canRetryExtraction(task.state) }
}

/**
 * Render one failed task's reason the way a reader can act on it.
 *
 * The Host speaks in errno terms (`no such file`); the one case worth translating is a
 * vanished source, because the action differs (look for the file) from every other
 * failure. The raw string stays visible as secondary text so an operator keeps the
 * detail even when the friendly sentence is on top.
 * @param reason - the raw reason.
 * @param t - copy resolver.
 * @returns The readable sentence and the raw reason when it differs.
 */
function readFailureReason(
  reason: string | undefined,
  t: (key: string) => string,
): { text: string; raw?: string } {
  const raw = reason === undefined || reason === '' ? undefined : reason
  if (raw === undefined) return { text: t('progressFailedTitle') }
  if (classifyExtractionFailure(raw) === 'missing-file') {
    return { text: t('extractReasonMissingFile'), raw }
  }
  return { text: raw }
}

/**
 * The notification button and its progress panel.
 * @param props - the upload batch, whether to watch extraction, and the copy resolver.
 * @returns The button, plus the panel while it is open.
 */
export function KnowledgeProgressPopover(props: KnowledgeProgressPopoverProps) {
  const t = props.t
  const [extractions, setExtractions] = useState<ExtractionTaskView[]>([])
  const [open, setOpen] = useState(false)
  /** The task being retried, so only its own row shows the pending state. */
  const [retrying, setRetrying] = useState<string | undefined>(undefined)
  const [retryError, setRetryError] = useState<{ relPath: string; reason: string } | undefined>(undefined)

  const readExtractions = useCallback(async (): Promise<ExtractionTaskView[]> => {
    const response = await fetch(kbApiPath(KB_API.extractStatus), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const body = (await response.json()) as ExtractionStatusView
    return body.tasks ?? []
  }, [])

  /**
   * The Host's tasks plus the rows only this panel knows about yet.
   *
   * `Date.now()` is read on render rather than held in state on purpose: an entry's
   * remaining lifetime only matters when something re-renders, and the poll re-renders
   * while work is pending.
   */
  const merged = useMemo(
    () => mergeOptimistic(extractions, props.optimistic ?? [], Date.now()),
    [extractions, props.optimistic],
  )

  /**
   * Whether anything is still in flight, which is exactly what the badge counts.
   *
   * The optimistic rows are added on top of the Host's own count: they ARE the tasks the
   * reader just asked for, and the badge's job is to answer "did my click do anything".
   */
  const pending = useMemo(
    () => pendingCount(props.uploads, extractions) + merged.queued.length,
    [props.uploads, extractions, merged.queued.length],
  )

  // Poll only while something is pending: an idle reader must not cost a request every
  // second and a half forever. The panel being open does not change the rule -- the
  // closed state has to stay current too, because the badge has to be right before the
  // reader clicks it.
  useEffect(() => {
    if (!props.watchExtraction) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const tasks = await readExtractions()
        if (!live) return
        setExtractions(tasks)
        // Keep polling while a task is queued or running, and also while the reader has
        // the panel open (they are watching it, so a stale list is worse than a request).
        if (tasks.some(task => ACTIVE_STATES.has(task.state)) || pendingRef.current > 0) {
          timer = setTimeout(() => { void tick() }, POLL_MS)
        }
      } catch {
        // A failed read leaves the last known state on screen; the badge is not the place
        // to shout about a transient Host hiccup.
        if (live) timer = setTimeout(() => { void tick() }, POLL_MS)
      }
    }
    void tick()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.watchExtraction, readExtractions, props.refreshSignal])

  // The poll loop reads the current pending count through a ref: putting it in the effect
  // dependencies would restart the timer on every task change and starve the interval.
  const pendingRef = useRef(0)
  pendingRef.current = pending

  /** Ask the Host to run this extraction again. */
  const retry = useCallback(async (relPath: string): Promise<void> => {
    setRetrying(relPath)
    setRetryError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.extractRetry), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath }),
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setRetryError({ relPath, reason: body.error ?? 'HTTP ' + String(response.status) })
        return
      }
      setExtractions(await readExtractions())
      props.onRetried?.(relPath)
    } catch (error: unknown) {
      setRetryError({ relPath, reason: error instanceof Error ? error.message : 'retry failed' })
    } finally {
      setRetrying(undefined)
    }
  }, [props, readExtractions])

  const upload = useMemo(() => tallyUploads(props.uploads), [props.uploads])
  // Failures the Host has no task for still belong in the summary, so they are folded in
  // as synthetic failed rows before counting. A summary that skipped them would show
  // "0 failed" above a list holding the failure the reader just saw.
  const clientFailures = useMemo(
    () => survivingClientFailures(merged.rows, props.failures ?? [], merged.queued),
    [merged.rows, merged.queued, props.failures],
  )
  const extraction = useMemo(
    () => tallyExtraction([...merged.rows, ...clientFailures.map(() => ({ state: 'failed' }))]),
    [merged.rows, clientFailures],
  )
  // A queued guess is work in flight, so the panel and its badge have to count it.
  const queuedCount = merged.queued.length
  const hasWork = props.uploads.length > 0 || merged.rows.length > 0 || queuedCount > 0 || clientFailures.length > 0

  // The badge is the only always-visible part. It states a count and nothing else: a
  // number that is zero is not information, so the badge is absent rather than "0".
  const badge = pending === 0 ? undefined : pending > 99 ? t('progressBadgeMore') : String(pending)

  return (
    <>
      <button
        type="button"
        className={styles.bell}
        aria-label={t('progressOpen')}
        title={t('progressOpen')}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        {/* A bell drawn as text-free SVG: the icon set is the product's, but the glyph is
            this plugin's business, and one inline path avoids a new dependency for a
            single control. */}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.4L3.2 10.6a.5.5 0 0 0 .45.75h8.7a.5.5 0 0 0 .45-.75L11.6 8.2V5.8A3.6 3.6 0 0 0 8 2.2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.4 12.4a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {badge !== undefined && (
          <span className={styles.badge} aria-label={t('progressBadge').replace('{n}', String(pending))}>{badge}</span>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('progressTitle')}
        closeLabel={t('progressClose')}
        className={styles.dialog}
        contentClassName={styles.dialogContent}
        footer={(
          <Button variant="ghost" size="md" onClick={() => { setOpen(false) }}>
            {t('progressClose')}
          </Button>
        )}
      >
        {!hasWork && <p className={styles.empty}>{t('progressIdle')}</p>}

        {/* The summary is numbers, not a sentence: a reader glancing at the panel wants
            "3 of 5 done", and a prose line of the same facts costs a line and reads slower. */}
        {hasWork && (
          <div className={styles.summary}>
            {props.uploads.length > 0 && (
              <span className={styles.summaryItem}>
                <span className={styles.summaryLabel}>{t('progressUploadGroup')}</span>
                <span className={styles.summaryValue}>{upload.done + upload.failed}/{upload.total}</span>
              </span>
            )}
            {(merged.rows.length > 0 || queuedCount > 0 || clientFailures.length > 0) && (
              <span className={styles.summaryItem}>
                <span className={styles.summaryLabel}>{t('progressExtractGroup')}</span>
                {/* The denominator includes the queued guesses and the request failures
                    the Host has no task for: a fraction that ignored rows the list is
                    drawing would not add up. */}
                <span className={styles.summaryValue}>{extraction.done + extraction.failed}/{merged.rows.length + queuedCount + clientFailures.length}</span>
              </span>
            )}
          </div>
        )}

        {props.uploads.length > 0 && (
          <section className={styles.group}>
            <ul className={styles.list}>
              {props.uploads.map(task => {
                // The badge's tone is the state, so a reader scanning a column of cards
                // reads the outcome before the words. One map keeps the three states from
                // drifting apart across the two groups.
                const tone = task.state === 'done' ? styles.badgeDone
                  : task.state === 'failed' ? styles.badgeFailed
                    : styles.badgeBusy
                const label = (task.state === 'waiting' || task.state === 'uploading') ? t('dropUploading')
                  : task.state === 'done' ? t('progressSucceeded')
                    : t('progressFailed').replace('{reason}', '')
                const busy = task.state === 'waiting' || task.state === 'uploading'
                return (
                  <li key={task.name} className={styles.card}>
                    {/* Row one: icon, name, badge. The badge is the last flex child and
                        never shrinks, so it sits on the right edge whatever the name
                        length is. */}
                    <span className={styles.cardRow}>
                      {/* The same `FileTypeIcon` the file tree renders, fed the same way:
                          one mapping for every surface that shows a document. */}
                      <FileTypeIcon path={task.name} size={16} />
                      {/* `Tooltip` rather than a native `title`: the name is cut with an
                          ellipsis, and hover is how a reader recovers the rest. Same
                          approach as the Home table. */}
                      <Tooltip label={task.name} portal side="top" align="end">
                        <span className={styles.cardName}>{task.name}</span>
                      </Tooltip>
                      <span className={tone}>{label}</span>
                    </span>
                    {/* Row two: where it is going. Secondary ink and its own line, so it
                        cannot compete with the name for width. */}
                    <span className={styles.cardPath}>{task.dir === '' ? t('progressRoot') : task.dir}</span>
                    {/* Only while the upload is actually moving: a settled task must not
                        leave an empty track behind. A failed one drops it too -- a bar
                        frozen mid-way would read as "still going".

                        When the browser reports a real percentage it is drawn as a
                        determinate bar with the number beside it; when the body's length
                        is unknown it falls back to the sliding indeterminate fill rather
                        than inventing a value. */}
                    {busy && (
                      <span className={styles.progressRow}>
                        <span
                          className={styles.progressTrack}
                          role="progressbar"
                          aria-label={task.name}
                          {...(task.percent === undefined
                            ? {}
                            : { 'aria-valuenow': task.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
                        >
                          <span
                            className={task.percent === undefined ? styles.progressFillIndeterminate : styles.progressFill}
                            {...(task.percent === undefined ? {} : { style: { width: String(task.percent) + '%' } })}
                          />
                        </span>
                        {task.percent !== undefined && (
                          <span className={styles.progressPercent}>{String(task.percent) + '%'}</span>
                        )}
                      </span>
                    )}
                    {task.state === 'failed' && task.reason !== undefined && (
                      <span className={styles.cardReason}>{task.reason}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {(merged.rows.length > 0 || queuedCount > 0 || clientFailures.length > 0) && (
          <section className={styles.group}>
            <ul className={styles.list}>
              {/* The rows only this panel knows about: the reader clicked, the Host has not
                  answered yet. Drawn FIRST so the click's own feedback appears at the top,
                  and styled as a normal queued card rather than a special case. */}
              {merged.queued.map(entry => (
                <li key={'queued:' + entry.relPath} className={styles.card}>
                  <span className={styles.cardRow}>
                    <FileTypeIcon path={entry.relPath} size={16} />
                    <Tooltip label={entry.relPath.slice(entry.relPath.lastIndexOf('/') + 1)} portal side="top" align="end">
                      <span className={styles.cardName}>{entry.relPath.slice(entry.relPath.lastIndexOf('/') + 1)}</span>
                    </Tooltip>
                    <span className={styles.badgeBusy}>{t('progressPending')}</span>
                  </span>
                  <span className={styles.cardPath}>{entry.relPath.slice(0, entry.relPath.lastIndexOf('/'))}</span>
                </li>
              ))}
              {extractions.map(task => {
                const described = describeExtraction(task, t)
                const failure = retryError?.relPath === task.relPath ? retryError.reason : undefined
                // The one failure with no point retrying: the source is gone, so the same
                // request fails identically until the file is back. Offering the button
                // would be a promise the Host cannot keep.
                const reason = task.state === 'failed' ? readFailureReason(task.reason, t) : undefined
                const missingFile = task.state === 'failed' && classifyExtractionFailure(task.reason ?? '') === 'missing-file'
                return (
                  <li key={task.relPath} className={styles.card}>
                    <span className={styles.cardRow}>
                      <FileTypeIcon path={task.relPath} size={16} />
                      <Tooltip label={task.relPath.slice(task.relPath.lastIndexOf('/') + 1)} portal side="top" align="end">
                        <span className={styles.cardName}>{task.relPath.slice(task.relPath.lastIndexOf('/') + 1)}</span>
                      </Tooltip>
                      {/* `already-markdown` takes the success tone: nothing was needed and
                          nothing went wrong, which is the opposite of the failure colour it
                          used to borrow. */}
                      <span className={task.state === 'succeeded' || task.state === 'already-markdown'
                        ? styles.badgeDone
                        : task.state === 'failed' || task.state === 'unsupported' ? styles.badgeFailed
                          : styles.badgeBusy}
                      >
                        {retrying === task.relPath ? t('progressRetrying') : described.text}
                      </span>
                    </span>
                    {task.markdown !== undefined && <span className={styles.cardPath}>{task.markdown}</span>}
                    {reason?.raw !== undefined && <span className={styles.cardReason}>{reason.text}</span>}
                    {reason?.raw !== undefined && reason.raw !== reason.text && (
                      <span className={styles.cardRawReason}>{t('progressRawReason').replace('{reason}', reason.raw)}</span>
                    )}
                    {described.canRetry && !missingFile && (
                      <span className={styles.cardActions}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retrying !== undefined}
                          onClick={() => { void retry(task.relPath) }}
                        >
                          {t('progressRetry')}
                        </Button>
                      </span>
                    )}
                    {failure !== undefined && (
                      <span className={styles.cardReason}>
                        {t('progressRetryFailed').replace('{reason}', failure)}
                      </span>
                    )}
                  </li>
                )
              })}
              {/* Request failures the Host never turned into a task. Drawn after the
                  authoritative rows so a retried path (which the Host now reports) does
                  not appear twice. */}
              {clientFailures.map(clientFailure => {
                const reason = readFailureReason(clientFailure.reason, t)
                const missingFile = classifyExtractionFailure(clientFailure.reason) === 'missing-file'
                const retryFailure = retryError?.relPath === clientFailure.relPath ? retryError.reason : undefined
                const name = clientFailure.relPath.slice(clientFailure.relPath.lastIndexOf('/') + 1)
                return (
                  <li key={'client-failed:' + clientFailure.relPath} className={styles.card}>
                    <span className={styles.cardRow}>
                      <FileTypeIcon path={clientFailure.relPath} size={16} />
                      <Tooltip label={name} portal side="top" align="end">
                        <span className={styles.cardName}>{name}</span>
                      </Tooltip>
                      <span className={styles.badgeFailed}>{t('progressFailedTitle')}</span>
                    </span>
                    <span className={styles.cardReason}>{reason.text}</span>
                    {reason.raw !== undefined && reason.raw !== reason.text && (
                      <span className={styles.cardRawReason}>{t('progressRawReason').replace('{reason}', reason.raw)}</span>
                    )}
                    {!missingFile && (
                      <span className={styles.cardActions}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retrying !== undefined}
                          onClick={() => { void retry(clientFailure.relPath) }}
                        >
                          {t('progressRetry')}
                        </Button>
                      </span>
                    )}
                    {retryFailure !== undefined && (
                      <span className={styles.cardReason}>
                        {t('progressRetryFailed').replace('{reason}', retryFailure)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </Modal>
    </>
  )
}
