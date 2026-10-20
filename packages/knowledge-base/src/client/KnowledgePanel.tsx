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

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { referenceInChat } from 'dsh-better-sidebar/src/client/reference-in-chat.ts'
import { IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type KnowledgeConfigView, type KnowledgeStatusView } from '../api.ts'
import { KnowledgePermissions } from './KnowledgePermissions.tsx'
import { KnowledgeIndexing } from './KnowledgeIndexing.tsx'
import { KnowledgePreview } from './KnowledgePreview.tsx'
import { sectionGlyph } from './MenuGlyphs.tsx'
import { KnowledgeSearch, useKnowledgeSearch } from './KnowledgeSearch.tsx'
import { KnowledgeListing } from './KnowledgeListing.tsx'
import styles from './KnowledgePanel.module.css'

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
  if (selection.kind === 'file') {
    const path = selection.path
    return path.slice(path.lastIndexOf('/') + 1)
  }
  return t('menu.search')
}

/** Which content the right-hand region shows. */
type Selection =
  | { kind: 'search' }
  | { kind: 'permissions' }
  | { kind: 'indexing' }
  | { kind: 'file'; path: string }

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
  return (await response.json()) as T
}

/**
 * Render the knowledge-base management page.
 * @param props - injected locale copy and the current session id.
 * @returns The master-detail page.
 */
export function KnowledgePanel(props: KnowledgePanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selection, setSelection] = useState<Selection>({ kind: 'search' })
  const [refreshTick, setRefreshTick] = useState(0)
  // Set by a row's context menu so the permission form opens on that path.
  const [grantPath, setGrantPath] = useState<string | undefined>(undefined)

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

  if (state.kind === 'loading') {
    return <div className={styles.page}><p className={styles.muted}>Loading…</p></div>
  }
  if (state.kind === 'unavailable') {
    return (
      <div className={styles.page}>
        <p className={styles.error} role="alert">Knowledge base is unavailable.</p>
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
    ...(canManageGrants ? [{ kind: 'permissions', key: 'menu.permissions' }] as const : []),
    { kind: 'indexing', key: 'menu.indexing' },
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

  /**
   * The selection actually rendered.
   *
   * The permission surface is refused here rather than only in the effect below, so
   * a selection left on permissions cannot render even for the single frame between
   * a status that revokes the permission and the effect that falls back. Deriving it
   * also keeps the header honest: it would otherwise name a surface the content
   * region is refusing to show.
   */
  const rendered: Selection = selection.kind === 'permissions' && !canManageGrants
    ? { kind: 'search' }
    : selection

  return (
    <div className={styles.page}>
      {/* The header spans the whole page, above the rail and the content region.
          It states what this surface is and which tree it governs, once for the
          page: the same facts inside each region would have to be repeated per
          region and would still not answer "where am I" for the page. */}
      <header className={styles.header}>
        <h2 className={styles.headerTitle}>{sectionTitle(t, rendered)}</h2>
        <p className={styles.headerFact}>
          {status.visibleFiles === null || status.visibleFiles === undefined
            ? t('mountPointMissing')
            : String(status.visibleFiles) + ' ' + t('filesUnit')}
          <span className={styles.factDot} aria-hidden="true">·</span>
          <code className={styles.headerPath}>{config.mountPoint}</code>
        </p>
      </header>
      <div className={styles.body}>
      <aside className={styles.rail}>
        {/* The search field, above the menu rows rather than among them: it takes
            text, so it is the one control in this rail that is not a destination.
            Selecting it moves the content region to the results. */}
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
                  setSelection({ kind: 'file', path: hit.relPath })
                }
              }
            }}
          />
        </div>
        <nav className={styles.menu} aria-label={t('menu')}>
          {SECTIONS.map((section) => {
            const active = rendered.kind === section.kind
            return (
              <button
                key={section.kind}
                type="button"
                className={active ? styles.menuRowActive : styles.menuRow}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSelection({ kind: section.kind } as Selection) }}
              >
                <span className={styles.menuGlyph}>{sectionGlyph(section.kind)}</span>
                <span className={styles.menuLabel}>{t(section.key)}</span>
              </button>
            )
          })}
        </nav>
        <div className={styles.treeRegion}>
          {config.mountPoint === ''
            ? <p className={styles.muted}>{t('mountPointMissing')}</p>
            : (
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
                onOpen={(path) => { setSelection({ kind: 'file', path }) }}
                onGrant={(path) => { openPermissions(path) }}
                onReference={(path, isDir) => {
                  if (sessionId === undefined) return
                  referenceInChat(props.ctx as never, sessionId, joinPath(config.mountPoint, path), isDir)
                }}
              />
            )}
        </div>
      </aside>
      <section className={styles.content}>
        {rendered.kind === 'search' && (
          <KnowledgeSearch
            t={t}
            search={search}
            locale={props.locale}
            onOpen={(path) => { setSelection({ kind: 'file', path }) }}
            idle={<KnowledgeListing
              t={t}
              locale={props.locale}
              refreshTick={refreshTick}
              onOpen={(path) => { setSelection({ kind: 'file', path }) }}
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
          />
        )}
        {rendered.kind === 'indexing' && (
          <KnowledgeIndexing
            t={t}
            status={status}
            onChanged={() => { void load(); setRefreshTick(n => n + 1) }}
          />
        )}
        {rendered.kind === 'file' && (
            <KnowledgePreview
              path={rendered.path}
              mountPoint={config.mountPoint}
              t={t}
            />
          )}
      </section>
      </div>
    </div>
  )
}
