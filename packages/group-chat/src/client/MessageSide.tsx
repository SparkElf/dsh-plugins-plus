/**
 * Left/right placement for group-chat messages.
 *
 * The official Chat renderer draws every user message right-aligned — its own CSS is
 * unconditional (`align-items: flex-end`), with no self/other distinction, because in an
 * ordinary Session the only author is the operator. A room has several authors, so the
 * side has to carry a meaning the official renderer does not compute: this workspace's own
 * messages stay right, everyone else's move left.
 *
 * It is implemented by **wrapping the official renderer, not replacing it**. The official
 * component is read back out of the slot registry and rendered as an element, so markdown,
 * images, file and skill references, per-message actions and the streaming behaviour all
 * stay the official implementation's. Re-drawing the bubble here would have to track every
 * one of those forever.
 *
 * An ordinary Session is untouched: a message with no room source is rendered through the
 * official component with no wrapper at all, which is what keeps the two paths equal in
 * what they draw.
 *
 * @module @sparkelf/dsh-group-chat/client/MessageSide
 */

import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import styles from './MessageSide.module.css'

/** Minimal shape of the message this decision reads. */
interface MessageLike {
  readonly source?: {
    readonly roomId?: unknown
    readonly memberId?: unknown
    readonly authorKind?: unknown
  } | null
}

/**
 * Which side a message belongs on, or `undefined` when it is not a room message.
 *
 * `roomId` is the discriminator: the Host stamps it on every message it admits to a room,
 * and an ordinary Session's message carries `{kind, rpcId, clientTimeZone}` instead. The
 * remaining cases split the room's own authors — an agent is always someone else, and a
 * human is "self" only when the id matches this workspace's account. A message whose
 * author cannot be identified is placed left, because assuming "self" would silently
 * attribute another member's words to the operator.
 *
 * @param message - the message data the node carries.
 * @param selfId - this workspace's own account id, when known.
 * @returns `'self'`, `'other'`, or `undefined` for a non-room message.
 */
export const messageSide = (message: MessageLike | undefined, selfId: string | undefined): 'self' | 'other' | undefined => {
  const source = message?.source
  if (source === undefined || source === null) return undefined
  if (typeof source.roomId !== 'string' || source.roomId.length === 0) return undefined
  if (source.authorKind === 'agent') return 'other'
  return selfId !== undefined && source.memberId === selfId ? 'self' : 'other'
}

/** The official node view, as the registry hands it over. */
type OfficialView = (props: Record<string, unknown>) => ReactNode

/** Props this wrapper adds to whatever the official node view receives. */
export interface MessageSideProps {
  readonly node?: { readonly data?: unknown }
  /** The official node view, read from the slot registry. */
  readonly Official: unknown
  /** This workspace's own account id, when known — read as a snapshot. */
  readonly getSelfId: () => string | undefined
  /** Notified when the account id arrives, so the side is re-decided. */
  readonly subscribeSelf: (listener: () => void) => () => void
  /** Whether this occurrence is the keyed `user` cell, which is the only one that has sides. */
  readonly sided: boolean
}

/**
 * Render one node with its room side applied.
 *
 * Two details this has to get right, both of which fail silently otherwise:
 *
 * The official view is created as a React **element**, never called as a plain function. It
 * is a `React.memo` component, which compiles to a non-callable object, so calling it throws
 * `TypeError: … is not a function`; and even when a view is callable, calling it directly
 * would run its Hooks as this component's and drop its memoization.
 *
 * The account id is read through `useSyncExternalStore` rather than captured. It is fetched
 * after the first paint, and a value captured when this renderer was registered would stay
 * `undefined` for the life of the page — every message would keep the unknown-author
 * placement, and nothing would ever correct it. The store is the same observable the room
 * list uses, and the snapshot is a plain string, so an unrelated room-list change notifies
 * without re-rendering: React compares the snapshot by identity.
 *
 * @param props - the official props plus this wrapper's placement inputs.
 * @returns the official view, wrapped only when the message is another author's room message.
 */
export const MessageSide = (props: MessageSideProps): ReactNode => {
  const { node, Official, getSelfId, subscribeSelf, sided } = props
  const selfId = useSyncExternalStore(subscribeSelf, getSelfId, getSelfId)
  if (typeof Official !== 'function' && typeof Official !== 'object') return null
  // The official props ride through unchanged apart from this plugin's own additions, which a
  // React component ignores. `t` in particular must survive: the seat supplies it from the
  // namespace this plugin's registration declares.
  const view = createElement(Official as OfficialView, props as unknown as Record<string, unknown>)
  const side = sided ? messageSide(node?.data as MessageLike | undefined, selfId) : undefined
  // `self` and every non-room message render the official view bare: the official CSS is
  // already right-aligned, so wrapping on the self side would only risk changing spacing.
  if (side !== 'other') return view
  // The wrapper carries the decision and nothing else: `display: contents` (see the module's
  // CSS) keeps the official row a direct child of the flow item, so the bubble is not resized
  // by an extra box, and the alignment flip is applied to that row by the same stylesheet.
  return (
    <div className={styles['otherRow']} data-group-chat-side="other">
      {view}
    </div>
  )
}
