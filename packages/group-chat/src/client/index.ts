/**
 * Group-chat Client plugin.
 *
 * Registers two official DSH surfaces:
 * - `sidebar.footer.action` renders the group-chat region at the sidebar foot, under the
 *   workspace list and above Settings. The shell positions it inside `footerActions`
 *   (full width, `flex: none`); this plugin draws the section header and the flat room
 *   list. It is an ordinary list seat, so no other plugin's contribution is disturbed.
 * - The matching `main` key gives the room page the region's rows select, so a room opens
 *   in the main column rather than replacing the navigation column.
 *
 * This half owns the room list so the two surfaces cannot disagree about which rooms
 * exist. Both read the one store below and both re-read through the same action.
 *
 * The page is a pure consumer of the Host plugin's `/dsh-group-chat/api` route, so every
 * room operation it performs is the same call the agent's own turn makes. The browser
 * never talks to DataOps directly and never handles a credential: the Host holds the
 * workspace identity, and this half only renders what that identity can already see.
 *
 * @module @sparkelf/dsh-group-chat/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// The slot this plugin shadows needs a local declaration; see the module doc comment.
import './contract.ts'
import { SidebarRooms, type SidebarRoomsInjected } from './SidebarRooms.tsx'
import { MessageSide } from './MessageSide.tsx'
import { createRoomStore, type RoomStore } from './store.ts'
import { roomSessionId } from '../session-id.ts'
import { en, zh, type GroupChatKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.groupChat': GroupChatKey
  }
}

const NS = 'settings.groupChat'

/**
 * The `user` cell this plugin shadows, and the one the official Chat renderer occupies.
 *
 * Named rather than inlined because shadowing is a two-sided fact: winning the cell means
 * reading past the winner to find what would have rendered.
 */
const CHAT_NODE_SLOT = 'conversation.chat.node'

/**
 * Every `user`-shaped cell of the chat-node seat.
 *
 * `user` and `steering` are separate cells that render the *same* official component: a room
 * message is `steering` once a turn has claimed it and `user` otherwise, so shadowing only
 * `user` would leave exactly the messages that arrived while the agent was working on the
 * right. Both are cell-local shadows, so neither reaches an ordinary Session: the side is
 * decided from the message's own room source, and an ordinary message has none.
 */
const CHAT_NODE_KEYS = ['user', 'steering'] as const

/** Priority this plugin claims its chat-node cells at; the official entries sit at `0`. */
const SHADOW_PRIORITY = -1

/**
 * This plugin's own chat-node renderer, so the lookup below cannot mistake it for the
 * official one. Compared by identity against the registered component.
 */
const OUR_VIEW = MessageSide

/**
 * The entry the shell would render for one cell without this plugin.
 *
 * The registry projects shadowing winners through `entriesOfSlot`, which is exactly the
 * wrong question here — this plugin is the winner. `entries` keeps the whole ledger, so the
 * official entry is still visible, and picking the lowest-priority live one other than this
 * plugin's own reproduces the pre-plugin choice.
 *
 * @param ledger - every registered entry for the chat-node slot.
 * @param key - the cell being claimed.
 * @param ours - this plugin's own component, excluded from the candidates.
 * @returns the official component, or `undefined` when nothing else is registered.
 */
const officialViewFor = (
  ledger: readonly StoredEntry[],
  key: string,
  ours: unknown,
): StoredEntry['component'] | undefined =>
  ledger
    .filter((entry) => entry.options.key === key && entry.component !== ours)
    .reduce<StoredEntry | undefined>(
      (lowest, entry) =>
        lowest === undefined || (entry.options.priority ?? 0) < (lowest.options.priority ?? 0)
          ? entry
          : lowest,
      undefined,
    )?.component

/**
 * Report why one chat-node cell could not be claimed.
 *
 * A rejected claim is not fatal — the official renderer still draws that cell — but it does
 * mean the side never flips, which is invisible in the UI. The console is the only channel
 * this half has, and the message has to name the cell so the missing side can be traced to it.
 */
const logClaimFailure = (key: string, error: unknown): void => {
  console.warn(`[group-chat] could not claim the "${key}" chat-node cell; messages of this kind stay on the official side`, error)
}

/** Main-panel key the sidebar rows select. */
const PANEL_ID = 'group-chat' as MainPanelId

/** Client services required for these contributions. */
/**
 * The Workspace navigation service, declared structurally.
 *
 * `@deepseek-ai/dsh-client-ui-workspace` is not a dependency of this package and declaring it as
 * one would tie the plugin to the plugin that happens to own the service today. Only the one
 * method used here is named, which is also what keeps this honest: the room opens the way a
 * session row opens, and nothing else about that plugin is assumed.
 */
interface WorkspaceNavigation {
  /**
   * Select a Session and show its Conversation.
   * @param sessionId - the room's Session, which `roomSessionId` derives from the room.
   */
  openSession(sessionId: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace navigation, contributed by the workspace picker plugin. */
    readonly uiWorkspace: WorkspaceNavigation
  }
}

export const inject = ['slots', 'locale', 'uiWorkspace']

/**
 * Register the sidebar region and the room page.
 * @param ctx - DSH client context with locale and slot registries.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'group-chat: copy')
  const t = ctx.locale.bind(NS) as (key: GroupChatKey) => string

  // One store shared by both surfaces, created here because the sidebar must show the
  // same list the page is operating on.
  const base = createRoomStore()
  // The one action that means "show me this room" is opening its Session, so every caller —
  // the row today, a keyboard shortcut or a deep link later — goes through it and no caller has
  // to remember a second step.
  const store: RoomStore = {
    ...base,
    open: (roomId) => {
      base.open(roomId)
      ctx.uiWorkspace.openSession(roomSessionId(roomId))
    },
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 20,
    inject: (): SidebarRoomsInjected => ({ t, store }),
  }, SidebarRooms))

  // A room is a Session. Its messages are ordinary `user/message` events on that Session's log,
  // so the shell's own Conversation already renders them — bubbles, markdown, tool calls,
  // streaming, scrollback. Opening the room is therefore one navigation action, not a panel to
  // draw: `openSession` is the same call the workspace list makes for its own rows.
  //
  // Anything the plugin drew here instead would be a second renderer that has to keep pace with
  // the first, and would silently drop every feature the Conversation gains.
  //
  // One thing the official renderer cannot know is which side a message belongs on: in an
  // ordinary Session the only author is the operator, so its user row is unconditionally
  // right-aligned. A room has several authors. Shadowing the `user`-shaped cells at a
  // negative priority is how those cells are reached — the renderer picks the lowest live
  // entry, and the official one sits at `0`. The shadowing entries render the official
  // component read back out of this same registry, so the bubble itself is not
  // reimplemented; only its placement is decided here.
  //
  // This waits for the official entries rather than reading the ledger once. `slots.inject`
  // re-runs on a *declaration* change, and the Chat node slot is declared by the shell's
  // root before any of its renderers register — so at this point the ledger can hold a
  // different cell's entry and nothing else. Reading it once would find no official `user`
  // view, and registering nothing is invisible: the cells would simply keep their official
  // alignment, with no error anywhere to say why. Subscribing to the slot is what makes the
  // claim happen whenever the official renderers actually arrive.
  ctx.slots.inject('conversation.chat.node', () => {
    let claims: (() => void)[] = []
    const release = (): void => {
      for (const dispose of claims) dispose()
      claims = []
    }
    const reconcile = (): void => {
      const ledger = ctx.slots.entries('conversation.chat.node')
      // Cells already claimed are left alone: re-registering at the same priority throws, and
      // the throw would take the whole contribution down. Occupancy is read from key and
      // priority rather than from component identity, because the client bundle can be
      // evaluated more than once in a page (a reload, or the HMR receiver re-running the
      // factory): each evaluation gets its own `OUR_VIEW` object, so an identity check misses
      // the previous evaluation's entry and the re-registration throws. `SHADOW_PRIORITY` is
      // ours alone — the official entries sit at the default `0` — so a `-1` occupant of this
      // cell is always a previous evaluation of this plugin, never something to displace.
      const claimed = new Set(
        ledger
          .filter((entry) => (entry.options.priority ?? 0) === SHADOW_PRIORITY)
          .map((entry) => entry.options.key),
      )
      for (const key of CHAT_NODE_KEYS) {
        if (claimed.has(key)) continue
        const official = officialViewFor(ledger, key, OUR_VIEW)
        // Without the official view there is nothing to place: registering a wrapper that
        // renders nothing would blank every message of that cell in every Session, which is
        // far worse than leaving the bubble on its official (right) side. The subscription is
        // what gives this another chance once the renderer does arrive.
        if (official === undefined) continue
        // Wrapped because a lost race must not take the plugin down with it. The guard above
        // covers the ordinary case, but the slot core can also reject a registration this
        // plugin cannot observe first (another evaluation mid-flight). Throwing here would
        // abort the whole `inject` callback — losing the room list's own renderer wiring — so a
        // rejected claim is skipped, leaving that cell with the official placement.
        let dispose: (() => void) | undefined
        try {
          dispose = ctx.slots.register({
          name: 'conversation.chat.node',
          key,
          priority: SHADOW_PRIORITY,
          // Required, not cosmetic: the seat synthesizes the `t` prop from the *registering*
          // entry's namespace, so this entry must name the official Chat namespace. Declaring
          // our own here would leave the official bubble's copy looking up keys that namespace
          // does not hold. `chat` is already registered by the shell, so naming it adds no
          // dictionary and cannot collide with the shell's own registration.
          locale: 'chat',
        }, (props: Record<string, unknown>) =>
          MessageSide({
            ...props,
            Official: official,
            // Read as a snapshot rather than captured: identity arrives after the first paint,
            // and a value captured when this renderer was registered would stay `undefined` for
            // the life of the page, leaving every message on the unknown-author side forever.
            getSelfId: store.selfId,
            subscribeSelf: store.subscribe,
            sided: props['node'] !== undefined,
          }))
        } catch (error) {
          logClaimFailure(key, error)
        }
        if (dispose !== undefined) claims.push(dispose)
      }
    }
    // Registration mutates the ledger, so the notification that a claim triggers would
    // re-enter this. `reconcile` is idempotent through the `claimed` set, which makes the
    // re-entry a no-op rather than a loop.
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', reconcile)
    reconcile()
    return () => { unsubscribe(); release() }
  })

  void PANEL_ID
}
