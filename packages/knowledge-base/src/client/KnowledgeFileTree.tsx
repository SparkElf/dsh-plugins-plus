/**
 * The knowledge tree, drawn by the product's own file explorer.
 *
 * The listing next door is a hand-built copy of `dsh-better-sidebar`'s explorer: its CSS
 * module says so ("Copied from the file explorer in dsh-better-sidebar", with each metric
 * measured against `.explorerRow`). A copy drifts -- the explorer gains sort controls,
 * inline rename, an upload strip, git tones, an open-with submenu, none of which arrive
 * in a copy -- so this component renders the REAL explorer instead, pointed at the
 * knowledge root.
 *
 * That is possible because `/workspace/kb` is a symlink into the caller's view: the
 * explorer's `cwd` is a plain absolute path, so pointing it there reads the knowledge tree
 * through exactly the machinery that reads any other workspace directory. Measured before
 * writing this: `POST /sidebar/api/fs.trees {cwd:'/workspace/kb'}` answers the tree's
 * entries, so no new route and no second file API are involved.
 *
 * What the explorer does NOT know about is the knowledge base's own metadata files
 * (`.kb-audit.jsonl`, `.kb-settings.json`, `.pinned.json`, `.view-mode.json`). They live in
 * the view so every user's copy carries them, and they are neither knowledge documents nor
 * anything a reader should rename. They are filtered with the `exclude` prop, which the
 * host applies to the listing -- so they never arrive rather than being hidden after the
 * fact.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useMemo } from 'react'
import { FileTree } from 'dsh-better-sidebar/src/client/FileTree.tsx'
import type { UploadItem } from 'dsh-better-sidebar/src/client/upload.ts'

/**
 * Files the explorer must not list.
 *
 * The leading dot alone is not enough: the explorer shows hidden files by its own setting,
 * and these six are the plugin's state, not the reader's documents. Naming them exactly
 * keeps a genuine `.env` or `.gitignore` a reader put in the knowledge base visible.
 */
const METADATA_NAMES = [
  '.kb-audit.jsonl',
  '.kb-settings.json',
  '.kb-pending',
  '.kb-trash.json',
  '.pinned.json',
  '.view-mode.json',
] as const

/** Props for the knowledge tree. */
export interface KnowledgeFileTreeProps {
  /** The conversation this tree belongs to; the explorer keys its fs requests by it. */
  sessionId: string
  /** Absolute path of the knowledge root inside the workspace. */
  root: string
  /** Directories the reader has expanded, by absolute path. */
  expanded: readonly string[]
  /** Files highlighted by a "show in folder" reveal, by absolute path. */
  revealed: readonly string[]
  /** Toggle one directory open or closed. */
  onToggle: (path: string) => void
  /** Open one file for preview. */
  onOpenFile: (path: string) => void
  /** Insert a reference to one path into the conversation draft. */
  onReferenceFile: (path: string, isDir: boolean) => void
  /** Upload files into a directory (absolute, inside the knowledge root). */
  onUploadRequest: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight. */
  busy: boolean
  /** Bump to reload the visible set after a change made elsewhere. */
  refreshTick: number
  /** Called after the explorer's own inline rename lands. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** Called after the explorer's own delete lands. */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Whether the owning surface is on screen. */
  visible?: boolean
}

/**
 * The knowledge tree, rendered by the product's file explorer.
 * @param props - the root, the reader's expansion state, and the actions.
 * @returns The explorer's tree, rooted at the knowledge directory.
 */
export function KnowledgeFileTree(props: KnowledgeFileTreeProps) {
  const {
    sessionId, root, expanded, revealed, onToggle, onOpenFile,
    onReferenceFile, onUploadRequest, busy, refreshTick,
  } = props

  // The explorer wants mutable arrays; the props are readonly so a caller cannot mutate
  // the reader's expansion state through the child. A stable identity per value keeps the
  // explorer from wiping its level cache on every render.
  const expandedList = useMemo(() => [...expanded], [expanded])
  const revealedList = useMemo(() => [...revealed], [revealed])

  /** Every exclusion pattern at once, in the one array identity the explorer keys on. */
  const exclude = useMemo(() => METADATA_NAMES.map(name => `**/${name}`), [])

  /**
   * Pass the explorer's own rename through to the caller.
   *
   * The explorer performs the rename through the workspace file API, which writes to the
   * knowledge tree directly -- the entry really moved. What it cannot do is update the
   * caller's view metadata (the audit log, any open tab), which is what the callback is
   * for. It is optional because a read-only surface has nothing to retarget.
   */
  const onRenamed = useCallback((oldPath: string, newPath: string) => {
    props.onPathRenamed?.(oldPath, newPath)
  }, [props.onPathRenamed])

  return (
    <FileTree
      sessionId={sessionId}
      cwd={root}
      expanded={expandedList}
      revealed={revealedList}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
      onReferenceFile={onReferenceFile}
      exclude={exclude}
      refreshTick={refreshTick}
      onUploadRequest={onUploadRequest}
      busy={busy}
      visible={props.visible ?? true}
      // The tree is already scoped to the knowledge root, so a row naming that root
      // would repeat a level the reader never navigates through.
      hideRoot
      // Readers open one document at a time; the batch bar answers Ctrl/Shift-click
      // gestures this surface does not use, and costs a row of height when it shows.
      selectionBar={false}
      onPathRenamed={props.onPathRenamed === undefined ? undefined : onRenamed}
      onPathDeleted={props.onPathDeleted}
    />
  )
}
