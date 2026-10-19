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
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoom, updateRoom, type RoomSummary } from './api.ts'
import { CreateRoomDialog } from './CreateRoomDialog.tsx'
import { RoomDialogs } from './RoomDialogs.tsx'
import { joinableRooms } from './rows.ts'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './SidebarRooms.module.css'

/** Props the `sidebar.footer.action` seat injects. */
export interface SidebarRoomsInjected {
  /** Namespace-bound copy resolver, supplied by the Client entry. */
  readonly t: (key: GroupChatKey) => string
  /** Lookup for the platform's `settings.agentPreset` namespace, bound by the Client entry. */
  readonly tPreset: (key: string) => string
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
  const { t, tPreset, store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const { rooms, activeRoomId, failure, searchQuery, discoverable } = state

  const [searchExpanded, setSearchExpanded] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [orderBy, setOrderBy] = useState<OrderBy>('updated')
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>('default')
  const [joining, setJoining] = useState<string | undefined>(undefined)
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

  // Discovery runs only for a non-empty query, and debounced: every keystroke would otherwise
  // be a cross-account search, and the answer for "a" is never what the operator wanted.
  useEffect(() => {
    const keyword = searchQuery.trim()
    if (keyword.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) void store.discover(keyword)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [searchQuery, store])

  // A room already in the sidebar must not also appear as joinable: the two lists answer
  // different questions, and a room in both would offer a Join button that cannot do anything.
  const joinable = joinableRooms(discoverable ?? [], new Set((rooms ?? []).map((room) => room.id)))

  const onJoin = async (roomId: string): Promise<void> => {
    setJoining(roomId)
    try {
      await store.join(roomId)
      // Opened on success: the operator pressed Join to get into the room, so landing in it is
      // the outcome they asked for rather than a second step they must discover.
      store.open(roomId)
      store.setSearch('')
      setSearchExpanded(false)
    } finally {
      setJoining(undefined)
    }
  }

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

          {/* Rooms this account could join. Shown only while searching, because that is the
              only moment the operator is looking for something they are not already in; a
              permanent section would put other people's rooms in a sidebar that otherwise
              answers "what do I belong to". */}
          {query.length > 0 && discoverable !== undefined && joinable.length > 0 && (
            <div className={styles.discoverSection}>
              <p className={styles.discoverHeading}>{t('discoverHeading')}</p>
              <ul className={styles.flatList}>
                {joinable.map((room) => (
                  <li key={room.id}>
                    <div className={styles.discoverRow}>
                      <span className={styles.discoverName}>{room.name}</span>
                      <span className={styles.discoverMeta}>
                        {t('discoverMembers').replace('{count}', String(room.memberCount))}
                      </span>
                      <button
                        type="button"
                        className={styles.joinButton}
                        disabled={joining === room.id}
                        onClick={() => { void onJoin(room.id) }}
                      >
                        {joining === room.id ? t('joining') : t('joinRoom')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
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
      <CreateRoomDialog t={t} tPreset={tPreset} store={store} />
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
  // The leave confirmation lives on the row, not on the menu: choosing "leave room" closes
  // the menu, and a confirmation owned by the menu would unmount with it. The row itself
  // stays mounted while the room is still listed, so the dialog can stay open long enough to
  // report a refused leave.
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveFailure, setLeaveFailure] = useState<GroupChatKey | undefined>(undefined)
  // Dissolving gets its own dialog and its own failure slot: it ends the room for everyone,
  // unlike leaving, so sharing the leave state would print one act's refusal in the other's
  // dialog.
  const [confirmingDissolve, setConfirmingDissolve] = useState(false)
  const [dissolving, setDissolving] = useState(false)
  const [dissolveFailure, setDissolveFailure] = useState<GroupChatKey | undefined>(undefined)

  // A room this account has not joined has no reading position, so it never carries a badge:
  // the server reports 0 for it and the row keeps showing "left".
  const unread = room.joined ? room.unreadCount ?? 0 : 0
  const mentioned = unread > 0 && (room.mentionCount ?? 0) > 0

  const closeLeave = (): void => {
    setConfirmingLeave(false)
    setLeaveFailure(undefined)
  }

  const closeDissolve = (): void => {
    setConfirmingDissolve(false)
    setDissolveFailure(undefined)
  }

  const leave = async (): Promise<void> => {
    if (leaving) return
    setLeaving(true)
    setLeaveFailure(undefined)
    try {
      await store.leave(room.id)
      setConfirmingLeave(false)
    } catch (cause) {
      // The operator is still a member, so the dialog stays open and names the reason
      // instead of closing as if the leave had worked.
      setLeaveFailure(failureOf(cause))
    } finally {
      setLeaving(false)
    }
  }

  const dissolve = async (): Promise<void> => {
    if (dissolving) return
    setDissolving(true)
    setDissolveFailure(undefined)
    try {
      await store.dissolve(room.id)
      setConfirmingDissolve(false)
    } catch (cause) {
      // The room still exists, so the dialog stays open and names why the dissolve was
      // refused — closing here would read as success.
      setDissolveFailure(failureOf(cause))
    } finally {
      setDissolving(false)
    }
  }

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
        {unread > 0 ? (
          // The unread badge replaces the member count rather than sitting beside it: the row
          // has one trailing slot, and "3 unread" is what the reader needs from it. A mention
          // gets its own colour so "someone wrote" and "someone wrote to me" are distinguishable
          // at a glance without reading the number.
          <span
            className={mentioned ? styles.unreadMentioned : styles.unread}
            aria-label={mentioned
              ? t('unreadMentionAria').replace('{count}', String(unread))
              : t('unreadAria').replace('{count}', String(unread))}
          >
            {unread > 99 ? '99+' : String(unread)}
          </span>
        ) : (
          <span className={styles.time}>
            {room.joined ? t('memberCountShort').replace('{count}', String(room.memberCount)) : t('left')}
          </span>
        )}
      </button>
      {menuAnchor !== null && (
        <RoomMenu t={t} room={room} store={store} anchor={menuAnchor}
                  onClose={() => setMenuAnchor(null)}
                  onRequestLeave={() => { setMenuAnchor(null); setConfirmingLeave(true) }}
                  onRequestDissolve={() => { setMenuAnchor(null); setConfirmingDissolve(true) }} />
      )}
      {confirmingLeave && (
        <LeaveRoomDialog t={t} room={room} busy={leaving} failure={leaveFailure}
                         onCancel={closeLeave} onConfirm={() => void leave()} />
      )}
      {confirmingDissolve && (
        <DissolveRoomDialog t={t} room={room} busy={dissolving} failure={dissolveFailure}
                            onCancel={closeDissolve} onConfirm={() => void dissolve()} />
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
  /** Ask the row to open the leave confirmation; the menu closes as it does. */
  onRequestLeave: () => void
  /** Ask the row to open the dissolve confirmation; the menu closes as it does. */
  onRequestDissolve: () => void
  /** Viewport rect of the row that opened the menu, which the portal positions against. */
  anchor: DOMRect
}) {
  const { t, room, store, onClose, anchor, onRequestLeave, onRequestDissolve } = props
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
    const commit = (): void => {
      void run(() => store.rename(room.id, draftName.trim()))
    }
    const cancel = (): void => {
      setRenaming(false)
      setDraftName(room.name)
    }
    return portal(
      // A wider panel than the menu rows need: the field and its two actions read as one
      // small form, and a 200px menu left the label, field and button stacked edge to edge.
      <div className={styles.menuRename} role="dialog" aria-label={t('renameTitle')}>
        <span className={styles.menuHeading}>{t('renameTitle')}</span>
        <input
          className={styles.menuInput}
          value={draftName}
          autoFocus
          placeholder={t('renamePlaceholder')}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draftName.trim().length > 0) commit()
            if (event.key === 'Escape') cancel()
          }}
        />
        <div className={styles.menuActions}>
          <button type="button" className={styles.menuCancel} onClick={cancel}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className={styles.menuConfirm}
            disabled={busy || draftName.trim().length === 0}
            onClick={commit}
          >
            {t('save')}
          </button>
        </div>
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
      {/* Members are a side panel, not a dialog: a roster is consulted while reading, and a modal
          would cover the conversation it describes. `openMembers` is absent on a profile without
          the official right sidebar, where the entry would have nowhere to lead. */}
      {store.openMembers !== undefined && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={() => { store.openMembers?.(room.id); onClose() }}>
          {t('menuMembers')}
        </button>
      )}
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => { store.setDialog({ kind: 'settings', roomId: room.id }); onClose() }}>
        {t('menuSettings')}
      </button>
      <button type="button" role="menuitem" className={styles.menuItem}
              onClick={() => { void navigator.clipboard?.writeText(room.id); onClose() }}>
        {t('copyRoomId')}
      </button>
      {/* The owner is offered a transfer instead of a leave: leaving is refused by the server
          for them (a room without an owner has nobody able to change its settings), so showing
          "leave room" would only produce a refusal. Everyone else keeps the plain leave. */}
      {room.joined && store.selfId() === room.ownerUserId && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={() => { store.setDialog({ kind: 'transfer', roomId: room.id }); onClose() }}>
          {t('menuTransfer')}
        </button>
      )}
      {room.joined && store.selfId() !== room.ownerUserId && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={onRequestLeave}>
          {t('menuLeave')}
        </button>
      )}
      {/* Dissolving ends the room for everyone, so it is offered only to the people the
          server will accept it from: the owner, and an administrator. The server still
          decides on the request itself. */}
      {(store.selfId() === room.ownerUserId || store.administrator()) && (
        <button type="button" role="menuitem" className={styles.menuItem}
                onClick={onRequestDissolve}>
          {t('menuDissolve')}
        </button>
      )}
    </div>,
  )
}

  /**
   * The dissolve-room confirmation.
   *
   * A separate dialog from leaving, not a variant of it: leaving removes one membership and the
   * room carries on for everyone else, while dissolving ends it for every member and takes the
   * messages with it. Sharing one dialog would let the far more destructive act read as the
   * mild one.
   *
   * Like the leave dialog, a refusal keeps this open and prints the mapped reason: the room is
   * still there, so closing would read as success.
   */
  function DissolveRoomDialog(props: {
    t: (key: GroupChatKey) => string
    room: RoomSummary
    busy: boolean
    failure: GroupChatKey | undefined
    onCancel: () => void
    onConfirm: () => void
  }) {
    const { t, room, busy, failure, onCancel, onConfirm } = props
    return (
      <Modal
        open
        onClose={onCancel}
        title={t('menuDissolve')}
        closeLabel={t('cancel')}
        footer={(
          <div className={styles.footer}>
            <Button data-modal-autofocus variant="ghost" size="md" disabled={busy} onClick={onCancel}>
              {t('cancel')}
            </Button>
            {/* Destructive, so it is red rather than the primary fill: the primitive has no
                danger variant, and colour is the only thing separating this from a harmless
                confirm at a glance. */}
            <Button variant="ghost" size="md" disabled={busy}
                    className={styles.leaveConfirmDanger}
                    onClick={onConfirm}>
              {t('menuDissolve')}
            </Button>
          </div>
        )}
      >
        <div className={styles.leaveBody}>
          <p className={styles.leaveCopy}>{t('menuDissolveConfirm')}</p>
          {/* A bare room name read as a stray label once the dialog opened from a menu that had
              already closed. Naming the target explicitly is what lets a reader confirm they are
              about to delete the room they meant to. */}
          <p className={styles.leaveRoomName}>
            {t('menuDissolveTarget')}<strong>{room.name}</strong>
          </p>
          {failure !== undefined && (
            <p className={styles.leaveError} role="alert">{t(failure)}</p>
          )}
        </div>
      </Modal>
    )
  }


/**
 * The leave-room confirmation.
 *
 * It exists because leaving is not undoable from this surface: the sidebar keeps the room
 * under the "left rooms" filter, but rejoining is a separate discovery step. The copy names
 * that the agent's recorded history stays, which is the part a reader cannot infer.
 *
 * A refused leave keeps this dialog open and prints the mapped failure. Closing on failure
 * was the old behaviour and read as success — the only sign it had gone wrong was the room
 * still being in the list.
 */
function LeaveRoomDialog(props: {
  t: (key: GroupChatKey) => string
  room: RoomSummary
  busy: boolean
  failure: GroupChatKey | undefined
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t, room, busy, failure, onCancel, onConfirm } = props
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('menuLeave')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          {/* Cancel is the initial focus: the safe answer is the default for a destructive
              dialog, and Escape maps to the same command. */}
          <Button data-modal-autofocus variant="ghost" size="md" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="md" disabled={busy} onClick={onConfirm}>
            {t('menuLeave')}
          </Button>
        </div>
      )}
    >
      <div className={styles.leaveBody}>
        <p className={styles.leaveCopy}>{t('menuLeaveConfirm')}</p>
        <p className={styles.leaveRoomName}>{room.name}</p>
        {failure !== undefined && (
          <p className={styles.leaveError} role="alert">{t(failure)}</p>
        )}
      </div>
    </Modal>
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
