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

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { FileTree } from 'dsh-better-sidebar/src/client/FileTree.tsx'
import type { UploadItem } from 'dsh-better-sidebar/src/client/upload.ts'
import { departmentPathLabels, folderLabelOf, type DepartmentPath } from './departmentFolders.ts'
import { VIEW_METADATA_FILENAMES } from '../viewMetadata.ts'
import styles from './KnowledgeFileTree.module.css'
import { batchRowsFor } from './referenceTargets.ts'
import { KB_API, kbApiPath } from '../api.ts'
import { en, zh } from './locales.ts'

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
  /**
   * Whether one path is currently favourited, so its row can draw the star.
   *
   * The borrowed explorer has no row-decoration hook, so the star is applied by this
   * wrapper observing the rows it renders (see `useRowFavorites`). Absent means the
   * caller has no favourites store, which keeps the wrapper from touching the DOM at all.
   */
  isFavorite?: (relPath: string) => boolean
  /** The favourites star's accessible name. */
  favoriteMarkLabel?: string
}

/**
 * One row's absolute path, read from the element the explorer rendered.
 *
 * The explorer prints the full path as the row's `title` (it is a tooltip for every row,
 * including the root), and nothing else in the row's own markup identifies the path. That
 * makes `title` the contract this wrapper reads: a row with no title is not a row this
 * code can address, and it is skipped rather than guessed at.
 *
 * A broken symlink's title carries a suffix after an em dash; the path is the part before
 * it, which is why this splits rather than trusting the whole string.
 * @param row - one `.explorerRow` element.
 * @returns The absolute path, or undefined when the row names none.
 */
function rowPathOf(row: Element): string | undefined {
  const title = row.getAttribute('title')
  if (title === null || title === '') return undefined
  return title.split(' \u2014 ')[0]
}

/**
 * The row element containing one node.
 *
 * The explorer marks rows with a class from its CSS module, whose generated name is not
 * importable here; the role and the row shape are. Walking up to the nearest element with
 * `role="button"` reaches the row without depending on the module's hash.
 * @param node - any node inside a row.
 * @returns The row element, or null when the node is not inside one.
 */
function rowOf(node: Element): Element | null {
  return node.closest('[role="button"]')
}

/**
 * Keep the borrowed explorer's rows in step with the caller's favourites.
 *
 * The explorer has no row-decoration hook and builds its context menu internally, so
 * neither a star nor a menu can be passed as a prop. Both are therefore applied by
 * observing the rows after they render:
 *
 * - The star is an element this code inserts before the row's timestamp, which is the
 *   placement the reader asked for ("left of the date"). It is inserted once and then
 *   toggled, so a re-render does not stack a second star on the same row.
 * - The context menu is NOT touched. The explorer builds its own menu and offers no way
 *   to append to it, so the only possible interference was replacement -- and replacing
 *   it removed the six actions a reader already relies on. The star is all this hook
 *   does; the plugin's own actions live in the selection bar, which appears on selection
 *   and competes with nothing.
 *
 * A MutationObserver drives it, because every expansion re-renders rows and a one-shot
 * pass on mount would decorate only the top level.
 * @param container - the element wrapping the explorer.
 * @param root - absolute knowledge root, stripped to build the relative paths favourites use.
 * @param isFavorite - the caller's favourites lookup.
 * @param label - the star's accessible name.
 */
function useRowDecoration(options: {
  container: React.RefObject<HTMLDivElement | null>
  root: string
  isFavorite: ((relPath: string) => boolean) | undefined
  label: string | undefined
}): void {
  const { container, root, isFavorite, label } = options

  /**
   * Turn an absolute row path into the key favourites are stored under.
   *
   * Favourites are addressed relative to the mount point, which is what the Host
   * resolves and what every route speaks; rows speak absolute paths. The root is
   * stripped here, and a row above the root yields undefined because it cannot be a
   * favourited document.
   */
  const relPathOf = useCallback((absolute: string): string | undefined => {
    const base = root.endsWith('/') ? root.slice(0, -1) : root
    if (!absolute.startsWith(base + '/')) return undefined
    return absolute.slice(base.length + 1)
  }, [root])

  useEffect(() => {
    const host = container.current
    if (host === null) return undefined

    /** Insert or remove one row's star so it reflects the current favourites set. */
    const paintRow = (row: Element, favorite: boolean): void => {
      const RE = '[data-kb-favorite]'
      const existing = row.querySelector(RE)
      if (!favorite) { existing?.remove(); return }
      if (existing !== null) return
      if (label === undefined) return
      const star = document.createElement('span')
      star.setAttribute('data-kb-favorite', '')
      star.setAttribute('aria-label', label)
      star.setAttribute('title', label)
      // Amber is the one warm stop in the palette, which is what makes the mark read as
      // a star rather than as another grey glyph. Inline because the explorer's module
      // owns the row and has no class for this.
      //
      // `flex: none` is load-bearing: the name span truncates with an ellipsis, and a
      // shrinkable star would be squeezed out of view on exactly the long file names
      // where a reader still wants to see that the row is starred.
      star.style.cssText = 'flex:none;color:var(--dsw-static-amber-500);font:var(--dsw-font-xxs-12);margin-left:4px'
      star.textContent = '\u2605'
      // Immediately after the name, which is where a mark about the document belongs.
      // The row's own timestamp stays where it was, at the far end.
      const name = row.querySelector('[class*="explorerName"]')
      if (name !== null) name.after(star)
      else row.appendChild(star)
    }

    /** Decorate every row currently rendered. */
    const paint = (): void => {
      if (isFavorite === undefined) return
      for (const row of host.querySelectorAll('[role="button"]')) {
        const absolute = rowPathOf(row)
        if (absolute === undefined) continue
        const relPath = relPathOf(absolute)
        if (relPath === undefined) continue
        paintRow(row, isFavorite(relPath))
      }
    }

    paint()
    const observer = new MutationObserver(paint)
    // `subtree` because expansion renders rows under descendants; `childList` alone is
    // enough for the star because its own insertion is not a row-list change.
    observer.observe(host, { childList: true, subtree: true })

    return () => { observer.disconnect() }
  }, [container, isFavorite, label, relPathOf])

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

  /**
   * The element wrapping the explorer, which the row decoration observes.
   *
   * The explorer renders its own rows, so neither a star nor a context menu can be
   * handed to it; both are applied from outside through this element. See
   * `useRowDecoration` for what it decorates and why.
   */
  const container = useRef<HTMLDivElement | null>(null)
  useRowDecoration({
    container,
    root,
    isFavorite: props.isFavorite,
    label: props.favoriteMarkLabel,
  })

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
    <div ref={container} className={styles.treeFrame}>
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
      {...({
        // `extraMenuItems` is the explorer's append hook: the native rows stay exactly as
        // they are and these land after a separator. Cast because the installed explorer
        // typings may predate the prop; the runtime ignores unknown props.
        extraMenuItems: [
          {
            id: 'kb-extract-markdown',
            label: (typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh') ? zh : en).menuExtractMarkdown,
            when: (target: { relPath: string; isDir: boolean }) => !target.isDir,
            onSelect: (target: { relPath: string; isDir: boolean }) => {
              if (target.isDir) return
              void fetch(kbApiPath(KB_API.extractRetry), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ relPath: target.relPath, wait: true }),
              })
            },
          },
        ],
      } as Record<string, unknown>)}
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
    </div>
  )
}
