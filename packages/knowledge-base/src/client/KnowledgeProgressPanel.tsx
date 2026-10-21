/**
 * The progress strip at the bottom of the knowledge base panel.
 *
 * Uploading a document and extracting its text are two waits a reader cannot see
 * otherwise: the drop appears to do nothing until the bytes land, and a scanned PDF
 * looks uploaded while its `.md` sibling is still being produced. Both are reported
 * here, in one place, at the bottom of the surface the reader is already looking at.
 *
 * It is a resident strip rather than a toast on purpose. A toast is gone before a slow
 * parse finishes, and the reader's next question ("did it work?") has nowhere to go;
 * this stays until the work is done and then folds to one line so it stops taking
 * space without taking the record away.
 *
 * Nothing here is persisted. A refresh loses the history, which is the right trade: the
 * files themselves are on disk, and a stale "uploading 40%" from yesterday would be a
 * lie the reader cannot clear.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type ExtractionStatusView, type ExtractionTaskView } from '../api.ts'
import { canRetryExtraction, shouldFoldStrip } from './progressRules.ts'
import styles from './KnowledgeProgressPanel.module.css'

/** One file's upload, as the strip shows it. */
export interface UploadTaskView {
  /** The file's path relative to the drop target: the name the reader dropped. */
  name: string
  /** The tree-relative directory it is landing in, `''` for the mount root. */
  dir: string
  /** Where this file is in its own lifecycle. */
  state: 'waiting' | 'uploading' | 'done' | 'failed'
  /** Why it failed, in the Host's own words. */
  reason?: string
}

/** Props for the progress strip. */
export interface KnowledgeProgressPanelProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** The batch currently uploading, oldest first; empty when nothing is in flight. */
  uploads: readonly UploadTaskView[]
  /**
   * Whether to read extraction progress at all.
   *
   * False on a surface that cannot extract (no mount, or a caller without write
   * access): polling a route whose answer can never be acted on is a request per
   * reader that buys nothing.
   */
  watchExtraction: boolean
  /** Called after a retry was accepted, so the caller can refresh its own views. */
  onRetried?: (relPath: string) => void
}

/** How often to re-read extraction progress while something is pending. */
const POLL_MS = 1_500

/** Which extraction states are still worth polling for. */
const ACTIVE_STATES = new Set(['pending', 'running'])

/** The strip's own fold state: open while working, folded once everything settled. */
type Fold = 'open' | 'folded'

/**
 * Render one extraction task's state as a sentence.
 * @param task - the task from the Host.
 * @param t - copy resolver.
 * @returns The sentence and whether a retry would make sense.
 */
function describeExtraction(
  task: ExtractionTaskView,
  t: KnowledgeProgressPanelProps['t'],
): { text: string; canRetry: boolean } {
  if (task.state === 'pending') return { text: t('progressPending'), canRetry: canRetryExtraction(task.state) }
  if (task.state === 'running') {
    // `via` names the authority doing the work, when the Host knows it yet.
    return {
      text: task.via === undefined ? t('progressExtracting') : t('progressExtractingVia').replace('{via}', task.via),
      canRetry: canRetryExtraction(task.state),
    }
  }
  if (task.state === 'succeeded') return { text: t('progressSucceeded'), canRetry: canRetryExtraction(task.state) }
  // An unsupported type has no extractor, so a retry would fail again for the same
  // reason: the row states the fact and offers nothing to press.
  if (task.state === 'unsupported') return { text: t('progressUnsupported'), canRetry: canRetryExtraction(task.state) }
  return { text: t('progressFailed').replace('{reason}', task.reason ?? ''), canRetry: canRetryExtraction(task.state) }
}

/**
 * Render the bottom progress strip.
 * @param props - the upload batch, whether to watch extraction, and the copy resolver.
 * @returns The strip, or nothing when there is no work to show.
 */
export function KnowledgeProgressPanel(props: KnowledgeProgressPanelProps) {
  const t = props.t
  const [extractions, setExtractions] = useState<ExtractionTaskView[]>([])
  const [fold, setFold] = useState<Fold>('open')
  /** The task being retried, so only its own row shows the pending state. */
  const [retrying, setRetrying] = useState<string | undefined>(undefined)
  const [retryError, setRetryError] = useState<{ relPath: string; reason: string } | undefined>(undefined)
  /** Set once a batch has settled, so the fold can happen exactly once. */
  const settled = useRef(false)

  const readExtractions = useCallback(async (): Promise<ExtractionTaskView[]> => {
    const response = await fetch(kbApiPath(KB_API.extractStatus), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    // `readKnowledgeJson` is typed for a plain object of unknown fields; this
    // response has a declared shape, so it is decoded directly.
    const body = (await response.json()) as ExtractionStatusView
    return body.tasks ?? []
  }, [])

  // Poll only while something is actually pending: an idle panel must not cost a
  // request every second and a half forever.
  useEffect(() => {
    if (!props.watchExtraction) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const tasks = await readExtractions()
        if (!live) return
        setExtractions(tasks)
        if (tasks.some(task => ACTIVE_STATES.has(task.state))) {
          timer = setTimeout(() => { void tick() }, POLL_MS)
        }
      } catch {
        // A failed read leaves the last known state on screen; the strip is not the
        // place to shout about a transient Host hiccup.
        if (live) timer = setTimeout(() => { void tick() }, POLL_MS)
      }
    }
    void tick()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.watchExtraction, readExtractions])

  const upload = useMemo(() => {
    const done = props.uploads.filter(task => task.state === 'done').length
    const failed = props.uploads.filter(task => task.state === 'failed').length
    const settledAll = props.uploads.length > 0 && done + failed === props.uploads.length
    return { done, failed, settledAll }
  }, [props.uploads])

  const extraction = useMemo(() => {
    const done = extractions.filter(task => task.state === 'succeeded').length
    const failed = extractions.filter(task => task.state === 'failed').length
    const active = extractions.filter(task => ACTIVE_STATES.has(task.state)).length
    return { done, failed, active, settledAll: extractions.length > 0 && active === 0 }
  }, [extractions])

  // Fold once, when the last batch reached a terminal state. `settled` keeps it from
  // re-folding after the reader opened it to read the result.
  useEffect(() => {
    const everythingSettled = (props.uploads.length === 0 || upload.settledAll)
      && (extractions.length === 0 || extraction.settledAll)
    if (shouldFoldStrip(props.uploads, extractions, settled.current)) {
      settled.current = true
      setFold('folded')
    }
    if (!everythingSettled) {
      settled.current = false
      setFold('open')
    }
  }, [props.uploads.length, upload.settledAll, extractions.length, extraction.settledAll])

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
      // Re-read immediately so the row leaves "failed" without waiting a poll cycle.
      setExtractions(await readExtractions())
      props.onRetried?.(relPath)
    } catch (error: unknown) {
      setRetryError({ relPath, reason: error instanceof Error ? error.message : 'retry failed' })
    } finally {
      setRetrying(undefined)
    }
  }, [props, readExtractions])

  const hasWork = props.uploads.length > 0 || extractions.length > 0
  // Nothing has ever been queued: the strip is not rendered at all, because an empty
  // resident row is pure noise at the bottom of a page the reader uses all day.
  if (!hasWork) return null

  const summary = (): string => {
    const parts: string[] = []
    if (props.uploads.length > 0) {
      parts.push(t('progressSummary').replace('{uploaded}', String(upload.done)).replace('{failed}', String(upload.failed)))
    }
    if (extractions.length > 0) {
      parts.push(t('progressSummaryExtract').replace('{done}', String(extraction.done)).replace('{failed}', String(extraction.failed)))
    }
    return parts.join(' · ')
  }

  return (
    <section className={styles.strip} aria-label={t('progressTitle')}>
      <header className={styles.head}>
        <span className={styles.summary}>{summary()}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setFold(current => (current === 'open' ? 'folded' : 'open')) }}
        >
          {fold === 'open' ? t('progressCollapse') : t('progressExpand')}
        </Button>
      </header>

      {fold === 'open' && (
        <div className={styles.body}>
          {props.uploads.length > 0 && (
            <div className={styles.group}>
              <span className={styles.groupTitle}>
                {t('progressUploadGroup')} {upload.done}/{props.uploads.length}
              </span>
              <ul className={styles.list}>
                {props.uploads.map(task => (
                  <li key={task.name} className={styles.row}>
                    <span className={styles.name} title={task.name}>{task.name}</span>
                    <span className={styles.dir}>{task.dir === '' ? t('progressRoot') : task.dir}</span>
                    <span className={styles.state}>
                      {task.state === 'waiting' && t('dropUploading')}
                      {task.state === 'uploading' && t('dropUploading')}
                      {task.state === 'done' && t('progressSucceeded')}
                      {task.state === 'failed' && t('progressFailed').replace('{reason}', task.reason ?? '')}
                    </span>
                    {/* A thin bar rather than a spinner: the reader is looking at a
                        column of rows and needs to see how far the batch got at a
                        glance, not that something is happening somewhere. */}
                    <span className={styles.bar} aria-hidden="true">
                      <span
                        className={styles.barFill}
                        style={{
                          width: task.state === 'done' ? '100%'
                            : task.state === 'failed' ? '100%'
                              : task.state === 'uploading' ? '50%' : '0%',
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {extractions.length > 0 && (
            <div className={styles.group}>
              <span className={styles.groupTitle}>
                {t('progressExtractGroup')} {extraction.done}/{extractions.length}
              </span>
              <ul className={styles.list}>
                {extractions.map(task => {
                  const described = describeExtraction(task, t)
                  const failure = retryError?.relPath === task.relPath ? retryError.reason : undefined
                  return (
                    <li key={task.relPath} className={styles.row}>
                      <span className={styles.name} title={task.relPath}>
                        {task.relPath.slice(task.relPath.lastIndexOf('/') + 1)}
                      </span>
                      <span className={styles.dir}>
                        {task.markdown === undefined ? '' : task.markdown}
                      </span>
                      <span className={styles.state}>
                        {retrying === task.relPath ? t('progressRetrying') : described.text}
                        {failure !== undefined && ' — ' + t('progressRetryFailed').replace('{reason}', failure)}
                      </span>
                      {described.canRetry && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retrying !== undefined}
                          onClick={() => { void retry(task.relPath) }}
                        >
                          {t('progressRetry')}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
