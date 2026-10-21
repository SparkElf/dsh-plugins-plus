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
import {
  KnowledgeContextMenu,
  type ContextTarget,
  type TreeClipboard,
} from './KnowledgeContextMenu.tsx'
import { shareCopyFor } from './knowledgeMenuCopy.ts'

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

/**
 * Render the Home surface.
 * @param props - copy resolver, mount state, and the open callback.
 * @returns The Home view.
 */
export function KnowledgeHome(props: KnowledgeHomeProps) {
  const c = props.t
  const locale = props.locale ?? 'zh-CN'
  const [rows, setRows] = useState<HomeRow[]>([])
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
  const visible = tab === 'recent'
    ? [...rows].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    : []

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
                <td colSpan={5}>{c('homeEmpty')}</td>
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
