/**
 * The room list both client surfaces read.
 *
 * It lives here rather than inside either component because the sidebar region and the
 * room page must never show different lists. It is a plain observable, not a framework
 * store: both consumers are components this plugin already owns.
 *
 * The slot caches the value its `inject` factory returns, so a snapshot taken at inject
 * time would freeze at the first read. Consumers therefore subscribe through
 * `useSyncExternalStore` and re-read on every change.
 *
 * @module @sparkelf/dsh-group-chat/client/store
 */

import { leaveRoom, listRooms, readSelf, updateRoom, type RoomSummary } from './api.ts'
import type { GroupChatKey } from './locales.ts'

/** The three distinguishable failures the surfaces render as copy. */
export type RoomFailure = GroupChatKey | undefined

export interface RoomState {
  /** `undefined` until the first read completes, so the UI can tell loading from empty. */
  readonly rooms: readonly RoomSummary[] | undefined
  /** The room the main panel is showing, if any. */
  readonly activeRoomId: string | undefined
  readonly failure: RoomFailure
  /**
   * The sidebar's search box contents.
   *
   * Held here rather than in the region because the header collapses while a query is
   * present, and the region must survive that collapse with its text intact.
   */
  readonly searchQuery: string
  /**
   * This workspace's own account id, once the Host reports it.
   *
   * Held in the store because the message renderer needs it while rendering, and that
   * renderer is not a component that can wait on an effect: it decides a message's side
   * during the render in which the message appears. Undefined until the first read
   * completes, and the renderer treats "unknown" as "not mine" rather than guessing.
   */
  readonly selfId: string | undefined
  /**
   * Whether the create-room dialog is open.
   *
   * The sidebar's + button sets it and the page half renders the dialog: the sidebar seat
   * is a thin band, and a modal belongs to the surface that owns the window.
   */
  readonly pendingCreate: boolean
  /** The room dialog the row menu opened, if any. Rendered by the page half. */
  readonly dialog: RoomDialog | undefined
}

/**
 * A room dialog opened from a row's context menu.
 *
 * The menu lives in the sidebar and the dialogs live on the page, so the request travels
 * through the store rather than through component nesting.
 */
export type RoomDialog =
  | { readonly kind: 'invite'; readonly roomId: string }
  | { readonly kind: 'settings'; readonly roomId: string }
  | { readonly kind: 'members'; readonly roomId: string }

export interface RoomStore {
  getState: () => RoomState
  subscribe: (listener: () => void) => () => void
  /** Re-read the room list from the Host route. */
  refresh: () => Promise<void>
  /** Select a room; the main panel follows this. */
  open: (roomId: string) => void
  /** This workspace's own account id, or `undefined` while it is still unknown. */
  selfId: () => string | undefined
  setFailure: (failure: RoomFailure) => void
  setSearch: (query: string) => void
  /** Apply one policy to an existing room, then re-read so both surfaces agree. */
  setPolicy: (
    roomId: string,
    patch: { invitePolicy?: string; discoverability?: string; agentTrigger?: string },
  ) => Promise<void>
  /** Open the create-room dialog. */
  openCreate: () => void
  closeCreate: () => void
  /** Open one room dialog; `undefined` closes whatever is open. */
  setDialog: (dialog: RoomDialog | undefined) => void
  /** Rename a room, then re-read so both surfaces show the new name. */
  rename: (roomId: string, name: string) => Promise<void>
  /** Leave a room. */
  leave: (roomId: string) => Promise<void>
}

/**
 * Create the shared store.
 * @returns a store whose `getState` returns a stable reference between changes, which is
 *   what `useSyncExternalStore` requires to avoid a render loop.
 */
export function createRoomStore(): RoomStore {
  let state: RoomState = {
    rooms: undefined,
    activeRoomId: undefined,
    failure: undefined,
    searchQuery: '',
    selfId: undefined,
    pendingCreate: false,
    dialog: undefined,
  }
  const listeners = new Set<() => void>()

  const set = (patch: Partial<RoomState>): void => {
    // A fresh object per change, so `getState` is referentially stable between changes.
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => {
      // Resolved alongside the room list rather than in its own pass: identity is what the
      // message renderer needs, and a list that arrived while identity was still unknown
      // would draw the operator's own first messages on the wrong side.
      void readSelf().then((id) => { if (id !== undefined) set({ selfId: id }) })
      try {
        set({ rooms: await listRooms(), failure: undefined })
      } catch (error) {
        // The sidebar may load before the server is reachable; the page shows the
        // reason, and the next refresh clears it.
        set({ failure: failureOf(error) })
      }
    },
    open: (roomId) => set({ activeRoomId: roomId }),
    selfId: () => state.selfId,
    setFailure: (failure) => set({ failure }),
    setSearch: (searchQuery) => set({ searchQuery }),
    setPolicy: async (roomId, patch) => {
      await updateRoom(roomId, patch)
      set({ rooms: await listRooms() })
    },
    openCreate: () => set({ pendingCreate: true }),
    closeCreate: () => set({ pendingCreate: false }),
    setDialog: (dialog) => set({ dialog }),
    rename: async (roomId, name) => {
      await updateRoom(roomId, { name })
      set({ rooms: await listRooms() })
    },
    leave: async (roomId) => {
      await leaveRoom(roomId)
      // The room stays listed under the "show left rooms" filter, so the selection is
      // cleared by refreshing rather than by forgetting the room.
      set({ rooms: await listRooms(), activeRoomId: undefined })
    },
  }
}

/** Map a transport failure onto the copy key the surfaces render. */
export const failureOf = (error: unknown): GroupChatKey => {
  const message = error instanceof Error ? error.message : ''
  if (message === 'credentialMissing') return 'credentialMissing'
  if (message === 'credentialRejected') return 'credentialRejected'
  if (message === 'notConfigured') return 'notConfigured'
  return 'unreachable'
}
