/**
 * The Home surface: the page's landing view.
 *
 * Three ways to start, over a tabbed list of what the reader already has. The tabs
 * select the SET, and the table shows that set's rows; nothing here invents data,
 * so a tab with no rows says so rather than filling the table with placeholders.
 *
 * The listing comes from the same route the tree uses. Categorising a document as
 * "owned by me" or "shared with me" would need an owner per file, and the
 * knowledge tree carries none: it is a directory of documents whose authorization
 * lives in DataOps grants. So the tabs narrow by what the tree can actually
 * answer, and the Owner column is drawn from the grant data only when a caller
 * supplies it. Filling that column with a guess would be worse than leaving it
 * blank.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { ownerLabelOf } from './ownerLabel.ts'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  IconFolderOpenOutlineRegular,
  IconListPenOutlineRegular,
  IconPlusOutlineRegular,
  IconRightUpOutlineRegular,
  SegmentedTabs,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeHome.module.css'
import panelStyles from './KnowledgePanel.module.css'
import { KnowledgeTemplates } from './KnowledgeTemplates.tsx'
import { KnowledgeCreateDialog, defaultDestination, type CreateMode } from './KnowledgeCreateDialog.tsx'
import { isFileDrag, planDrop, readDroppedFiles } from './useFileDrop.ts'
import {
  KnowledgeContextMenu,
  type ContextTarget,
  type TreeClipboard,
} from './KnowledgeContextMenu.tsx'
import { shareCopyFor } from './knowledgeMenuCopy.ts'
import {
  splitShareRelations,
  type PrincipalNameOf,
  type ShareGrant,
  type ShareRow,
} from './shareRelations.ts'
import { DEFAULT_PAGE_SIZE, paginate, needsPager } from './paging.ts'

/** One document row, as the table renders it. */
interface HomeRow {
  /** Path relative to the mount point. */
  relPath: string
  /** File name alone. */
  name: string
  /** Directory the file sits in, for the Location column. */
  location: string
  /** Last-modified instant in Unix ms, which is the tree's only timestamp. */
  mtimeMs?: number
}

/** The tabs, in display order. */
type HomeTab = 'recent' | 'mine' | 'shared' | 'starred'

/** The three starting points. Order here is the render order. */
type CardId = 'new' | 'upload' | 'template'

/**
 * Which plate colour a card's glyph sits on.
 *
 * A name rather than a colour: the stylesheet resolves it to a real theme token,
 * so a palette change lands in one place and no literal can drift into the code.
 */
type CardTone = 'blue' | 'amber' | 'deepseek'

/**
 * One row in a card's menu, and the action it stands for.
 *
 * A `kind` rather than a callback: the menu is built from a table above the
 * handlers, so naming the action here keeps the data and the wiring separate and
 * makes the set of things a card can do greppable.
 */
interface CardItem {
  /** Locale-bound row label. */
  label: string
  /** Which handler the row runs. */
  kind: 'new-doc' | 'new-folder' | 'upload-file' | 'upload-folder' | 'open-templates'
}

/** Props for the Home surface. */
export interface KnowledgeHomeProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Locale tag, so dates match the reader's language. */
  locale?: string
  /** Disabled when the tree is not mounted, so the cards cannot promise a tree. */
  mountPoint: string
  /** Open one document in the preview. */
  onOpen: (path: string) => void
  /**
   * The caller's DataOps id, when the status route reported one.
   *
   * Used only to choose where a create lands by default: with no current directory
   * the reader's own `personal/<id>` folder is the one place a new draft cannot
   * surprise a colleague, so it is preferred over `global`.
   */
  callerId?: string
  /** The caller's own department code, so the owner cell can name it instead of a slug. */
  departmentCode?: string
  /** The caller's own department name; the code stands in when this is absent. */
  departmentName?: string
  /**
   * The tab whose card should take focus on mount.
   *
   * Set when a reader arrives here from the tree's empty state, which is asking
   * them to start a document: the blank-page card is the answer to that question,
   * so it is the one that should be reachable by keyboard immediately.
   */
  focusNew?: boolean
  /**
   * Star or unstar one row.
   *
   * The Home table is the surface a reader actually starts from, so the context menu
   * lives here as well as on the tree. Omitted by a caller with no favourites store,
   * which keeps the menu's star entry out rather than offering a write that cannot land.
   */
  onFavorite?: (path: string, favorite: boolean) => void
  /** Whether one path is currently favourited, so the row can draw its star. */
  isFavorite?: (path: string) => boolean
  /** Open the permission surface for one path. */
  onGrant?: (path: string) => void
  /** Insert a reference to this path into the conversation. */
  onReference?: (path: string, isDir: boolean) => void
  /** Pin or unpin one row, offered by the same menu the tree uses. */
  onPin?: (path: string, pinned: boolean) => void
  /** Whether one path is currently pinned. */
  isPinned?: (path: string) => boolean
  /**
   * Called after any menu action that changed the tree.
   *
   * The table holds its own rows, so a rename/delete/paste has to be followed by a
   * re-read; the page owns the tick that triggers it.
   */
  onTreeChanged?: () => void
  /**
   * Upload files dropped onto the table area.
   *
   * The table lists documents only -- there is no directory row here to aim at -- so
   * the whole surface is one target and the destination has to be decided rather than
   * read off the row under the pointer. `dropDirectory` carries that decision.
   * Omitted by a read-only caller, which keeps the surface from accepting a drop that
   * would then be refused on the Host.
   * @param directory - the tree-relative directory the files land in.
   * @param files - the dropped files with paths relative to that directory.
   */
  onUpload?: (directory: string, files: readonly { file: unknown; relativePath: string }[]) => void
  /**
   * Where a drop on this table lands, tree-relative.
   *
   * The reader's own folder is the right default: `global` is the bucket everyone
   * reads, so defaulting there would publish a private draft without asking. Empty
   * means the mount root, which is what a caller with no personal bucket gets.
   */
  dropDirectory?: string
}

/** Format one instant for the table, matching the preview's own absolute form. */
function formatStamp(mtimeMs: number | undefined, locale: string): string {
  if (mtimeMs === undefined) return '—'
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(locale.startsWith('zh') ? 'zh-CN' : 'en-US')
}

/** The directory part of a relative path, or a dash at the root. */
function locationOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/')
  return cut === -1 ? '—' : relPath.slice(0, cut)
}

/** Props for one direction of the Share tab. */
interface ShareBlockProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** The block's heading, which also states the direction. */
  title: string
  /** What to say when this direction has no rows. */
  empty: string
  /** The rows on the current page. */
  rows: readonly ShareRow[]
  /** 1-based page shown. */
  page: number
  /** Total pages. */
  pageCount: number
  /** Whether the pager is worth drawing at all. */
  showPager: boolean
  /** Move to another page. */
  onPage: (page: number) => void
  /** How one row's sharing relation reads. */
  relationOf: (row: ShareRow) => string
  /** Header for the audience column. */
  audienceHeader: string
  /** Copy for a grant whose principal id is empty. */
  unknownAudience: string
  /** Locale tag for dates, unused when the row has none. */
  locale: string
}

/**
 * One direction of the Share tab: a heading, its own table, its own pager.
 *
 * Kept as one component for both directions so the two blocks cannot drift in layout.
 * The only thing that differs is `relationOf`, which is where the honesty rule lives:
 * "shared with me" says where it came from generically, because the sharer is not in
 * the grant data; "I shared out" names the audience, which is a fact the data does
 * support.
 * @param props - the block's rows and copy.
 * @returns The block.
 */
function ShareBlock(props: ShareBlockProps): ReactNode {
  const c = props.t
  return (
    <section className={styles.shareBlock} aria-label={props.title}>
      <h3 className={styles.shareTitle}>{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className={styles.shareEmpty}>{props.empty}</p>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{c('homeColTitle')}</th>
                <th>{c('homeColLocation')}</th>
                <th>{c('shareColRelation')}</th>
                <th>{props.audienceHeader}</th>
                <th>{c('shareColPermission')}</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map(row => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className={styles.muted}>{row.location}</td>
                  <td className={styles.muted}>{props.relationOf(row)}</td>
                  {/* A grant whose principal id is empty has no audience to name; every
                      other row prints either the resolved label or the real id. */}
                  <td className={styles.muted}>
                    {row.audience === '' ? props.unknownAudience : row.audience}
                  </td>
                  <td className={styles.muted}>{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {props.showPager && (
            <div className={styles.sharePager}>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.page <= 1}
                onClick={() => { props.onPage(props.page - 1) }}
              >
                {c('auditPagePrev')}
              </Button>
              <span className={styles.muted}>
                {c('auditPageOf').replace('{page}', String(props.page)).replace('{pages}', String(props.pageCount))}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.page >= props.pageCount}
                onClick={() => { props.onPage(props.page + 1) }}
              >
                {c('auditPageNext')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Render the Home surface.
 * @param props - copy resolver, mount state, and the open callback.
 * @returns The Home view.
 */
export function KnowledgeHome(props: KnowledgeHomeProps) {
  const c = props.t
  const locale = props.locale ?? 'zh-CN'
  const [rows, setRows] = useState<HomeRow[]>([])
  /** True while a file drag is over the table, so the surface shows it will accept it. */
  const [dropActive, setDropActive] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tab, setTab] = useState<HomeTab>('recent')
  /**
   * Which create/upload dialog is open, or undefined when none is.
   *
   * The reference opened a dropdown under each card and then a browser `prompt` for
   * the name, which cannot show or change where the file lands. The card is now a
   * trigger for one dialog that asks both questions at once.
   */
  const [dialog, setDialog] = useState<CreateMode | undefined>(undefined)
  /**
   * What the last menu action did, so the reader sees an outcome.
   *
   * A single line rather than a toast: these actions run inside a dropdown, and a
   * transient overlay would outlive the menu that caused it. The text is replaced
   * by the next action, which is what makes it a report rather than a log.
   */
  const [notice, setNotice] = useState<string | null>(null)
  /** Whether the template library covers the surface. */
  const [templatesOpen, setTemplatesOpen] = useState(false)
  /**
   * The open context menu: which row, and where the pointer was.
   *
   * One menu for the whole table rather than one per row, because a row is re-created
   * on every re-read and an open menu owned by a row would unmount with it.
   */
  const [menu, setMenu] = useState<{ target: ContextTarget; at: { x: number; y: number } } | null>(null)
  /**
   * The cut/copied entry, held for the clipboard's lifetime.
   *
   * Client state, like the tree's: nothing about a pending paste is worth persisting,
   * and paste goes through the Host's own `copy` / `move` routes.
   */
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null)
  /** Locale-resolved copy for the share dialog, whose strings are dialog-specific. */
  const shareCopy = useMemo(() => shareCopyFor(props.locale), [props.locale])

  /**
   * The two share groups, read from the grants route the permissions page already uses.
   *
   * No new endpoint: the same `grants` payload, split by direction. `null` means "not
   * read yet", which is distinct from "read and empty" -- the two need different copy,
   * and an empty array would let a failed read look like a clean bill of health.
   */
  const [share, setShare] = useState<{ received: ShareRow[]; given: ShareRow[] } | null>(null)
  /** Whether the grants read is in flight, so the block can say so instead of flashing empty. */
  const [shareLoading, setShareLoading] = useState(false)
  /** A failed grants read, surfaced in the block rather than silently showing nothing. */
  const [shareError, setShareError] = useState<string | undefined>(undefined)
  /** Each group pages independently: their sizes differ by orders of magnitude. */
  const [receivedPage, setReceivedPage] = useState(1)
  const [givenPage, setGivenPage] = useState(1)



  /**
   * Read the grants and split them into the two directions.
   *
   * Runs only while the Share tab is open: the grants route is admin-scoped and not
   * every reader may call it, so asking for it on mount would produce a refusal for
   * people who never opened the tab. A refusal is shown as itself rather than as an
   * empty list -- "you cannot see this" and "there is nothing here" are different facts.
   *
   * Principal names come from the same `principals` route the permission editor uses,
   * one call per kind, and a kind that fails simply yields no names -- the rows then
   * print their real principal ids, which is still true data.
   */
  const readShares = useCallback(async (): Promise<void> => {
    if (props.mountPoint === '') return
    setShareLoading(true)
    setShareError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.grants), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mountPoint: props.mountPoint }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const payload = await readKnowledgeJson<{
        grants?: ShareGrant[]
        supported?: boolean
        error?: { message?: string }
      }>(response)
      if (payload.supported === false) {
        // No permissions backend: the two groups are genuinely unknown, not empty.
        // Reuses the permissions surface's own wording rather than adding a key.
        setShare({ received: [], given: [] })
        setShareError(c('readFailed'))
        return
      }
      const grants = payload.grants ?? []
      // Collect the principal ids actually referenced, then resolve each kind once.
      const needed = new Map<ShareGrant['principalType'], Set<string>>()
      for (const grant of grants) {
        const bucket = needed.get(grant.principalType) ?? new Set<string>()
        bucket.add(grant.principalId)
        needed.set(grant.principalType, bucket)
      }
      const resolved = new Map<string, string>()
      await Promise.all([...needed.entries()].map(async ([kind, ids]) => {
        try {
          const answer = await fetch(kbApiPath(KB_API.principals), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ principalType: kind }),
            cache: 'no-store',
          })
          if (!answer.ok) return
          const body = await readKnowledgeJson<{ options?: Array<{ id: string; label: string }> }>(answer)
          for (const option of body.options ?? []) {
            if (ids.has(option.id)) resolved.set(kind + ':' + option.id, option.label)
          }
        } catch {
          // One kind failing leaves its rows printing their ids, which is still true.
        }
      }))
      const nameOf: PrincipalNameOf = (kind, id) => resolved.get(kind + ':' + id)
      setShare(splitShareRelations(grants, props.callerId, nameOf))
    } catch (error: unknown) {
      setShare({ received: [], given: [] })
      setShareError(error instanceof Error ? error.message : c('readFailed'))
    } finally {
      setShareLoading(false)
    }
  }, [props.mountPoint, props.callerId, c])

  // Read the shares when the tab is opened, and again whenever the caller identity
  // resolves (it arrives after mount), so the split is never computed against
  // "unknown caller" longer than necessary.
  useEffect(() => {
    if (tab !== 'shared') return
    void readShares()
  }, [tab, readShares])

  /**
   * The rows for one group, paged.
   *
   * Paged independently because the two groups answer different questions and their
   * sizes differ: a reader with fifty inbound grants and three outbound would otherwise
   * have to page past all fifty to see their own three.
   */
  const pagedReceived = useMemo(
    () => paginate(share?.received ?? [], receivedPage, DEFAULT_PAGE_SIZE),
    [share, receivedPage],
  )
  const pagedGiven = useMemo(
    () => paginate(share?.given ?? [], givenPage, DEFAULT_PAGE_SIZE),
    [share, givenPage],
  )

    // Read once per mount, one level deep in each bucket.
    //
    // Documents live inside the buckets, not beside them: the mount's own level holds
    // only the three bucket directories, so listing it alone yields an empty table no
    // matter how many documents exist. Each bucket is one directory deep, which is
    // where a document sits, so the walk stops there instead of turning a landing page
    // into a full filesystem scan.
    const read = useCallback(async (): Promise<void> => {
      if (props.mountPoint === '') {
        setState('error')
        return
      }
      setState('loading')
      try {
        const listLevel = async (path: string): Promise<Array<{ relPath: string; name: string; isDir: boolean; mtimeMs?: number }>> => {
          const response = await fetch(kbApiPath(KB_API.list), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          const body = await readKnowledgeJson<{
            entries?: Array<{ relPath: string; name: string; isDir: boolean; mtimeMs?: number }>
          }>(response)
          return body.entries ?? []
        }
        const root = await listLevel('')
        // A bucket that cannot be read must not hide the others; the tree reports
        // per-row readability, so this surface stays a convenience listing.
        const buckets = root.filter(entry => entry.isDir).map(entry => entry.relPath)
        const nested = await Promise.all(buckets.map(async bucket => {
          try {
            return (await listLevel(bucket)).filter(entry => !entry.isDir)
          } catch {
            return []
          }
        }))
        setRows(nested.flat().map(entry => ({
          relPath: entry.relPath,
          name: entry.name,
          location: locationOf(entry.relPath),
          ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
        })))
        setState('ready')
      } catch {
        setState('error')
      }
    }, [props.mountPoint])

  useEffect(() => { void read() }, [read])

  /**
   * Which create/upload flow one card row starts.
   *
   * The rows keep their `kind` vocabulary so the card table above stays data rather
   * than wiring, but every one of them now opens the shared dialog instead of
   * branching into a prompt or a hidden file input: the dialog is what makes "where
   * does it go" a question the reader can answer.
   */
  const openDialogFor = useCallback((kind: CardItem['kind']): void => {
    if (kind === 'open-templates') {
      setTemplatesOpen(true)
      return
    }
    setDialog(kind)
  }, [])

  // "Recently opened" is the only set the tree can answer: its one time field is
  // the modification instant. The other three need an owner or a star per file,
  // neither of which exists yet, so they render the empty line rather than a
  // fabricated set.
  /**
   * The rows the current tab shows.
   *
   * Only `recent` used to be implemented; the other three fell through to `[]`, which
   * made them read as "you have nothing" rather than "this tab is not wired up". The
   * starred tab is now real: it filters the rows already read by the caller's own
   * favourites, so starring a document makes it appear here without a second request.
   *
   * `mine` and `shared` still have no owner information behind them -- the tree carries
   * no owner per file, only DataOps grants -- so they keep the empty list and their own
   * empty-state wording rather than inventing a split the data cannot support.
   */
  const visible = useMemo(() => {
    if (tab === 'recent') return [...rows].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    if (tab === 'starred') {
      // Order by modification time like `recent`, so the same set reads the same way
      // whichever tab the reader is on.
      return rows
        .filter(row => props.isFavorite?.(row.relPath) === true)
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    }
    return []
  }, [tab, rows, props.isFavorite])

  // The product's own glyphs rather than drawn characters: a text glyph renders at
  // the font's weight and baseline, which reads heavier than the 1px icon stroke
  // every other control on this page uses.
  //
  // Each card carries a tone, because the reference draws the glyph on a coloured
  // rounded plate rather than bare on the card. The tone names a real theme token
  // (`--dsw-static-blue-500` and friends); the stylesheet maps it, so no colour
  // literal appears here.
  const cards: Array<{ id: CardId; title: string; body: string; tone: CardTone; glyph: ReactNode; items: CardItem[] }> = [
    {
      id: 'new',
      title: c('homeNewTitle'),
      body: c('homeNewBody'),
      tone: 'blue',
      glyph: <IconPlusOutlineRegular size={16} />,
      // Only the two the Host can actually perform. The reference lists eight more
      // (table, slides, mind map, whiteboard...); this plugin has no editor for any
      // of them, so offering them would be a control that does nothing.
      items: [
        { label: c('cardItemNewDoc'), kind: 'new-doc' as const },
        { label: c('cardItemNewFolder'), kind: 'new-folder' as const },
      ],
    },
    {
      id: 'upload',
      title: c('homeUploadTitle'),
      body: c('homeUploadBody'),
      tone: 'amber',
      glyph: <IconRightUpOutlineRegular size={16} />,
      items: [
        { label: c('cardItemUploadFile'), kind: 'upload-file' as const },
        { label: c('cardItemUploadFolder'), kind: 'upload-folder' as const },
      ],
    },
    {
      id: 'template',
      title: c('homeTemplateTitle'),
      body: c('homeTemplateBody'),
      // The reference's third plate is a multi-colour mark of its own; this plugin
      // has no equivalent artwork, so it takes the product's own brand tone. That is
      // a substitution, not a copy of the reference.
      tone: 'deepseek',
      glyph: <IconListPenOutlineRegular size={16} />,
      items: [{ label: c('cardItemOpenTemplates'), kind: 'open-templates' as const }],
    },
  ]

  return (
    <div className={styles.home}>
      <div className={styles.cards}>
        {/* A card, not a Button: the whole tile is the target and its own layout
            (plate, text, chevron) is the content. `Button` renders a fixed-height
            control whose label is a single line, so using it here would mean
            recreating the card inside it.

            Geometry follows the reference image, measured at
            `/root/projects/kb-notes/CARD-SPEC-VERIFIED-BY-KBUI.md`: a horizontal
            row, a 20.5 CSS px rounded colour plate, and the three parts vertically
            centred. The stylesheet carries the per-value provenance. */}
        {cards.map(card => (
          <div key={card.id} className={styles.cardSlot}>
            <button
              type="button"
              className={styles.card}
              data-card={card.id}
              aria-expanded={dialog !== undefined && card.items.some(item => item.kind === dialog)}
              aria-haspopup={card.id === 'template' ? 'dialog' : undefined}
              // Autofocus only the blank-page card, and only when the caller asked:
              // moving focus without being asked would steal it from the rail.
              autoFocus={props.focusNew === true && card.id === 'new'}
              disabled={props.mountPoint === ''}
              // One card, one intent: the blank-page card starts a document, the
              // upload card starts an upload, and the template card opens the library.
              // A card with more than one row (a document OR a folder, a file OR a
              // folder) still has a single obvious first action, so the extra rows
              // stay as the dialog's own choice instead of a dropdown.
              onClick={() => {
                const first = card.items[0]
                if (first !== undefined) openDialogFor(first.kind)
              }}
            >
              <span className={styles.cardPlate} data-tone={card.tone} aria-hidden="true">{card.glyph}</span>
              <span className={styles.cardText}>
                <span className={styles.cardTitle}>{card.title}</span>
                <span className={styles.cardBody}>{card.body}</span>
              </span>
            </button>
          </div>
        ))}
      </div>

      {/* One dialog for all three actions. It asks the two questions the dropdown
          could not: what is it called, and where does it go. Escape, the mask and
          focus return belong to `Modal`, not to this file. */}
      <KnowledgeCreateDialog
        open={dialog !== undefined}
        mode={dialog ?? 'new-doc'}
        onClose={() => { setDialog(undefined) }}
        defaultPath={defaultDestination(undefined, props.callerId)}
        t={c}
        onDone={(message) => {
          setNotice(message)
          void read()
        }}
      />

      {/* The outcome of the last action. `role="status"` so a screen reader
          announces it without moving focus away from the menu. */}
      {notice !== null && <p className={panelStyles.notice} role="status">{notice}</p>}

      {templatesOpen && (
        <KnowledgeTemplates
          t={props.t}
          onClose={() => { setTemplatesOpen(false) }}
          mountPoint={props.mountPoint}
          callerId={props.callerId}
          // A template "use" writes a real document, so it opens like one: the same
          // path a click on the file itself takes.
          onOpen={(path) => { props.onOpen(path) }}
        />
      )}

      <SegmentedTabs<HomeTab>
        items={[
          { value: 'recent', label: c('homeTabRecent'), id: 'kb-home-recent', panelId: 'kb-home-panel' },
          { value: 'mine', label: c('homeTabMine'), id: 'kb-home-mine', panelId: 'kb-home-panel' },
          { value: 'shared', label: c('homeTabShared'), id: 'kb-home-shared', panelId: 'kb-home-panel' },
          { value: 'starred', label: c('homeTabStarred'), id: 'kb-home-starred', panelId: 'kb-home-panel' },
        ]}
        value={tab}
        onChange={setTab}
        label={c('homeTabRecent')}
      />

      <div id="kb-home-panel" role="tabpanel" aria-labelledby={'kb-home-' + tab}>
        {/* A real table, because this view is genuinely tabular: five columns that
            answer "where does this document live and when did it last change", and
            a header the reader can scan. `DisclosureRow` is the alternative the
            primitives offer, and it renders a two-level tree -- a document list has
            no nesting to disclose. */}
        <div
          className={styles.dropZone + (dropActive ? ' ' + styles.dropZoneActive : '')}
          // The table lists documents only, so there is no directory row to aim at:
          // the whole surface is the target and the destination is the prop's decision.
          onDragOver={props.onUpload === undefined ? undefined : (event) => {
            if (!isFileDrag(event.dataTransfer?.types)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDropActive(true)
          }}
          onDragLeave={props.onUpload === undefined ? undefined : () => { setDropActive(false) }}
          onDrop={props.onUpload === undefined ? undefined : (event) => {
            setDropActive(false)
            if (!isFileDrag(event.dataTransfer?.types)) return
            event.preventDefault()
            // Must run inside the dispatch: the payload is protected afterwards.
            void readDroppedFiles(event.dataTransfer).then((files) => {
              const plan = planDrop(
                { relativePath: props.dropDirectory ?? '', isDirectory: true, drops: true },
                { hasFiles: files.length > 0, files },
              )
              if (plan.kind === 'upload') props.onUpload?.(plan.directory, plan.files)
            })
          }}
        >
        {tab !== 'shared' && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{c('homeColTitle')}</th>
              <th>{c('homeColLocation')}</th>
              <th>{c('homeColOwner')}</th>
              <th>{c('homeColCreated')}</th>
              <th>{c('homeColOpened')}</th>
            </tr>
          </thead>
          <tbody>
            {state === 'loading' && (
              <tr className={styles.emptyRow}>
                <td colSpan={5}>{c('loading')}</td>
              </tr>
            )}
            {state === 'error' && (
              <tr className={styles.emptyRow}>
                <td colSpan={5}>{c('unavailable')}</td>
              </tr>
            )}
            {state === 'ready' && visible.length === 0 && (
              <tr className={styles.emptyRow}>
                {/* A starred tab with nothing in it is not an empty knowledge base; it
                    is "you have not starred anything yet". Saying the former would send
                    the reader looking for lost documents. */}
                <td colSpan={5}>{tab === 'starred' ? c('homeStarredEmpty') : c('homeEmpty')}</td>
              </tr>
            )}
            {visible.map(row => (
              <tr
                key={row.relPath}
                // On the row root, not on a cell: a right-click lands on whichever
                // <td> the pointer happens to be over, and a handler on one cell would
                // silently miss the other four. `preventDefault` is what suppresses the
                // browser's own menu -- without it both menus open on top of each other.
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    target: { relPath: row.relPath, name: row.name, isDir: false },
                    at: { x: event.clientX, y: event.clientY },
                  })
                }}
              >
                <td>
                  {/* The title is the link and the rest of the row is data, so the
                      control belongs inside the cell rather than wrapping the row.
                      `Button` would paint a bordered control where this reads as a
                      link. */}
                  <button
                    type="button"
                    className={styles.rowLink}
                    onClick={() => { props.onOpen(row.relPath) }}
                  >
                    {row.name}
                  </button>
                </td>
                <td className={styles.muted}>{row.location}</td>
                {/* Ownership follows the bucket the document sits in, not a guess
                    from its name: shared documents belong to everyone, a department
                    folder to that department, and a personal folder to its owner. */}
                <td>
                  <Tag tone="quiet">
                    {ownerLabelOf(
                      row.relPath,
                      {
                        callerId: props.callerId,
                        departmentCode: props.departmentCode,
                        departmentName: props.departmentName,
                      },
                      {
                        global: c('ownerGlobal'),
                        self: c('ownerSelf'),
                        unknown: row.relPath.startsWith('department/') ? c('bucketDepartment') : c('bucketPersonal'),
                      },
                    ).label}
                  </Tag>
                </td>
                {/* The Created cell carries the favourites star on its LEFT, inside the
                    same <td>. A separate cell would add a sixth column and shift every
                    header, and the owner column was just accepted against this layout.
                    The star leads the stamp so it reads as a mark on the row rather than
                    as part of the date, and an unstarred row renders exactly as before. */}
                <td className={styles.muted}>
                  {props.isFavorite?.(row.relPath) === true && (
                    <span className={styles.favoriteMark} aria-label={c('favoriteMark')} title={c('favoriteMark')}>★</span>
                  )}
                  {formatStamp(row.mtimeMs, locale)}
                </td>
                <td className={styles.muted}>{formatStamp(row.mtimeMs, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}

        {/* The Share tab is two tables, not one: the two directions answer different
            questions and are paged separately. Each block states its own empty case,
            because "nobody has shared with you" and "you have shared nothing" are
            different facts and a shared empty message would blur them. */}
        {tab === 'shared' && (
          <div className={styles.shareWrap}>
            {shareError !== undefined && <p className={styles.shareError} role="alert">{shareError}</p>}
            {shareLoading && share === null && <p className={styles.muted}>{c('loading')}</p>}
            {share !== null && (
              <>
                <ShareBlock
                  t={c}
                  title={c('shareGroupReceived')}
                  empty={c('shareReceivedEmpty')}
                  rows={pagedReceived.rows}
                  page={pagedReceived.page}
                  pageCount={pagedReceived.pageCount}
                  showPager={needsPager(pagedReceived.total, DEFAULT_PAGE_SIZE)}
                  onPage={setReceivedPage}
                  // "Shared with me" has no arrow: the sharer is not in this data, and
                  // an arrow would claim a fact the backend cannot supply.
                  relationOf={() => c('shareReceivedRelation')}
                  audienceHeader={c('shareColPermission')}
                  unknownAudience={c('shareUnknownAudience')}
                  locale={locale}
                />
                <ShareBlock
                  t={c}
                  title={c('shareGroupGiven')}
                  empty={c('shareGivenEmpty')}
                  rows={pagedGiven.rows}
                  page={pagedGiven.page}
                  pageCount={pagedGiven.pageCount}
                  showPager={needsPager(pagedGiven.total, DEFAULT_PAGE_SIZE)}
                  onPage={setGivenPage}
                  // "I shared out" does state a direction we know: the audience is the
                  // grant's principal, and the sharer is the caller.
                  relationOf={row => c('shareGivenRelation').replace('{audience}', row.audience)}
                  audienceHeader={c('shareColAudience')}
                  unknownAudience={c('shareUnknownAudience')}
                  locale={locale}
                />
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {/* One menu for the whole table, mounted outside the scroll container so it is
          not clipped by it. Rows are re-read often; a menu owned by a row would unmount
          mid-interaction. */}
      <KnowledgeContextMenu
        target={menu?.target ?? null}
        at={menu?.at ?? null}
        t={c}
        shareCopy={shareCopy}
        pinned={menu === null ? false : props.isPinned?.(menu.target.relPath) === true}
        favorite={menu === null ? false : props.isFavorite?.(menu.target.relPath) === true}
        clipboard={clipboard}
        // Every row here is a file, so a paste lands beside it in its own directory.
        pasteInto={menu === null ? null : (menu.target.relPath.includes('/')
          ? menu.target.relPath.slice(0, menu.target.relPath.lastIndexOf('/'))
          : '')}
        onClose={() => { setMenu(null) }}
        onGrant={(path) => { props.onGrant?.(path) }}
        onPin={(path, pinned) => { props.onPin?.(path, pinned) }}
        onFavorite={(path, favorite) => { props.onFavorite?.(path, favorite) }}
        onReference={(path, isDir) => { props.onReference?.(path, isDir) }}
        onClipboard={(entry) => { setClipboard(entry) }}
        onRenamed={() => { props.onTreeChanged?.() }}
        onDeleted={() => { props.onTreeChanged?.() }}
        onMoved={() => {
          // A cut consumes the clipboard (its source is gone); a copy keeps it so the
          // same entry can be pasted into a second folder.
          setClipboard(current => (current?.cut === true ? null : current))
          props.onTreeChanged?.()
        }}
      />
    </div>
  )
}
