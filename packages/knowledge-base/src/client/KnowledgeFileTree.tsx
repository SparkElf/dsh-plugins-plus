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
 * (`.kb-audit.jsonl`, `.kb-settings.json`, `.kb-tree-state.json`, `.pinned.json`,
 * `.view-mode.json`, `.kb-favorites.json`, `.kb-trash.json`). They live in the view so
 * every user's copy carries them, and they are neither knowledge documents nor anything
 * a reader should rename. They are filtered with the `exclude` prop, which the host
 * applies to the listing -- so they never arrive rather than being hidden after the fact.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useMemo } from 'react'
import { FileTree } from 'dsh-better-sidebar/src/client/FileTree.tsx'
import type { UploadItem } from 'dsh-better-sidebar/src/client/upload.ts'
import { departmentPathLabels, folderLabelOf, type DepartmentPath } from './departmentFolders.ts'
import { VIEW_METADATA_FILENAMES } from '../viewMetadata.ts'

/**
 * Files the explorer must not list.
 *
 * The leading dot alone is not enough: the explorer shows hidden files by its own setting,
 * and these are the plugin's state, not the reader's documents. Naming them exactly
 * keeps a genuine `.env` or `.gitignore` a reader put in the knowledge base visible.
 *
 * Taken from the Host rather than listed again here. A second copy is what let
 * `.kb-favorites.json` reach the tree as an openable document: favourites were added
 * to the view directory and this list was not updated with them. `VIEW_METADATA_FILENAMES`
 * is derived from the very `*PathFor` helpers that write those files, so a new state
 * file cannot be forgotten.
 */
const METADATA_NAMES: readonly string[] = VIEW_METADATA_FILENAMES

/** Props for the knowledge tree. */
/**
 * Express an absolute tree path the way the bucket map is keyed.
 *
 * The explorer speaks absolute paths; the map is built from the three folder names, so
 * the two have to meet somewhere. Stripping the root here keeps that conversion next to
 * the only code that needs it, rather than asking every caller to pre-relativise.
 * @param root - absolute mount point of the knowledge tree.
 * @param absolute - absolute path of the row being labelled.
 * @returns the path relative to `root`, unchanged when it is not under it.
 */
function relativeToRoot(root: string, absolute: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  if (absolute === base) return ''
  return absolute.startsWith(base + '/') ? absolute.slice(base.length + 1) : absolute
}

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
  /**
   * Say the three buckets in the reader's language.
   *
   * `global` / `department` / `personal` are the folders' names on disk, and they have
   * to stay that way: they are path segments the deployment shares and the caller's
   * view is built from them. What the reader is being told by that folder is not its
   * path but its AUDIENCE -- who may see what is inside -- so the row prints the
   * audience and the path is left alone.
   *
   * Keyed by the tree-relative path, so the map can be built from copy alone.
   */
  bucketLabels?: Readonly<Record<string, string>>
  /**
   * The reader's own organization chain, so department folders print their NAME.
   *
   * The department bucket stores folders by code (`nanning-psb`), because a code is a
   * stable slug: renaming a department cannot move a document. The reader, though,
   * knows their organization by name, so those same rows have to print
   * 「南宁市公安局」 rather than the slug.
   *
   * Only the caller's own chain is translated, and only within the department bucket.
   * A peer department's folder keeps printing its code: this build has no name for it,
   * and the whole organization tree is readable only by an administrator. Deriving a
   * "name" from the code would put an invented label in front of the reader, which is
   * worse than the code they can at least match against their own department.
   */
  departmentPath?: DepartmentPath
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

  /**
   * One lookup over both label sources, or undefined when there is nothing to label.
   *
   * Built once per render rather than per row: the explorer asks for a label for every
   * visible folder, and rebuilding a map inside that callback would repeat the work on
   * each expansion. `departmentPath` is destructured to its two arrays so the memo
   * depends on their identity and not on the object the parent allocates each render.
   */
  const departmentCodes = props.departmentPath?.codes
  const departmentNames = props.departmentPath?.names
  const dirLabelOf = useMemo(() => {
    const chainLabels = departmentPathLabels(departmentCodes, departmentNames)
    if (props.bucketLabels === undefined && chainLabels === undefined) return undefined
    return (relPath: string): string | undefined =>
      folderLabelOf(relPath, props.bucketLabels, chainLabels)
  }, [props.bucketLabels, departmentCodes, departmentNames])

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
      // Every row whose printed name is not the reader's word for it: the three
      // buckets say an audience, and the caller's own department folders say the
      // department's name rather than its slug. Everything else is a document or a
      // folder the reader named themselves.
      //
      // Bucket labels are consulted first. The two maps address different rows today
      // (`department` for the bucket, `department/<code>` and deeper for the chain), so
      // the order does not change any current label; it states that the bucket's
      // audience name is the one thing this build will not let a data value override.
      dirLabel={dirLabelOf === undefined
        ? undefined
        : (path, entry) => dirLabelOf(relativeToRoot(root, path)) ?? entry.name}
      onPathRenamed={props.onPathRenamed === undefined ? undefined : onRenamed}
      onPathDeleted={props.onPathDeleted}
    />
  )
}
