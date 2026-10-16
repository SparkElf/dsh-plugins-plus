/**
 * The indexing surface of the management page.
 *
 * There is no separate index to build. Retrieval reads the mounted tree directly
 * with grep and read, so the page reports that tree's shape: a "rebuild" is a
 * rescan of the mount, and it answers synchronously. Presenting it as a
 * background job would invent a queue the plugin does not have.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type KnowledgeStatusView } from '../api.ts'
import styles from './KnowledgePanel.module.css'

/** Props for the indexing surface. */
export interface KnowledgeIndexingProps {
  /** Status the page already loaded, used for the first paint. */
  status: KnowledgeStatusView
  /** Called after a rescan, so the page can refresh what it shows. */
  onChanged: () => void
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
}

/**
 * Render the index state and rescan control.
 * @param props - the loaded status and a refresh callback.
 * @returns The indexing surface.
 */
export function KnowledgeIndexing(props: KnowledgeIndexingProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [count, setCount] = useState<number | null>(props.status.visibleFiles)

  /** Rescan the mount and report the new shape. */
  const rescan = async (): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.index), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const result = (await response.json()) as KnowledgeStatusView
      setCount(result.visibleFiles)
      setNotice(c('rescanDone'))
      props.onChanged()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('rescanFailed'))
    } finally { setBusy(false) }
  }

  return (
    <div className={styles.surface}>
      <dl className={styles.pairs}>
        <div className={styles.pair}>
          <dt>{c('visibleFiles')}</dt>
          <dd>{count === null ? c('notMounted') : String(count)}</dd>
        </div>
        <div className={styles.pair}>
          <dt>{c('retrieval')}</dt>
          <dd>{c('indexingNote')}</dd>
        </div>
      </dl>

      {notice !== undefined && <p className={styles.notice}>{notice}</p>}

      <Button
        variant="primary"
        disabled={busy}
        onClick={() => { void rescan() }}
      >
        {busy ? c('rescanning') : c('rescan')}
      </Button>
    </div>
  )
}
