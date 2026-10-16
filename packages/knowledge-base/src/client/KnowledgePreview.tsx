/**
 * The file preview shown in the management page's content region.
 *
 * The bytes come from this plugin's own read route rather than the borrowed
 * sidebar's session-scoped one. The listing needs no conversation, so a
 * session-backed read would let the page list files and refuse to open them, which
 * reads as a broken preview rather than as a missing session. A text read renders as
 * text; anything else reports its type, since a binary preview needs a viewer set.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useEffect, useState } from 'react'
import { IconDeliverDocRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath } from '../api.ts'
import styles from './KnowledgePanel.module.css'

/** Props for the preview surface. */
export interface KnowledgePreviewProps {
  /** Path of the selected file, relative to the mount point. */
  path: string
  /** Mount point the path belongs to; shown for orientation. */
  mountPoint: string
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'text'; body: string; truncated: boolean; mtimeMs?: number }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string }

/**
 * Render the selected file.
 * @param props - session, absolute path, and the mount point it belongs to.
 * @returns A preview surface or a status message.
 */
export function KnowledgePreview(props: KnowledgePreviewProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    void fetch(kbApiPath(KB_API.read), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: props.path }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          kind?: string
          content?: string
          truncated?: boolean
          mtimeMs?: number
          size?: number
          error?: string
        }
        if (!response.ok) throw new Error(result.error ?? 'HTTP ' + String(response.status))
        return result
      })
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'text') {
          setState({
            kind: 'text',
            body: result.content ?? '',
            truncated: result.truncated === true,
            // Spread rather than assign: the state shape treats the instant as
            // optional, and an explicit `undefined` fails exactOptionalPropertyTypes.
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          })
          return
        }
        setState({ kind: 'binary', size: result.size ?? 0 })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : c('previewFailed') })
      })
    return () => { cancelled = true }
  }, [props.path, props.mountPoint])

  // The file name is the page header's job, so the preview no longer repeats it.
  //
  // The non-content states use the product's shared centered panel state
  // (`TaskManagerPage.module.css` `.empty`: a caption-ink glyph over tertiary
  // copy), the same one the listing and the search results use. A bare
  // left-aligned grey sentence read as a stray paragraph.

  if (state.kind === 'loading') {
    return (
      <div className={styles.empty} role="status" aria-label={c('loading')}>
        <p className={styles.emptyTitle}>{c('loading')}</p>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className={styles.empty}>
        <IconWarningOutlineRegular size={24} className={styles.emptyGlyph} />
        <p className={styles.emptyTitle} role="alert">{state.message}</p>
      </div>
    )
  }
  if (state.kind === 'binary') {
    return (
      <div className={styles.empty}>
        <IconDeliverDocRegular size={24} className={styles.emptyGlyph} />
        <p className={styles.emptyTitle}>
          {c('previewBinarySize').replace('{size}', String(state.size))}
        </p>
      </div>
    )
  }
  return (
    <div className={styles.surface}>
      {/* Only the instant is repeated here: the header already carries the file
          name and the mount point, so a second path line said nothing new. */}
      {state.mtimeMs !== undefined && (
        <p className={styles.path}>
          {c('modifiedAt')} {new Date(state.mtimeMs).toLocaleString()}
        </p>
      )}
      <pre className={styles.preview}>{state.body}</pre>
      {state.truncated && <p className={styles.muted}>{c('previewTruncated')}</p>}
    </div>
  )
}
