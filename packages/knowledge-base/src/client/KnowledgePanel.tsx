/**
 * The knowledge-base management page.
 *
 * Selected by the left-sidebar entry and rendered into the `main` slot, so it
 * replaces the conversation area. The page carries its own master-detail layout:
 * the rail holds a menu above the knowledge tree, and the content region shows
 * whichever surface the rail selected (a file preview, permissions, or indexing).
 *
 * The tree is this package's own listing rather than the file component from
 * `dsh-better-sidebar`. That component renders icon and name only and builds its
 * context menu internally, so it has nowhere to show whether a row is readable and
 * nowhere to add a grant entry, while the actions its menu does offer (rename,
 * delete, upload) edit a shared curated store rather than deciding who may see a
 * document. The one thing worth keeping from it is the `@`-reference action, reused
 * through its own helper so both trees insert the same reference.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { referenceInChat } from 'dsh-better-sidebar/src/client/reference-in-chat.ts'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconDeliverDocRegular,
  IconChevronUpOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson, type KnowledgeConfigView, type KnowledgeStatusView } from '../api.ts'

/** Extensions that are plain text and must be sent as text, not base64. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.text', '.markdown', '.rst',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.graphql', '.proto',
])

/** Content types the browser reports for text it already decoded. */
const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/x-yaml', 'application/yaml', 'application/x-sh',
])

/**
 * Last path segment's extension, lowercased, including the dot.
 *
 * Written inline rather than imported from `node:path`: this file runs in the
 * browser, where that module does not exist.
 *
 * @param path - a path or bare file name.
 * @returns the extension, or an empty string when there is none.
 */
function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}
import { KnowledgePermissions } from './KnowledgePermissions.tsx'
import { KnowledgeIndexing } from './KnowledgeIndexing.tsx'
import { KnowledgeLoading } from './KnowledgeLoading.tsx'
import { closeSidebar, isHostMissing, openInSidebar, readColumnExpanded } from './openInSidebar.ts'
import { publishActor, setMountPointResolver } from './saveAudit.ts'
import { KnowledgeHome } from './KnowledgeHome.tsx'
import { KnowledgeTrash } from './KnowledgeTrash.tsx'
import { KnowledgeMenuBrand, sectionGlyph } from './MenuGlyphs.tsx'
import { KnowledgeSettings } from './KnowledgeSettings.tsx'
import { KnowledgeSearch, useKnowledgeSearch } from './KnowledgeSearch.tsx'
import { KB_DRAG_MIME, KnowledgeListing } from './KnowledgeListing.tsx'
import { KnowledgeIconButton, KnowledgeSectionHeader } from './KnowledgeSectionHeader.tsx'
import { usePinnedPaths } from './usePinnedPaths.ts'
import { useViewMode } from './useViewMode.ts'
import { KnowledgeFileTree } from './KnowledgeFileTree.tsx'
import { KnowledgeSelectionBar } from './KnowledgeSelectionBar.tsx'
import { Button, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './KnowledgePanel.module.css'
import listingStyles from './KnowledgeListing.module.css'

/**
 * The session binding the page scopes its file tree with.
 *
 * It is a subscribable observable rather than a plain value because the session it
 * names appears only after a Workspace is chosen, which regularly happens after
 * this page has already mounted.
 */
export interface SessionSource {
  /** Current binding; `key` is the session id, absent before a session exists. */
  getSnapshot: () => { key?: unknown }
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/** Values the `main` slot injects into the page. */
export interface KnowledgePanelInjected {
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
  /** Locale tag the slot bound for this namespace, so dates match the reader. */
  locale?: string
  /** Source of the session the file tree resolves its scope from. */
  sessionSource: SessionSource
  /**
   * The client context, needed by the borrowed tree's `@` helper.
   *
   * That helper resolves the workspace root and the conversation input service
   * itself, so it needs the context rather than the values it reads from it.
   */
  ctx: unknown
}

/** Props the page receives. */
export interface KnowledgePanelProps extends Partial<KnowledgePanelInjected> {}

/**
 * Join the mount point with a listing-relative path.
 *
 * The borrowed tree and the conversation draft both address files by absolute
 * path, while a listing row carries a path relative to the mount. Kept as a plain
 * join rather than `node:path` because this runs in the browser, where only POSIX
 * separators occur.
 * @param mountPoint - absolute mount directory.
 * @param relPath - path relative to it.
 * @returns The absolute path.
 */
function joinPath(mountPoint: string, relPath: string): string {
  const base = mountPoint.endsWith('/') ? mountPoint.slice(0, -1) : mountPoint
  return base + '/' + relPath
}

/**
 * Turn an absolute path under the knowledge root back into a tree-relative one.
 *
 * The product's file explorer speaks absolute paths because it is a workspace browser;
 * every other surface here keys previews and grants by the tree-relative path, because a
 * relative path is what survives the caller's view being rebuilt at a different location.
 * The two meet at this function.
 * @param mountPoint - absolute mount directory.
 * @param absolute - a path the explorer reported.
 * @returns The path relative to the mount point (the input unchanged if it is not under it).
 */
function relativeToRoot(mountPoint: string, absolute: string): string {
  const base = mountPoint.endsWith('/') ? mountPoint.slice(0, -1) : mountPoint
  if (absolute === base) return ''
  return absolute.startsWith(base + '/') ? absolute.slice(base.length + 1) : absolute
}

/**
 * The title the header shows for the current selection.
 *
 * A file shows its own name, so the header answers "what am I looking at" while the
 * breadcrumb line answers "where is it". A section shows its menu label, which
 * keeps the header and the highlighted menu row saying the same thing.
 * @param t - copy resolver.
 * @param selection - the current selection.
 * @returns The heading text.
 */
function sectionTitle(t: (key: string) => string, selection: Selection): string {
  if (selection.kind === 'permissions') return t('menu.permissions')
  if (selection.kind === 'indexing') return t('menu.indexing')
  if (selection.kind === 'home') return t('menu.home')
  if (selection.kind === 'trash') return t('menu.trash')
  if (selection.kind === 'settings') return t('menu.settings')
  if (selection.kind === 'file') {
    const path = selection.path
    return path.slice(path.lastIndexOf('/') + 1)
  }
  return t('menu.search')
}

/** Which content the right-hand region shows. */
type Selection =
  | { kind: 'search' }
  | { kind: 'home' }
  | { kind: 'permissions' }
  | { kind: 'indexing' }
  | { kind: 'trash' }
  | { kind: 'settings' }
  | { kind: 'file'; path: string }

/**
 * The rail's fold state, persisted per browser.
 *
 * A fold is a per-device preference rather than a document fact, so it belongs in
 * browser storage: a reader who collapsed the rail on a laptop has not expressed
 * anything about the shared tree, and syncing the choice through the view
 * directory would move another reader's layout. Absent storage, or a value that is
 * not the one token written, reads as expanded, which is the state a first visit
 * should show.
 */
const RAIL_FOLDED_KEY = 'dsh-knowledge-rail-folded'

/** Read the stored fold state, tolerating storage that is unavailable or corrupt. */
function readFolded(): boolean {
  try {
    return window.localStorage.getItem(RAIL_FOLDED_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the fold state, ignoring a storage that refuses to write. */
function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(RAIL_FOLDED_KEY, folded ? '1' : '0')
  } catch {
    // Private-mode or full storage: the fold still applies for this session.
  }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: KnowledgeConfigView; status: KnowledgeStatusView }
  | { kind: 'unavailable' }

/**
 * Read one knowledge-base API method.
 * @param method - method name from {@link KB_API}.
 * @returns The parsed response body.
 */
async function readApi<T>(method: string): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  // Read through the tolerant helper: a 2xx carrying a non-JSON body (a proxy line, an
  // HTML error page) used to reach the page as a raw JSON.parse error message.
  const body = await readKnowledgeJson<T & Record<string, unknown>>(response)
  if (body.error !== undefined) throw new Error(body.error)
  return body as T
}

/**
 * Render the knowledge-base management page.
 * @param props - injected locale copy and the current session id.
 * @returns The master-detail page.
 */
export function KnowledgePanel(props: KnowledgePanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selection, setSelection] = useState<Selection>({ kind: 'home' })

  /**
   * The page the reader was on before opening a document.
   *
   * Reading a file is a detour, not a destination. When the reader collapses the
   * file window they expect to be back where they left off -- the permissions page,
   * the trash, the index -- not returned to the home list. `selection` alone cannot
   * answer this because it has already been replaced by the file entry.
   */
  const [lastNonFile, setLastNonFile] = useState<Selection>({ kind: 'home' })
  /**
   * The open document's modification instant, reported by the preview.
   *
   * Held here rather than in the preview because the header draws it: the header is
   * outside the preview's subtree, so the value has to reach this level. Cleared
   * whenever the selection changes, so a slow read for the previous file can never
   * label the next one.
   */
  const [fileMtimeMs, setFileMtimeMs] = useState<number | undefined>(undefined)

  /** Why the host could not show a document, when it could not. */
  const [openFailure, setOpenFailure] = useState<string | undefined>(undefined)

  /**
   * Open a document the way the rest of the product does: in the host's own file
   * preview window, not in this page.
   *
   * The knowledge page stays a browsing surface. A reader who opens a document gets
   * the tab strip, the path input, and the preview/edit toggle they already know from
   * the sidebar, because it IS that window -- this plugin draws none of it.
   *
   * When the host service is absent the page cannot conjure a viewer, so the click
   * reports it rather than appearing to do nothing.
   */
  const openDocument = (path: string): void => {
    // The address is built from the session's workspace root so the host can shorten
    // it to a session-relative one and dedupe against a tab the chat already opened.
    const outcome = openInSidebar(props.ctx, sessionId, '/workspace', joinPath(config.mountPoint, path))
      // Remember where the reader came from before the document replaces the selection.
      setLastNonFile(current => (selection.kind === 'file' ? current : selection))
    setSelection({ kind: 'file', path })
    // Record the failures that mean "the host column is not on this profile" so the
    // page can say so. `unclaimed` is not recorded: a file kind nothing claims is a
    // normal outcome the host renders as a download pane.
    setOpenFailure(isHostMissing(outcome) ? outcome : undefined)
  }
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The active page's primary control.
   *
   * Each management page owns the handler and the disabled state of its one action;
   * the panel owns where it is drawn. Publishing it here is what lets the header be
   * the only band at the top of the page. A page clears the slot on unmount so a
   * switch to another surface cannot inherit the previous page's button.
   */
  const [pageAction, setPageAction] = useState<ReactNode>(undefined)
  // Directories the product's explorer has open, by absolute path. Kept here rather than
  // in the explorer so switching to the listing and back does not collapse the reader's
  // tree; the listing has its own expansion state for the same reason.
  const [explorerExpanded, setExplorerExpanded] = useState<readonly string[]>([])

  /**
   * Whether a dropped file must be sent as base64 rather than as text.
   *
   * The decision is made from the extension and the browser's own content type:
   * a file the browser already recognises as text is read as text, and anything
   * else is treated as bytes. Guessing from the extension alone would corrupt a
   * `.md` that happens to carry an unusual name, and trusting the content type
   * alone would corrupt a document the browser reports as `application/octet-stream`.
   *
   * @param file - the dropped file.
   * @param relPath - its name inside the knowledge tree.
   * @returns true when the bytes must survive verbatim.
   */
  function needsBase64(file: File, relPath: string): boolean {
    if (TEXT_EXTENSIONS.has(extname(relPath).toLowerCase())) return false
    if (file.type.startsWith('text/')) return false
    if (TEXT_MIME_TYPES.has(file.type)) return false
    return true
  }

  /** Base64 of a buffer, from bytes rather than a binary string. */
  function base64Of(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    // `String.fromCharCode(...bytes)` overflows the argument list on a large
    // document, so the buffer is chunked before it is turned into a string.
    let binary = ''
    const CHUNK = 0x8000
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
    }
    return btoa(binary)
  }

  /**
   * Upload files into one directory, as the product's explorer asks.
   *
   * The explorer hands over `File` objects and an absolute directory; this plugin's upload
   * route speaks one file at a time as text plus a tree-relative path. Each file is read
   * here and posted individually so one failure does not discard the rest of a drop: a
   * batch that all-or-nothing would lose nine good files to one large one.
   * @param dir - absolute directory the drop landed in.
   * @param items - the dropped files with their relative names.
   */
  const uploadInto = useCallback(async (mountPoint: string, dir: string, items: readonly { file: File; relativePath: string }[]): Promise<void> => {
    const parent = relativeToRoot(mountPoint, dir)
    for (const item of items) {
      const target = parent === '' ? item.relativePath : parent + '/' + item.relativePath
      try {
        // A document is bytes, not text. Reading a .docx through `file.text()`
        // would decode it as UTF-8 and post a corrupted body, so the route is told
        // which encoding it is receiving and the browser hands over base64 for
        // anything that is not plain text. The server extracts those documents to
        // a `.md` sibling after writing them, which is what makes them greppable.
        const binary = needsBase64(item.file, item.relativePath)
        const content = binary
          ? base64Of(await item.file.arrayBuffer())
          : await item.file.text()
        const response = await fetch(kbApiPath(KB_API.upload), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(binary ? { relPath: target, content, encoding: 'base64' } : { relPath: target, content }),
          cache: 'no-store',
        })
        if (!response.ok) {
          // One refused file is reported without stopping the drop; the tree reload below
          // shows what did land.
          continue
        }
      } catch {
        // A file that could not be read is skipped for the same reason.
        continue
      }
    }
    setRefreshTick(t => t + 1)
  }, [])

  // Set by a row's context menu so the permission form opens on that path.
  const [grantPath, setGrantPath] = useState<string | undefined>(undefined)
  const [folded, setFolded] = useState<boolean>(readFolded)
  // The tree header's own narrowing, which costs no request. Kept apart from the
  // rail's search term: one narrows what is displayed, the other queries the tree.
  const [treeFilter, setTreeFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  // The pinned band's fold, which is a view state rather than a stored one: the
  // band's existence is the fact worth persisting, and a band the reader collapsed
  // reopens expanded so its contents are not lost behind a stale toggle.
  const [pinnedOpen, setPinnedOpen] = useState(true)
  // Set when the reader arrived at Home from the tree's empty state, whose button
  // asks to start a document. It is a one-shot: consuming it on the next selection
  // change keeps the New card from grabbing focus every time Home is revisited.
  const [focusNew, setFocusNew] = useState(false)

  // Subscribed rather than read once: a Workspace chosen after this page mounted is
  // what first supplies a session, and without the subscription the tree would stay
  // unrendered for the life of the view.
  //
  // Declared above the loading/unavailable early returns on purpose. Hooks run in
  // call order, so a hook below them changes the hook count between their renders
  // and React aborts the subtree -- measured in a browser on 2026-10-15, where the
  // panel rendered nothing at all.
  // The slot supplies the namespace's resolver; the fallback keeps the page
  // renderable when a slot host passes none, which is how a missing locale shows up.
  const t = props.t ?? ((key: string) => key)

  const sessionSource = props.sessionSource
  const sessionId = useSyncExternalStore(
    useCallback(
      (listener: () => void) => sessionSource?.subscribe(listener) ?? (() => {}),
      [sessionSource],
    ),
    () => sessionSource?.getSnapshot().key as string | undefined,
  )

  /**
   * The session key the product's file explorer scopes its requests by.
   *
   * The knowledge page has no conversation of its own, so `sessionId` is undefined on a
   * fresh visit -- which is exactly when a reader wants to browse the tree, and why the
   * explorer branch used to be skipped entirely. The explorer's host route only requires a
   * non-empty string to key its level cache by; it does not check that a conversation with
   * that id exists (measured: `POST /sidebar/api/fs.trees {sessionId:'not-a-real-session'}`
   * answers 200 with the directory's entries). So an absent conversation gets a stable
   * placeholder: stable so the tree keeps its cache between renders, and distinct from any
   * real session id so it can never collide with one.
   */
  const explorerSessionId = sessionId ?? '@kb-explorer'

  /**
   * The knowledge root as an absolute path, for the surfaces that speak absolute paths.
   *
   * Only branches that already established `config.mountPoint !== ''` read this, so it is
   * never empty there; the empty fallback exists so the constant is well typed rather than
   * to gate a render.
   */
  const kbRoot = state.kind === 'ready' ? state.config.mountPoint : ''

  // Publish the knowledge root and the caller identity to the plugin-scope save-audit
  // registration. The registration exists before any page mounts (an edit in the
  // sidebar is still a knowledge-base edit), but only the page knows these two
  // values: the mount point comes from the Host's config, the identity from the
  // status call. Pushing them here is what lets the listener tell a knowledge-base
  // save from any other file's save and name the person who made it.
  useEffect(() => {
    if (kbRoot !== '') setMountPointResolver(() => kbRoot)
  }, [kbRoot])
  useEffect(() => {
    if (state.kind === 'ready' && state.status.caller !== undefined) {
      publishActor(state.status.caller.userId)
    }
  }, [state])

  const load = useCallback(async () => {
    try {
      const config = await readApi<KnowledgeConfigView>(KB_API.config)
      const status = await readApi<KnowledgeStatusView>(KB_API.status)
      setState({ kind: 'ready', config, status })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Declared above the early returns for the same reason as the subscription
  // above: a hook below them changes the hook count between renders. The mount is
  // empty until config arrives, which the hook reads as "nothing to search yet".
  const search = useKnowledgeSearch(state.kind === 'ready' ? state.config.mountPoint : '')

  /**
   * Whether the Host verified that this caller may manage grants.
   *
   * Read from the status the Host sent, never computed here: the permission is the
   * backend's to decide, and a browser-side test would govern rendering while the
   * check that matters lives in DataOps. `!== true` rather than a truthy test so a
   * missing field on an older Host hides the surface instead of showing it.
   *
   * Derived above the early returns so the refusal effect below can be declared
   * alongside the other hooks; a hook after them would change the hook count
   * between renders and abort the subtree.
   */
  const canManageGrants = state.kind === 'ready' && state.status.canManageGrants === true

  /**
   * The caller's pins, read from their own view directory through the Host.
   *
   * Declared here, above the early returns, for the same reason the subscription
   * and the search hook are: a hook below them changes the hook count between
   * renders and aborts the subtree. Gated on the mount being known so the first
   * render does not post a request naming a tree that does not exist yet.
   */
  const pins = usePinnedPaths(state.kind === 'ready' && state.config.mountPoint !== '')

  /** The caller's list/grid preference, read from their own view directory. */
  const viewMode = useViewMode(state.kind === 'ready' && state.config.mountPoint !== '')

  /**
   * The rows the batch bar acts on.
   *
   * Held here rather than in the listing because two surfaces consume it: the tree
   * that fills it, and the bar that acts on it -- and the bar outlives the tree's
   * own render, since the listing is remounted when the refresh tick changes.
   */
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([])
  /** Held while a batch move is in flight, so the same paths cannot be sent twice. */
  const [batchBusy, setBatchBusy] = useState(false)
  /** The last batch failure, shown where the bar is rather than as a page error. */
  const [batchError, setBatchError] = useState<string | undefined>(undefined)
  /**
   * Whether a knowledge row is being dragged right now.
   *
   * Tracked at the panel because the PIN drop target lives here while the rows that
   * start the drag live in the listing. A resting pin band cannot serve as that
   * target: it is hidden while the caller has pinned nothing, so on a fresh tree
   * there would be nowhere to drop. The strip appears only while a drag is in
   * flight, which leaves the resting rail exactly as the layout calls for and still
   * gives the gesture somewhere to land.
   *
   * It is armed by the drag's own MIME type rather than a flag the listing sets, so
   * a drag of anything else across this panel cannot arm the zone.
   */
  const [dragActive, setDragActive] = useState(false)
  /** The display-setting menu, opened from the section band's control. */
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  /**
   * The folder a batch move should target.
   *
   * A prompt rather than a drag for the batch case: dragging many rows into one
   * folder is a gesture with no clear target when the destination is collapsed, and
   * typing a path is what an operator managing grants already does elsewhere on this
   * page. The path is resolved against the mount point on the Host, which refuses
   * anything uncontained.
   */
  const promptBatchTarget = (): string | undefined => {
    const answer = window.prompt(t('moveSelected'))
    if (answer === null) return undefined
    const trimmed = answer.trim()
    return trimmed === '' ? undefined : trimmed
  }

  /**
   * Move every selected path into one folder, then re-read the tree.
   *
   * Sequential rather than parallel: each move resynchronizes the caller's view, and
   * two concurrent syncs over the same view would interleave their link and unlink
   * passes. The first refusal stops the batch and is reported, because a partial
   * batch reported as success would leave the reader believing every row moved.
   */
  const moveSelected = async (toDirectory: string): Promise<void> => {
    setBatchBusy(true)
    setBatchError(undefined)
    try {
      for (const from of selectedPaths) {
        const response = await fetch(kbApiPath(KB_API.move), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: toDirectory }),
          cache: 'no-store',
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'HTTP ' + String(response.status))
        }
      }
      setSelectedPaths([])
      setRefreshTick(n => n + 1)
    } catch (failure: unknown) {
      setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setBatchBusy(false)
    }
  }

  /**
   * Move one row dropped onto a folder.
   *
   * The Host resolves the destination name from the source, so this sends the folder
   * rather than a full path: a caller cannot rename by dragging, which keeps the
   * gesture's authority to exactly "put it in there".
   */
  const moveOne = async (from: string, toDirectory: string): Promise<void> => {
    setBatchError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.move), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: toDirectory }),
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      setRefreshTick(n => n + 1)
    } catch (failure: unknown) {
      setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
    }
  }

  /**
   * Leave the permission surface when the caller may not manage grants.
   *
   * Hiding the menu row is not enough: the selection can already BE permissions --
   * a reload can revoke the permission while it is open, and a stale render or a
   * restored view can restore it -- which would leave the surface on screen with
   * only the menu missing. Falling back to the listing also drops the path the form
   * was primed with, so nothing about the abandoned surface survives.
   */
  useEffect(() => {
    if (canManageGrants) return
    setSelection(current => (current.kind === 'permissions' ? { kind: 'search' } : current))
    setGrantPath(undefined)
  }, [canManageGrants])

  /**
   * Whether the selected document is being drawn by the host's file window.
   *
   * The knowledge page is a global panel and the host's right column survives it (see
   * the sidebar-right patch this plugin ships with), so a document opened from here is
   * rendered over there. In that state this column's own content region would only
   * hold a pointer sentence, and keeping it costs the reader the width the document
   * itself wants.
   */
  // Whether this page has handed a document to the reader's file window.
  //
  // This is a page-level intent: "the reader asked to read a file". It deliberately does
  // NOT consult the column's own expanded flag. That flag is the thing this page DRIVES
  // (open on select, close on leaving), so reading it back into the decision would make
  // the page's state depend on an effect it causes -- and it would keep the page in
  // preview mode while the reader was back on the list, suppressing the content column
  // and leaving the frame with a blank third track.
  const documentInSidebar = selection.kind === 'file' && openFailure === undefined


  // Follow the host column's own expanded flag while a document is selected.
  //
  // The column exposes no change subscription for its expanded state -- the `subscribe`
  // it does expose belongs to the tab registry -- so the page polls it. The interval only
  // runs while a document is selected. This is what lets the reader close the file window
  // with the host's own control and still get their content column back: without it the
  // page never learns the column went away, keeps suppressing its content, and the frame
  // is left showing an empty middle column.
  const [columnExpanded, setColumnExpanded] = useState(true)
  useEffect(() => {
    if (selection.kind !== 'file') return
    const read = (): void => { setColumnExpanded(readColumnExpanded(props.ctx)) }
    read()
    const timer = window.setInterval(read, 400)
    return () => { window.clearInterval(timer) }
  }, [selection.kind, props.ctx])
  /** True while the reader is actually on screen holding this page's document. */
  const readerOnScreen = documentInSidebar && columnExpanded


  // Publish "the knowledge page has handed its content column to the reader" on the
  // document element. The host frame decides how wide the reader's track is, and it
  // cannot see this page's React state; a DOM attribute is the one channel both sides
  // share. The host's stylesheet keys the reader-wide layout off this attribute, so the
  // frame changes at the same instant the content column disappears -- no state left
  // behind when the reader navigates back to the list.
  useEffect(() => {
    const root = document.documentElement
    if (readerOnScreen) root.setAttribute('data-kb-reader-open', '')
    else root.removeAttribute('data-kb-reader-open')
    return () => { root.removeAttribute('data-kb-reader-open') }
  }, [readerOnScreen])

  // Hand the frame back when the reader leaves the document.
  //
  // The two states need different frames: a document is read in the host's file window
  // on the right and the page's own content column yields to it, while every other
  // surface (home, permissions, trash, settings) needs that column back. Without this
  // the column would stay open after the reader navigated away, and the page would keep
  // yielding width to a window that no longer shows anything of this document.
  //
  // Kept ABOVE the loading/unavailable early returns on purpose: a hook below one of
  // those runs only on renders that get past it, so the loading render and the loaded
  // render would disagree about how many hooks exist. React reports that as error #310
  // and unmounts the boundary.
  useEffect(() => {
    if (readerOnScreen) return
    closeSidebar(props.ctx)
    // A reader who closes the file window leaves the document behind; send them back to
    // the page they opened it from rather than to the home list. Only acts on a file
    // selection, so ordinary rail clicks are untouched.
    setSelection(current => (current.kind === 'file' ? lastNonFile : current))
  }, [documentInSidebar, props.ctx, lastNonFile])

  if (state.kind === 'loading') {
    // Localised and animated: the hardcoded English sentence was the only loading
    // copy in the surface that never reached the dictionary.
    return (
      <div className={styles.page}>
        <KnowledgeLoading label={t('loading')} announce={t('loading')} />
      </div>
    )
  }
  if (state.kind === 'unavailable') {
    return (
      <div className={styles.page}>
        <p className={styles.error} role="alert">Knowledge base is unavailable.</p>
        {/* This screen exists because the page could not reach its Host, so it
            deliberately depends on nothing that the failing load would have
            provided -- including the primitive layer, whose locale and theme it
            cannot assume are mounted. It is a bare control and a bare string. */}
        <button type="button" className={styles.retry} onClick={() => { void load() }}>Retry</button>
      </div>
    )
  }

  const { config, status } = state


  /**
   * The rail's menu rows, in order, with the copy key each renders.
   *
   * Search is deliberately absent: it is the page's leading action and now
   * renders as the rail's own input above this list, because a row that merely
   * selected a search surface made the reader click twice to type one term.
   *
   * Permissions is absent for a caller who may not manage grants. Hiding the row is
   * not by itself the rule -- the content region below refuses the surface and the
   * listing's grant entry is withdrawn -- but a row that opens a refused surface is
   * a dead end, so it is not offered either.
   */
  const SECTIONS = [
    { kind: 'home', key: 'menu.home' },
    ...(canManageGrants ? [{ kind: 'permissions', key: 'menu.permissions' }] as const : []),
    { kind: 'indexing', key: 'menu.indexing' },
    { kind: 'trash', key: 'menu.trash' },
    { kind: 'settings', key: 'menu.settings' },
  ] as const

  /**
   * Open the permission surface for one path, or ignore the request.
   *
   * A right-click reaches this from the listing, so the refusal is repeated at the
   * entry point: withdrawing the prop would hide the affordance, but this keeps the
   * transition itself guarded however it is reached.
   * @param path - the row's path, pre-filled into the grant form.
   */
  const openPermissions = (path: string): void => {
    if (!canManageGrants) return
    setGrantPath(path)
    setSelection({ kind: 'permissions' })
  }


  const rendered: Selection = selection.kind === 'permissions' && !canManageGrants
    ? { kind: 'search' }
    : selection

  return (
    <div className={styles.page}>
      <div className={
        styles.body
        + (folded ? ' ' + styles.bodyCollapsed : '')
        // A document is shown in the host's file window on the right, so this
        // column has nothing left to draw for it. Collapsing it hands the width back
        // to that window instead of leaving a column that only repeats "opened over
        // there" -- the notice is a fallback for a host without the column, not a
        // resting state for this one.
        + (documentInSidebar ? ' ' + styles.bodyDocument : '')
      }>
      <aside className={styles.rail}>
        {/* The rail's own top line, and the page's top-left corner. The header
            below covers only the content column, so this row is what occupies the
            rail's first 36px and keeps the brand reachable when the rail folds. */}
        <div className={styles.railTop}>
          <span className={styles.railBrand}>
            <KnowledgeMenuBrand folded={folded} />
            {!folded && <span className={styles.railBrandName}>{t('brand')}</span>}
          </span>
          <span className={styles.railTopSpacer} />
          <KnowledgeIconButton
            label={t(folded ? 'expandRail' : 'collapseRail')}
            pressed={folded}
            onClick={() => {
              setFolded((current) => {
                writeFolded(!current)
                return !current
              })
            }}
          >
            <IconPanelLeftOutlineRegular size={16} />
          </KnowledgeIconButton>
        </div>
        {/* The search field, above the menu rows rather than among them: it takes
            text, so it is the one control in this rail that is not a destination.
            Selecting it moves the content region to the results. Hidden while
            folded, where the strip has no room for a field. */}
        {!folded && (
          <div className={styles.searchBox}>
            <Input
              type="search"
              value={search.term}
              icon={<IconSearchOutlineRegular size={16} />}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              onFocus={() => { setSelection({ kind: 'search' }) }}
              onChange={(event) => {
                search.setTerm(event.target.value)
                setSelection({ kind: 'search' })
              }}
              onKeyDown={(event) => {
                search.onKeyDown(event)
                // Enter opens the highlighted row here rather than in the field's
                // own handler, which only knows how to move the highlight.
                if (event.key === 'Enter') {
                  const hit = search.hits[search.active]
                  if (hit !== undefined) {
                    event.preventDefault()
                    openDocument(hit.relPath)
                  }
                }
              }}
            />
          </div>
        )}
        {/* Native buttons rather than `Button`/`MenuItemButton`: these rows carry
            the sidebar's own row contract (`min-height:36px`, `padding:7px 8px`,
            `--dsw-radius-md`, one hover fill for both hover and selected). That is
            a row-shaped control the primitive set does not render, and the sidebar
            it is modelled on uses bare elements for the same reason. */}
        <nav className={folded ? styles.menuFolded : styles.menu} aria-label={t('menu')}>
          {SECTIONS.map((section) => {
            const active = rendered.kind === section.kind
            return (
              <button
                key={section.kind}
                type="button"
                className={active ? styles.menuRowActive : styles.menuRow}
                aria-current={active ? 'page' : undefined}
                // The strip keeps the glyph and drops the label, so the accessible
                // name has to travel on the button rather than in a hidden span.
                {...(folded ? { 'aria-label': t(section.key), title: t(section.key) } : {})}
                onClick={() => { setSelection({ kind: section.kind } as Selection) }}
              >
                <span className={styles.menuGlyph}>{sectionGlyph(section.kind)}</span>
                {!folded && <span className={styles.menuLabel}>{t(section.key)}</span>}
              </button>
            )
          })}
        </nav>
        {!folded && (
        <div
          className={styles.railBody}
          // The drag's own payload type arms the pin strip: the listing sets it on
          // start and clears it on end, so the zone is live exactly while a row is
          // being carried and never for any other drag crossing the page.
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDragActive(true)
          }}
          onDragLeave={(event) => {
            // Only when the pointer has actually left the rail: moving between two
            // rows inside it fires leave-then-over, and clearing unconditionally
            // would flicker the strip off under the pointer.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDragActive(false)
          }}
          onDrop={(event) => {
            setDragActive(false)
            if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
            event.preventDefault()
          }}
        >
          {/* The pin drop zone. It appears only while a row is being dragged: the
              resting band is hidden when nothing is pinned (a titled empty region
              would take a line from the tree), so a drag needs its own target or
              pinning by drag would be unreachable on a fresh tree. Dropping here
              pins; dropping on a folder row moves, which is the distinction the two
              targets carry. */}
          {dragActive && (
            <div
              className={listingStyles.pinDropZone}
              data-testid="kb-pin-drop-zone"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragActive(false)
                try {
                  const raw = event.dataTransfer.getData(KB_DRAG_MIME)
                  const parsed = JSON.parse(raw) as { relPath?: unknown }
                  if (typeof parsed.relPath === 'string') pins.setPinned(parsed.relPath, true)
                } catch {
                  // A payload this surface cannot read is not a drop it should
                  // honour: the row simply stays where it was.
                }
              }}
            >
              {t('pinSelected')}
            </div>
          )}
          {/* The pinned band sits above the tree, inside the rail's own 8px inset
              so its rows line up with the tree's. The whole band is hidden when
              the caller has pinned nothing: an empty "置顶" title would name a
              region with no content and take a line from the tree. */}
          {pins.relPaths.length > 0 && (
            <section className={styles.pinnedBand} aria-label={t('sectionPinned')}>
              <KnowledgeSectionHeader
                name={t('sectionPinned')}
                actions={(
                  <KnowledgeIconButton
                    label={t('sectionPinned')}
                    pressed={pinnedOpen}
                    onClick={() => { setPinnedOpen(current => !current) }}
                  >
                    {pinnedOpen
                      ? <IconChevronUpOutlineRegular size={16} />
                      : <IconChevronDownOutlineRegular size={16} />}
                  </KnowledgeIconButton>
                )}
              />
              {pinnedOpen && (
                <KnowledgeListing
                  t={t}
                  locale={props.locale}
                  refreshTick={refreshTick}
                  onRenamed={() => { setRefreshTick(t => t + 1) }}
                  expandAll
                  unpinOnly
                  isPinned={pins.has}
                  onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
                  onOpen={(path) => { openDocument(path) }}
                  onGrant={(path) => { openPermissions(path) }}
                  onReference={(path, isDir) => {
                    if (sessionId === undefined) return
                    referenceInChat(props.ctx as never, sessionId, joinPath(config.mountPoint, path), isDir)
                  }}
                />
              )}
            </section>
          )}
          <section className={styles.treeBand} aria-label={t('sectionKnowledge')}>
            <KnowledgeSectionHeader
              name={t('sectionKnowledge')}
              actions={(
                <>
                  <KnowledgeIconButton
                    label={t('actionFilter')}
                    pressed={filterOpen}
                    onClick={() => {
                      setFilterOpen((current) => {
                        // Closing the control clears the narrowing: a filter that
                        // is invisible but still applied would hide rows with no
                        // visible cause.
                        if (current) setTreeFilter('')
                        return !current
                      })
                    }}
                  >
                    <IconSearchOutlineRegular size={16} />
                  </KnowledgeIconButton>
                  <KnowledgeIconButton
                    label={t('actionFilter')}
                    pressed={treeFilter !== ''}
                    onClick={() => {
                      // The filter glyph opens the same in-place narrowing the
                      // search glyph does; both are the tree's own filter, which is
                      // why they share one term.
                      setFilterOpen(true)
                    }}
                  >
                    <IconSlidersTwoOutlineRegular size={16} />
                  </KnowledgeIconButton>
                  <KnowledgeIconButton
                    label={t('actionNew')}
                    onClick={() => { setSelection({ kind: 'home' }) }}
                  >
                    <IconPlusOutlineRegular size={16} />
                  </KnowledgeIconButton>
                  {/* The display setting, as a 28px icon button opening a menu.
                      A labelled `SegmentedControl` was the first attempt, and it was
                      measured out of this header: the official control is 126px wide
                      (4px pad, a 28px tab with 16px side padding each), which took the
                      section header to 230 of its 280px and left the section name with
                      nothing at any narrower rail. The header's own control is the
                      28px icon button measured for it, so the two modes live in a menu
                      behind one. The platform ships no list-view or grid glyph (all 94
                      official icons were checked), so the anchor carries the same
                      sliders glyph the filter uses and the MENU names the modes. */}
                  <Menu
                    open={viewMenuOpen}
                    anchor={(
                      <KnowledgeIconButton
                        label={t('sectionKnowledge')}
                        pressed={viewMenuOpen}
                        onClick={() => { setViewMenuOpen(current => !current) }}
                      >
                        <IconSlidersTwoOutlineRegular size={16} />
                      </KnowledgeIconButton>
                    )}
                    onClose={() => { setViewMenuOpen(false) }}
                    align="end"
                  >
                    {(['list', 'grid', 'explorer'] as const).map(mode => (
                      <MenuItemButton
                        key={mode}
                        icon={viewMode.mode === mode
                          ? <IconCheckOutlineRegular size={16} />
                          : <span />}
                        onSelect={() => {
                          viewMode.setMode(mode)
                          setViewMenuOpen(false)
                        }}
                      >
                        {mode === 'list' ? t('viewList') : mode === 'grid' ? t('viewGrid') : t('viewExplorer')}
                      </MenuItemButton>
                    ))}
                  </Menu>
                </>
              )}
            />
            {filterOpen && (
              <div className={styles.treeFilter}>
                <Input
                  type="search"
                  value={treeFilter}
                  icon={<IconSearchOutlineRegular size={16} />}
                  placeholder={t('filterPlaceholder')}
                  aria-label={t('filterPlaceholder')}
                  autoFocus
                  onChange={(event) => { setTreeFilter(event.target.value) }}
                />
              </div>
            )}
            <div className={styles.treeScroll}>
              {config.mountPoint === ''
                ? <p className={styles.muted}>{t('mountPointMissing')}</p>
                : viewMode.mode === 'explorer' ? (
                  // The product's own file explorer, pointed at the knowledge root.
                  //
                  // This is the tree from the workspace sidebar itself, not a copy of it:
                  // `KnowledgeFileTree` renders `FileTree` from `dsh-better-sidebar`, whose
                  // cwd is a plain absolute path. `/workspace/kb` is a symlink into the
                  // caller's view, so the explorer reads the knowledge tree through the
                  // same fs API it uses for any other directory -- measured with
                  // `POST /sidebar/api/fs.trees {cwd:'/workspace/kb'}`, which answers the
                  // tree's entries. It brings sort, inline rename, drag-and-drop and the
                  // upload strip, none of which a hand-built copy would keep in step.
                  //
                  // The listing beside it remains the default because it shows knowledge
                  // state the explorer has no concept of: whether a row is readable, its
                  // pinned mark, and multi-select for a batch grant.
                  <KnowledgeFileTree
                    sessionId={explorerSessionId}
                    // The three buckets name an AUDIENCE, not a path: the folders on
                    // disk are global/department/personal, and renaming them would
                    // change the shared layout the view is built from. Only these
                    // three paths carry a label; everything below is a document the
                    // reader named.
                    bucketLabels={{
                      global: t('bucketGlobal'),
                      department: t('bucketDepartment'),
                      personal: t('bucketPersonal'),
                    }}
                    root={kbRoot}
                    expanded={explorerExpanded}
                    revealed={[]}
                    onToggle={(path) => {
                      setExplorerExpanded(current => current.includes(path)
                        ? current.filter(entry => entry !== path)
                        : [...current, path])
                    }}
                    onOpenFile={(path) => {
                      // The explorer speaks absolute paths; the page keys previews by the
                      // tree-relative path every other surface uses.
                      openDocument(relativeToRoot(kbRoot, path))
                    }}
                    onReferenceFile={(path, isDir) => {
                      // A reference belongs to a conversation, so there is nowhere to put it
                      // without one. The explorer still browses; the action is simply absent
                      // until a session exists.
                      if (sessionId === undefined) return
                      referenceInChat(props.ctx as never, sessionId, path, isDir)
                    }}
                    onUploadRequest={(dir, items) => { void uploadInto(kbRoot, dir, items) }}
                    busy={false}
                    refreshTick={refreshTick}
                    onPathRenamed={() => { setRefreshTick(t => t + 1) }}
                  />
                ) : (
                  // The plugin's own listing rather than the borrowed tree.
                  //
                  // The borrowed tree renders icon and name only and builds its context
                  // menu inside itself, so it has nowhere to show whether a row is
                  // readable and nowhere to add a grant entry. What its menu offers
                  // instead (rename, delete, upload, drag-and-drop) are edits to a
                  // shared, curated store, which is not what this page is for: the page
                  // decides who may see a document, and the preview reads one. The `@`
                  // reference is kept, being the one action a reader wants from here.
                  <KnowledgeListing
                    t={t}
                    locale={props.locale}
                    refreshTick={refreshTick}
                    onRenamed={() => { setRefreshTick(t => t + 1) }}
                    filter={treeFilter}
                    viewMode={viewMode.mode === 'grid' ? 'grid' : 'list'}
                    selection={selectedPaths}
                    onSelectionChange={setSelectedPaths}
                    isPinned={pins.has}
                    onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
                    onMove={(from, to) => { void moveOne(from, to) }}
                    onOpen={(path) => { openDocument(path) }}
                    onGrant={(path) => { openPermissions(path) }}
                    onReference={(path, isDir) => {
                      if (sessionId === undefined) return
                      referenceInChat(props.ctx as never, sessionId, joinPath(config.mountPoint, path), isDir)
                    }}
                    // An empty tree offers the way to make a document. It does not
                    // create one: there is no create route, and a button that
                    // silently did nothing would be worse than none. It navigates to
                    // the surface where creating will live.
                    emptyAction={(
                      // NAVIGATION, not creation: this plugin has no create route, so
                      // pressing this opens Home and focuses the New card rather than
                      // making a document. The label names what the reader is going to
                      // do; the action takes them to where it happens. A control that
                      // appeared to create and silently did nothing would be worse than
                      // one that visibly navigates.
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFocusNew(true)
                          setSelection({ kind: 'home' })
                        }}
                      >
                        {t('actionNew')}
                      </Button>
                    )}
                  />
                )}
              {/* The batch bar closes the tree's own scroll container, so it sits
                  below every row rather than over them and never shifts the tree the
                  way a top bar would. It appears only while rows are selected: an
                  always-present toolbar would take a line from the tree to offer
                  actions with nothing to act on. */}
              {selectedPaths.length > 0 && (
                <KnowledgeSelectionBar
                  t={t}
                  count={selectedPaths.length}
                  busy={batchBusy}
                  onMove={() => {
                    const target = promptBatchTarget()
                    if (target !== undefined) void moveSelected(target)
                  }}
                  onPin={() => {
                    for (const path of selectedPaths) pins.setPinned(path, true)
                    setSelectedPaths([])
                  }}
                  onClear={() => { setSelectedPaths([]) }}
                />
              )}
              {batchError !== undefined && (
                <p className={styles.muted} role="alert">{batchError}</p>
              )}
            </div>
          </section>
        </div>
        )}
      </aside>
      {!readerOnScreen && (
        <div className={styles.contentColumn}>
          {/* The header covers only the content column now, so the rail keeps its
              own top-left corner. It still states what this surface is and which
              tree it governs, once for the page. */}
          <header className={styles.header}>
            <div className={styles.headerTop}>
              <h2 className={styles.headerTitle}>{sectionTitle(t, rendered)}</h2>
              {pageAction !== undefined && (
                <div className={styles.headerActions}>{pageAction}</div>
              )}
            </div>
            <p className={styles.headerFact}>
              {/* A document's own facts are its instant and its path. The count of
                  everything in the tree is a fact about the KNOWLEDGE BASE, not about
                  the document on screen, so it is not repeated over an open file --
                  it describes the tree, and the tree already has its own header. */}
              {rendered.kind === 'file' ? (
                <>
                  {fileMtimeMs === undefined
                    ? null
                    : <span>{t('modifiedAt') + ' ' + new Date(fileMtimeMs).toLocaleString()}</span>}
                  {fileMtimeMs === undefined ? null : <span className={styles.factDot} aria-hidden="true">·</span>}
                  <code className={styles.headerPath}>
                    {config.mountPoint + '/' + rendered.path}
                  </code>
                </>
              ) : (
                <>
                  {/* Two different situations reach here as one null count. A share that
                      is not mounted is something the reader must take up with the
                      deployment; a pointer this plugin has not generated yet resolves
                      itself on the next read. Saying "not mounted" for the second sends
                      them to check a mount that is working, so the wording follows the
                      state the Host classified rather than the absence of a number. */}
                  {status.visibleFiles === null || status.visibleFiles === undefined
                    ? (status.mountState === 'pointer-missing' ? t('viewNotBuilt') : t('mountPointMissing'))
                    : String(status.visibleFiles) + ' ' + t('filesUnit')}
                  <span className={styles.factDot} aria-hidden="true">·</span>
                  <code className={styles.headerPath}>{config.mountPoint}</code>
                </>
              )}
            </p>
            {/* Only for the state the reader can act on: the pointer resolves itself,
                and saying so keeps them from hunting for the rebuild button. */}
            {status.mountState === 'pointer-missing' && (
              <p className={styles.headerFact}>{t('viewNotBuiltHint')}</p>
            )}
          </header>
          <section className={styles.content}>
            {rendered.kind === 'home' && (
              <KnowledgeHome
                t={t}
                locale={props.locale}
                mountPoint={config.mountPoint}
                focusNew={focusNew}
                onOpen={(path) => { openDocument(path) }}
              />
            )}
            {rendered.kind === 'trash' && <KnowledgeTrash t={t} />}
            {rendered.kind === 'settings' && <KnowledgeSettings t={t} />}
            {rendered.kind === 'search' && (
              <KnowledgeSearch
                t={t}
                search={search}
                locale={props.locale}
                onOpen={(path) => { openDocument(path) }}
                idle={<KnowledgeListing
                  t={t}
                  locale={props.locale}
                  refreshTick={refreshTick}
                  onRenamed={() => { setRefreshTick(t => t + 1) }}
                  onOpen={(path) => { openDocument(path) }}
                  // A right-click on a row opens the grant form with that path already
                  // filled in: a row is where an operator has a path in mind.
                  onGrant={canManageGrants ? (path) => { openPermissions(path) } : undefined}
                  onReference={(path, isDir) => {
                    if (sessionId === undefined) return
                    referenceInChat(props.ctx as never, sessionId, joinPath(config.mountPoint, path), isDir)
                  }}
                />}
              />
            )}
            {rendered.kind === 'permissions' && (
              <KnowledgePermissions
                t={t}
                mountPoint={config.mountPoint}
                reloadToken={refreshTick}
                initialPath={grantPath}
                onAction={setPageAction}
              />
            )}
            {rendered.kind === 'indexing' && (
              <KnowledgeIndexing
                t={t}
                status={status}
                onChanged={() => { void load(); setRefreshTick(n => n + 1) }}
                onAction={setPageAction}
              />
            )}
            {rendered.kind === 'file' && (
              // A document is shown by the host's file preview window, not here. This
              // page is the browsing surface; what fills the reading column is the
              // product's own viewer, opened through `betterSidebar.openFile`.
              //
              // The panel still states which document is open and where it went, so a
              // click that hands the document to a window the reader cannot see (one
              // closed behind this page) is not a silent no-op.
              <div className={styles.openedElsewhere}>
                <IconDeliverDocRegular size={24} className={styles.emptyGlyph} />
                <p className={styles.emptyTitle}>{t('openedInSidebar')}</p>
                <p className={styles.muted}>{config.mountPoint + '/' + rendered.path}</p>
              </div>
            )}
          </section>
        </div>
      )}
      </div>
    </div>
  )
}
