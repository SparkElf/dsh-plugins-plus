/**
 * A directory listing with the modification time each entry carries.
 *
 * The row is the file explorer's own row from `dsh-better-sidebar`, copied from
 * `src/client/FileTree.tsx` (`FileRow`/`DirRow`) and `src/client/sidebar.module.css`
 * (`.explorerRow`): the same `div[role=button]`, the same 14px glyph, the same
 * ellipsised name, the same trailing modified time that yields its right edge to
 * the same hover-revealed `@` reference button, and the same `depth * 22 + 6`
 * indent. A reader sees that tree in this window's right sidebar, so a second
 * design beside it reads as bolted on -- which is why this is a copy rather than
 * a re-drawing.
 *
 * What the borrowed tree cannot carry is why this list exists. Its host entry
 * shape (`FsEntry`: name, path, isDir, hidden, isSymlink, broken) has no
 * timestamp, so a row built from it can never show when a document last changed;
 * and its rows decide visibility from a shared curated store rather than from
 * per-user grants. This panel reads the same directories through the plugin's own
 * route, which stats each child, and its row carries a right-click into the grant
 * form the tree has no place for.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { KB_API, kbApiPath } from '../api.ts'
import { FileTypeIcon, IconFolderOpenRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './KnowledgeListing.module.css'

/** One entry, as the Host returns it. */
interface Entry {
  /** Path relative to the mount point. */
  relPath: string
  /** Name alone. */
  name: string
  /** Whether this entry is a directory. */
  isDir: boolean
  /** Last-modified instant in Unix ms. */
  mtimeMs?: number
  /** Size in bytes for files. */
  size?: number
  /** Whether the caller may read this path, as DataOps resolved it. */
  readable?: boolean
  /** Child count for a directory row. */
  childCount?: number
}

/** Props for the listing panel. */
export interface KnowledgeListingProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Called with a chosen path so the page can show its preview. */
  onOpen: (path: string) => void
  /** Re-read trigger, so a rescan from elsewhere refreshes this too. */
  refreshTick?: number
  /** Locale tag, so dates match the reader's language. */
  locale?: string
  /**
   * Open the permission surface for one path.
   *
   * Exists because the borrowed tree's context menu is built inside it with no way
   * to add a row, so the grant entry lives here instead: this is the plugin's own
   * listing, where a right-click can mean what the knowledge base needs it to mean.
   */
  onGrant?: (path: string) => void
  /**
   * Insert one row's reference into the conversation draft.
   *
   * The borrowed tree reveals this affordance on hover; the listing mirrors that so
   * a reader gets the same `@` action from either tree.
   */
  onReference?: (path: string, isDir: boolean) => void
}

/**
 * The explorer's `formatModified`, copied: the clock for a file touched today,
 * the date otherwise. A relative span reads well for the recent past but hides
 * which of two old documents is newer, and a listing is usually scanned for that.
 * @param mtimeMs - the instant, in Unix ms.
 * @returns A short fixed-width label, or an empty string for an unreadable stamp.
 */
function formatModified(mtimeMs: number): string {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay
    ? String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    : String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/**
 * The explorer's `formatModifiedTitle`: the full stamp behind the row's tooltip.
 * @param mtimeMs - the instant, in Unix ms.
 * @param locale - locale tag for the absolute form.
 * @returns The locale string, or an empty string for an unreadable timestamp.
 */
function formatModifiedTitle(mtimeMs: number, locale: string): string {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US')
}

/**
 * Render the listing for the mount's top level, and one level per expanded
 * directory.
 * @param props - copy resolver and the open callback.
 * @returns The listing panel.
 */
export function KnowledgeListing(props: KnowledgeListingProps) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [open, setOpen] = useState<readonly string[]>([])
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  const read = useCallback(async (path: string): Promise<Entry[]> => {
    const response = await fetch(kbApiPath(KB_API.list), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(String(response.status))
    const body = (await response.json()) as { entries?: Entry[] }
    return body.entries ?? []
  }, [])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void read('').then((rows) => {
      if (cancelled) return
      setEntries(rows)
      setState('ready')
    }).catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [read, props.refreshTick])

  // Expanded directories keep their own children, so collapsing and reopening one
  // does not re-read it.
  useEffect(() => {
    let cancelled = false
    for (const path of open) {
      if (children[path] !== undefined) continue
      void read(path).then((rows) => {
        if (cancelled) return
        setChildren(current => ({ ...current, [path]: rows }))
      }).catch(() => { /* a failed level simply shows nothing */ })
    }
    return () => { cancelled = true }
  }, [open, children, read])

  const locale = props.locale ?? 'zh-CN'

  /**
   * Toggle a directory, or open a file.
   *
   * The explorer splits this between its file and directory rows; one row shape
   * here covers both, so the branch lives in one place and the click and keyboard
   * paths share it.
   */
  const activate = (entry: Entry): void => {
    if (entry.isDir) {
      setOpen(current => current.includes(entry.relPath)
        ? current.filter(item => item !== entry.relPath)
        : [...current, entry.relPath])
      return
    }
    props.onOpen(entry.relPath)
  }

  /**
   * Render one row, indented by depth.
   *
   * Copied from the explorer's `FileRow`/`DirRow`: the same element, then the
   * leading 14px glyph, then the name, then the time, then the reference button.
   * The permission lamp and the size column this list used to carry are gone:
   * neither exists in the tree this row is copied from, and an unreadable path is
   * removed on the Host rather than drawn as a marker.
   */
  const row = (entry: Entry, depth: number) => (
    <div
      key={entry.relPath}
      role="button"
      tabIndex={0}
      className={entry.isDir ? styles.entry + ' ' + styles.entryDir : styles.entry}
      // The explorer's own indent step: 22px per level plus its 6px inset.
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.relPath}
      onClick={() => { activate(entry) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate(entry)
        }
      }}
      onContextMenu={(event) => {
        // The grant entry reaches the surface a right-click cannot: a row is
        // where an operator already has a path in mind.
        if (props.onGrant === undefined) return
        event.preventDefault()
        props.onGrant(entry.relPath)
      }}
    >
      <span className={styles.entryGlyph} aria-hidden="true">
        {entry.isDir
          // The explorer draws a directory with the one folder glyph the host ships.
          ? <IconFolderOpenRegular size={14} />
          : <FileTypeIcon path={entry.name} size={14} />}
      </span>
      <span className={styles.entryName}>{entry.name}</span>
      {entry.mtimeMs !== undefined && (
        <span className={styles.entryTime} title={formatModifiedTitle(entry.mtimeMs, locale)}>
          {formatModified(entry.mtimeMs)}
        </span>
      )}
      {props.onReference !== undefined && (
        <button
          type="button"
          className={styles.entryRef}
          aria-label={props.t('referenceFile')}
          title={props.t('referenceFile')}
          onClick={(event) => {
            // Stops the row's own click: referencing a file must not also open it.
            event.stopPropagation()
            props.onReference?.(entry.relPath, entry.isDir)
          }}
        >
          @
        </button>
      )}
    </div>
  )

  /** One level, plus each expanded child directory's own level. */
  const level = (rows: Entry[], depth: number): JSX.Element[] =>
    rows.map((entry) => {
      const expanded = open.includes(entry.relPath)
      return (
        <li key={entry.relPath}>
          {row(entry, depth)}
          {entry.isDir && expanded && children[entry.relPath] !== undefined && (
            <ul className={styles.entryChildren}>{level(children[entry.relPath] ?? [], depth + 1)}</ul>
          )}
        </li>
      )
    })

  // The product's shared centered panel state, not a bare grey sentence.
  if (state === 'loading') {
    return (
      <div className={styles.empty} role="status" aria-label={props.t('loading')}>
        <p className={styles.emptyTitle}>{props.t('loading')}</p>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle} role="alert">{props.t('searchFailed')}</p>
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p className={styles.emptyTitle}>{props.t('searchEmpty')}</p>
      </div>
    )
  }

  return <ul className={styles.entries}>{level(entries, 0)}</ul>
}
