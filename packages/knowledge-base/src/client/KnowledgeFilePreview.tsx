/**
 * In-page document preview for the knowledge page.
 *
 * The knowledge page is a global main panel, and the host's right sidebar only
 * renders a session-bound preview while a conversation is the active panel. When
 * the host column is unavailable, this pane is the fallback the reader actually
 * sees: it reads the document through the same permission-checked `read` route the
 * preview pane uses and shows the text in place of the old "opened on the right"
 * notice.
 *
 * It deliberately does not replace the host viewer: when `openInSidebar` succeeds
 * the host tab still owns the document. This pane is the non-blank fallback for the
 * profile where that column cannot mount.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useEffect, useState } from 'react'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeFilePreview.module.css'

/** Props for the fallback preview. */
export interface KnowledgeFilePreviewProps {
  /** View-relative document path. */
  path: string
  /** Copy resolver. */
  t: (key: string) => string
  /** Close the preview and return to the tree's previous surface. */
  onClose: () => void
}

/** What the read route answered. */
type ReadState =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'failed'; error: string }

/**
 * Render one document read through the knowledge read route.
 *
 * @param props - the path, copy, and close command.
 * @returns The preview pane.
 */
export function KnowledgeFilePreview(props: KnowledgeFilePreviewProps) {
  const [state, setState] = useState<ReadState>({ kind: 'loading' })
  const name = props.path.slice(props.path.lastIndexOf('/') + 1)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.read), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: props.path }),
          cache: 'no-store',
        })
        const body = await readKnowledgeJson<Record<string, unknown>>(response)
        if (!response.ok || typeof body.error === 'string') {
          throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status))
        }
        if (!alive) return
        if (body.kind === 'text' && typeof body.content === 'string') {
          setState({ kind: 'text', content: body.content, truncated: body.truncated === true })
        } else if (body.kind === 'binary') {
          setState({ kind: 'binary', size: typeof body.size === 'number' ? body.size : 0 })
        } else {
          setState({ kind: 'failed', error: props.t('previewFailed') })
        }
      } catch (error) {
        if (!alive) return
        setState({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { alive = false }
  }, [props.path, props.t])

  return (
    <div className={styles.root} data-testid="kg-file-preview">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h3 className={styles.title}>{name}</h3>
          <p className={styles.path}>{props.path}</p>
        </div>
        <button type="button" className={styles.close} onClick={props.onClose} aria-label={props.t('previewClose')}>
          ×
        </button>
      </header>
      <div className={styles.body}>
        {state.kind === 'loading' && <p className={styles.notice}>{props.t('previewLoading')}</p>}
        {state.kind === 'failed' && <p className={styles.error}>{props.t('previewFailed')} {state.error}</p>}
        {state.kind === 'binary' && (
          <p className={styles.notice}>{props.t('previewBinarySize').replace('{size}', String(state.size))}</p>
        )}
        {state.kind === 'text' && (
          <>
            {state.truncated && <p className={styles.notice}>{props.t('previewTruncated')}</p>}
            <pre className={styles.pre}>{state.content}</pre>
          </>
        )}
      </div>
    </div>
  )
}
