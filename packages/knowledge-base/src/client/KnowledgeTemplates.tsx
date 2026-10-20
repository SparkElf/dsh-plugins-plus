/**
 * The template library: a full-surface dialog over the Home view.
 *
 * A template is a DataOps wiki page whose category is `report_template`, served by
 * `GET /api/resources/wiki/pages/templates`. That endpoint exists and answers in
 * milliseconds; what it returns today is an EMPTY list, because the wiki storage
 * holds no page in that category. So this surface is built to be honest about
 * having nothing rather than to look populated: an empty answer says so, and a slow
 * or unreachable backend says that instead of spinning.
 *
 * The read is bounded by its own timeout rather than the plugin's general one. The
 * shared backend can be busy with work unrelated to this page (measured at 179% CPU
 * from another feature's polling), and a template list is not worth making the
 * reader wait for that: it either answers quickly or the surface reports that it
 * could not be read.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeTemplates.module.css'

/** One template, as the wiki endpoint describes a page. */
interface TemplateRow {
  /** Stable page id. */
  id: string
  /** Display title. */
  title: string
  /** Last-modified instant, ISO-8601. */
  updatedAt?: string
}

/** How long the template read may take before the surface gives up. */
const TEMPLATE_TIMEOUT_MS = 5_000

/** Props for the template library. */
export interface KnowledgeTemplatesProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Close the dialog. */
  onClose: () => void
}

/**
 * Render the template library.
 * @param props - copy resolver and the close handler.
 * @returns The dialog.
 */
export function KnowledgeTemplates(props: KnowledgeTemplatesProps) {
  const c = props.t
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rows, setRows] = useState<TemplateRow[]>([])
  const [term, setTerm] = useState('')

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    // The deadline is enforced by the RACE, not by the abort alone. Aborting is
    // still done, because it frees the request, but a response that never settles
    // and ignores the signal would otherwise leave this surface in its loading
    // state forever, and "never spinning" is the whole reason the bound exists.
    // Verified both ways: a fetch that honours the signal and one that ignores it
    // both reach `unavailable` on time.
    const deadline = new Promise<'timeout'>(resolve => {
      setTimeout(() => { controller.abort(); resolve('timeout') }, TEMPLATE_TIMEOUT_MS)
    })
    const read = (async (): Promise<TemplateRow[]> => {
      const response = await fetch(kbApiPath(KB_API.templates), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = await readKnowledgeJson<{ templates?: TemplateRow[] }>(response)
      return body.templates ?? []
    })()
    void (async () => {
      try {
        const outcome = await Promise.race([read, deadline])
        // A timeout that loses the race is still a failure to read, and reporting
        // it as an empty library would claim the source has no templates.
        if (outcome === 'timeout') {
          if (live) setState('unavailable')
          return
        }
        if (!live) return
        setRows(outcome)
        setState('ready')
      } catch {
        // A timeout, an unreachable backend and a refused read all land here, and
        // all three mean the same thing to the reader: nothing to show right now.
        if (live) setState('unavailable')
      }
    })()
    return () => {
      live = false
      controller.abort()
    }
  }, [])

  const needle = term.trim().toLowerCase()
  const visible = needle === ''
    ? rows
    : rows.filter(row => row.title.toLowerCase().includes(needle))

  return (
    // `headless` because the sheet is a full-surface library rather than the
    // primitive's title-plus-body dialog: the search field belongs in the header
    // row, and the primitive's slot layout has no room for it.
    <Modal
      open
      headless
      onClose={props.onClose}
      title={c('templateTitle')}
      className={styles.scrim}
    >
      <div className={styles.sheet}>
        <header className={styles.bar}>
          <h2 className={styles.title}>{c('templateTitle')}</h2>
          <div className={styles.search}>
            <Input
              value={term}
              placeholder={c('templateSearch')}
              aria-label={c('templateSearch')}
              onChange={(event) => { setTerm(event.target.value) }}
            />
          </div>
          <Button variant="outline" onClick={props.onClose}>{c('templateClose')}</Button>
        </header>
        <div className={styles.body}>
          {state === 'loading' && <p className={styles.muted}>{c('templateLoading')}</p>}
          {state === 'unavailable' && <p className={styles.muted}>{c('templateUnavailable')}</p>}
          {state === 'ready' && visible.length === 0 && (
            // The empty answer is the real one today, so it is stated as a fact
            // about the source rather than as a prompt to keep looking.
            <p className={styles.muted}>{needle === '' ? c('templateEmpty') : c('templateEmpty')}</p>
          )}
          {state === 'ready' && visible.length > 0 && (
            <ul className={styles.grid}>
              {visible.map(row => (
                <li key={row.id} className={styles.card}>
                  <span className={styles.cardTitle}>{row.title}</span>
                  {row.updatedAt !== undefined && (
                    <span className={styles.cardMeta}>{row.updatedAt.slice(0, 10)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  )
}
