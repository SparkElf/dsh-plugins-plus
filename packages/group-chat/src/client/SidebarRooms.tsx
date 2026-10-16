/**
 * The group-chat region of the left sidebar.
 *
 * Structured after `ui-workspace`'s browsing region so the two read as the same design
 * system rather than a lookalike: a 36px header holding a 14px section label, a
 * collapsible search slot, and the trailing icon actions (view options, new room), then
 * a flat list of rows. Sizes, tokens, and icon set are the ones that package uses — the
 * group-chat region is the workspace region with the grouping removed, because a room is
 * 1:1 with its session while a workspace is 1:N.
 *
 * Registered into `sidebar.footer.action`, the official list seat at the sidebar foot. The
 * shell renders it inside `footerActions` (full width, `flex: none`), under
 * `sidebar.workspaces` and above Settings.
 *
 * @module @sparkelf/dsh-group-chat/client/SidebarRooms
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronsUpDownOutlineRegular,
  IconQueueOutlineRegular,
  IconClockOutlineRegular,
  IconCloseFillRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Button,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoom, updateRoom, type RoomSummary } from './api.ts'
import { CreateRoomDialog } from './CreateRoomDialog.tsx'
import { RoomDialogs } from './RoomDialogs.tsx'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './SidebarRooms.module.css'

/** Props the `sidebar.footer.action` seat injects. */
export interface SidebarRoomsInjected {
  /** Namespace-bound copy resolver, supplied by the Client entry. */
  readonly t: (key: GroupChatKey) => string
  /** The list both sidebar and page read, owned by the Client entry. */
  readonly store: RoomStore
}

/** How often the list re-reads, so a peer's new room appears without a reload. */
const REFRESH_MS = 10_000

/** Sort orders the view menu offers, mirroring the workspace menu's updated/manual pair. */
type OrderBy = 'updated' | 'manual'

/** Whether rooms the operator left are listed. */
type ArchivedFilter = 'default' | 'all'

/**
 * Render the sidebar's group-chat region.
 * @param props - the injected copy resolver and the shared room store.
 * @returns the section header plus the flat room list.
 */
export function SidebarRooms(props: SidebarRoomsInjected) {
  const { t, store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const { rooms, activeRoomId, failure, searchQuery } = state

  const [searchExpanded, setSearchExpanded] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [orderBy, setOrderBy] = useState<OrderBy>('updated')
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>('default')
  const searchInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => { void store.refresh() }, [store])
  useEffect(() => {
    const timer = setInterval(() => { void store.refresh() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [store])

  // The search box closes on Escape and on a click outside, the same way the workspace
  // one does, so the header returns to its resting width without a second control.
  useEffect(() => {
    if (!searchExpanded) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest(`.${styles.search}`) === null) {
        if (searchQuery.length === 0) setSearchExpanded(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchExpanded, searchQuery.length])

  const query = searchQuery.trim().toLowerCase()
  const visible = (rooms ?? [])
    // A room the operator left is hidden by default and reachable through the view menu,
    // which is the same shape the workspace list uses for archived sessions.
    .filter((room) => archivedFilter === 'all' || room.joined)
    .filter((room) => query.length === 0 || room.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => orderBy === 'manual'
      ? 0
      : Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))

  const onPickOrder = useCallback(async (mode: OrderBy): Promise<void> => {
    setOrderBy(mode)
    setViewOpen(false)
  }, [])

  return (
    <section className={styles.root} aria-label={t('title')}>
      <div className={styles.sectionHeader}>
        {!searchExpanded && <span className={styles.sectionLabel}>{t('title')}</span>}

        <div className={searchExpanded ? styles.searchSlotExpanded : styles.searchSlot}>
          <div
            className={searchExpanded ? styles.searchExpanded : styles.search}
            onClick={() => { setSearchExpanded(true); searchInput.current?.focus() }}
          >
            <Tooltip label={t('search')} side="bottom" delayMs={500} disabled={searchExpanded}>
              <button
                type="button"
                className={styles.searchButton}
                aria-label={t('search')}
                aria-expanded={searchExpanded}
                onClick={(event) => {
                  event.stopPropagation()
                  setSearchExpanded((v) => !v)
                }}
              >
                <IconSearchOutlineRegular size={searchExpanded ? 11 : 14} />
              </button>
            </Tooltip>
            <input
              ref={searchInput}
              className={styles.searchInput}
              type="text"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              tabIndex={searchExpanded ? 0 : -1}
              onChange={(event) => store.setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                store.setSearch('')
                setSearchExpanded(false)
              }}
            />
            {searchExpanded && (
              <button
                type="button"
                className={styles.clearButton}
                aria-label={t('searchClear')}
                onClick={(event) => {
                  event.stopPropagation()
                  store.setSearch('')
                  setSearchExpanded(false)
                }}
              >
                <IconCloseFillRegular />
              </button>
            )}
          </div>
        </div>

        {!searchExpanded && (
          <div className={styles.headerActions}>
            <ViewOptionsMenu
              t={t}
              open={viewOpen}
              orderBy={orderBy}
              archivedFilter={archivedFilter}
              onToggle={() => setViewOpen((v) => !v)}
              onPickOrder={(mode) => void onPickOrder(mode)}
              onPickArchived={(mode) => { setArchivedFilter(mode); setViewOpen(false) }}
            />
            <Tooltip label={t('createRoom')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t('createRoom')}
                onClick={() => store.openCreate()}
              >
                <IconProjectAddOutlineRegular size={16} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <div className={styles.listArea}>
        <div className={styles.list}>
          {failure !== undefined && <p className={styles.empty}>{t(failure)}</p>}
          {failure === undefined && rooms === undefined && <p className={styles.empty}>{t('loading')}</p>}
          {failure === undefined && rooms !== undefined && visible.length === 0 && (
            /* The same shape the workspace region uses when it has no sessions: a centred
               glyph above the copy and nothing else. The header already carries the way to
               create a room, so an action here would repeat it. */
            <div className={styles.emptyState}>
              <IconQueueOutlineRegular size={28} />
              <span>{query.length > 0 ? t('searchEmpty') : t('emptyRooms')}</span>
            </div>
          )}
          {visible.length > 0 && (
            <ul className={styles.flatList}>
              {visible.map((room) => (
                <li key={room.id}>
                  <RoomRow
                    room={room}
                    t={t}
                    store={store}
                    selected={room.id === activeRoomId}
                    onOpen={() => store.open(room.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Matches the workspace list's bottom fade, so the list reads as scrollable
            without a visible scrollbar track. */}
        <div className={styles.fade} aria-hidden="true" />
      </div>

      {/* The dialogs live here rather than on the room page. `Modal` portals itself to
          `document.body`, so it only needs to be rendered by a mounted component — and
          this region is always mounted, while the room page is not: pressing "New room"
          from the sidebar must work before any room has ever been opened. */}
      <CreateRoomDialog t={t} store={store} />
      <RoomDialogs t={t} store={store} />
    </section>
  )
}

/** One room row: glyph, name, and the member count where a session row shows its time. */
function RoomRow(props: {
  room: RoomSummary
  t: (key: GroupChatKey) => string
  selected: boolean
  onOpen: () => void
  store: RoomStore
}) {
  const { room, t, selected, onOpen, store } = props
  // The rect is captured when the menu opens, not read during render: the menu is
  // positioned against where the row was at that moment, so scrolling the list while the
  // menu is open does not drag it away from the row the operator aimed at.
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  return (
    <div className={styles.rowWrap}>
      <button
        type="button"
        className={selected ? styles.sessionRowSelected : styles.sessionRow}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuAnchor(event.currentTarget.getBoundingClientRect())
        }}
        aria-current={selected}
      >
        <span className={styles.rowIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h5a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 9 8H5.5L3 10V8h-.5A1.5 1.5 0 0 1 2.5 6.5z" />
            <path d="M11 5.5h1A1.5 1.5 0 0 1 13.5 7v3.5A1.5 1.5 0 0 1 12 12h-.5v2l-2.5-2H7" />
          </svg>
        </span>
        <span className={styles.title}>{room.name}</span>
        <span className={styles.time}>
          {room.joined ? t('memberCountShort').replace('{count}', String(room.memberCount)) : t('left')}
        </span>
      </button>
      {menuAnchor !== null && (
        <RoomMenu t={t} room={room} store={store} anchor={menuAnchor}
                  onClose={() => setMenuAnchor(null)} />
      )}
    </div>
  )
}

/**
 * The row's context menu.
 *
 * Two official workspace entries are absent here rather than relabelled. Archiving would
 * duplicate "leave room", and forking copies history whose events carry no member
 * attribution — producing a room that looks continuous but whose earlier messages belong
 * to nobody. The remaining entries are the ones the design settled on, and each is shown
 * only when it applies to this room and this caller.
 */
function RoomMenu(props: {
  t: (key: GroupChatKey) => string
  room: RoomSummary
  store: RoomStore
  onClose: () => void
  /** Viewport rect of the row that opened the menu, which the portal positions against. */
  anchor: DOMRect
}) {
  const { t, room, store, onClose, anchor } = props
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(room.name)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  // Rendered into `document.body`, not beside the row. The room list scrolls
  // (`overflow-y: auto`), and a positioned menu inside a scrolling box is clipped at the
  // box's edge — the lower rooms' menus lost their bottom entries. The portal puts the menu
  // outside every clipping ancestor, and the anchor rect keeps it visually attached to the
  // row that opened it.
  //
  // The menu flips above the row when the row sits too low in the viewport to hold it:
  // pinning `top` unconditionally pushed the last rooms' menus past the bottom edge, which
  // clips exactly the entries the operator was reaching for. `bottom` is measured from the
  // viewport edge, so the flip needs no knowledge of the menu's own height.
  const below = window.innerHeight - anchor.bottom - 8
  const flip = below < 220 && anchor.top > below
  const placement = flip
    ? { bottom: window.innerHeight - anchor.top + 4 }
    : { top: anchor.bottom + 4 }
  const portal = (body: React.ReactNode): React.ReactPortal =>
    createPortal(
      <div className={styles.menuLayer} style={{ ...placement, left: anchor.left }}
           onClick={(event) => event.stopPropagation()}>
        {body}
      </div>,
      document.body,
    )

  if (renaming) {
    return portal(
      <div className={styles.menu} role="dialog" aria-label={t('renameTitle')}>
        <span className={styles.menuHeading}>{t('renameTitle')}</span>
        <input
          className={styles.menuInput}
          value={draftName}
          autoFocus
          placeholder={t('renamePlaceholder')}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draftName.trim().length > 0) {
              void run(() => store.rename(room.id, draftName.trim()))
            }
            if (event.key === 'Escape') { setRenaming(false); setDraftName(room.name) }
          }}
        />
        <button
          type="button"
          className={styles.menuItem}
          disabled={busy || draftName.trim().length === 0}
          onClick={() => void run(() => store.rename(room.id, draftName.trim()))}
        >
          {t('save')}
        </button>
      </div>,
    )
  }

  return portal(
    <div className={styles.menu} role="menu">
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => setRenaming(true)}>
        {t('menuRename')}
      </button>
      {/* Inviting and leaving are member actions; the server decides whether this caller
          may invite, so the entry is offered to members and a refusal surfaces as copy. */}
      {room.joined && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={() => { store.setDialog({ kind: 'invite', roomId: room.id }); onClose() }}>
          {t('menuInvite')}
        </button>
      )}
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => { store.setDialog({ kind: 'members', roomId: room.id }); onClose() }}>
        {t('menuMembers')}
      </button>
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => { store.setDialog({ kind: 'settings', roomId: room.id }); onClose() }}>
        {t('menuSettings')}
      </button>
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => { void navigator.clipboard?.writeText(room.id); onClose() }}>
        {t('copyRoomId')}
      </button>
      {room.joined && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={() => void run(() => store.leave(room.id))}>
          {t('menuLeave')}
        </button>
      )}
    </div>,
  )
}

/** The trailing view menu: ordering and whether rooms the operator left are listed. */
function ViewOptionsMenu(props: {
  t: (key: GroupChatKey) => string
  open: boolean
  orderBy: OrderBy
  archivedFilter: ArchivedFilter
  onToggle: () => void
  onPickOrder: (mode: OrderBy) => void
  onPickArchived: (mode: ArchivedFilter) => void
}) {
  const { t, open, orderBy, archivedFilter, onToggle, onPickOrder, onPickArchived } = props
  return (
    <div className={styles.viewWrap}>
      <Tooltip label={t('viewOptions')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('viewOptions')}
          aria-expanded={open}
          onClick={onToggle}
        >
          <IconSlidersTwoOutlineRegular size={16} />
        </button>
      </Tooltip>
      {open && (
        <div className={styles.menuInline} role="menu">
          <span className={styles.menuHeading}>{t('orderBy')}</span>
          <button type="button" role="menuitem" className={styles.menuItem}
                  onClick={() => onPickOrder('updated')}>
            <IconClockOutlineRegular size={14} />
            {t('orderByUpdated')}
            {orderBy === 'updated' && <span className={styles.check}>✓</span>}
          </button>
          <button type="button" role="menuitem" className={styles.menuItem}
                  onClick={() => onPickOrder('manual')}>
            <IconChevronsUpDownOutlineRegular size={14} />
            {t('orderByManual')}
            {orderBy === 'manual' && <span className={styles.check}>✓</span>}
          </button>
          <span className={styles.menuHeading}>{t('archivedFilter')}</span>
          <button type="button" role="menuitem" className={styles.menuItem}
                  onClick={() => onPickArchived('default')}>
            {t('archivedHide')}
            {archivedFilter === 'default' && <span className={styles.check}>✓</span>}
          </button>
          <button type="button" role="menuitem" className={styles.menuItem}
                  onClick={() => onPickArchived('all')}>
            {t('archivedShow')}
            {archivedFilter === 'all' && <span className={styles.check}>✓</span>}
          </button>
        </div>
      )}
    </div>
  )
}
