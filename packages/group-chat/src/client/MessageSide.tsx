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
 * Another author's message also carries their name and picture above the bubble. The official
 * renderer draws neither — in an ordinary Session every message is the operator's own, so there
 * is no author to attribute — and the event itself carries only the author's id. The name and
 * picture therefore come from the roster, looked up by that id. When the roster has not loaded,
 * or the author has since left, the message renders bare rather than labelled with an id: a
 * wrong name is worse than no name.
 *
 * @module @sparkelf/dsh-group-chat/client/MessageSide
 */

import { createElement, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { Avatar } from './Avatar.tsx'
import type { RoomMember } from './api.ts'
import { previewOf, quoteOf, type MessageLike, type QuotedMessage, type QuoteStore } from './quote.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './MessageSide.module.css'


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

/**
 * The roster entry for one message's author, when the room knows it.
 *
 * The bubble needs the name and the picture, and neither is on the event: a message carries only
 * `source.memberId`. The roster is the only place those two facts live, so this is the lookup
 * that lets another author's message say who wrote it.
 *
 * @param message - the message data the node carries.
 * @param roster - that room's members, or `undefined` before the roster has been read.
 * @returns the matching member, or `undefined` when the author is unknown or has left.
 */
export const authorOf = (
  message: MessageLike | undefined,
  roster: readonly RoomMember[] | undefined,
): RoomMember | undefined => {
  const memberId = message?.source?.memberId
  if (typeof memberId !== 'string' || memberId.length === 0) return undefined
  return roster?.find((member) => member.userId === memberId)
}

/**
 * The name to draw above another author's message.
 *
 * Falls back to the roster's display name only, never to the id: an unlabelled bubble is
 * readable, but a bubble labelled `u_7f3a91` is not, and it would also leak an internal id into
 * the conversation.
 *
 * @param member - the author's roster entry.
 * @returns the name, or `undefined` when the roster has no usable one.
 */
export const authorNameOf = (member: RoomMember | undefined): string | undefined => {
  const name = member?.displayName?.trim() ?? ''
  return name.length === 0 ? undefined : name
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
  /**
   * Read one room's roster as a snapshot, or `undefined` before it has been read.
   *
   * A function rather than the array itself, for the same reason [getSelfId] is: the roster is
   * read after the first paint, so a value captured when this renderer was registered would stay
   * `undefined` and every bubble would render unlabelled forever.
   */
  readonly getRoster: (roomId: string) => readonly RoomMember[] | undefined
  /**
   * Where a reply started on this message is recorded.
   *
   * The message is the only place that knows which row the reader pointed at, so the button has
   * to live here rather than on the composer: a composer-side control would have to ask "which
   * message?" and answer it from a hover that the composer never sees.
   */
  readonly quotes?: QuoteStore
  /**
   * Copy resolver for this plugin's own strings.
   *
   * Kept separate from the `t` the seat supplies: that one is bound to the official `chat`
   * namespace, because the official bubble looks its own copy up there and would print raw keys
   * if this plugin replaced it. Our keys live in this plugin's namespace, so they arrive under
   * their own name.
   */
  readonly tOwn?: (key: GroupChatKey) => string
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
/**
 * The bar above a bubble showing which message it answers.
 *
 * Drawn by this plugin rather than by the official view: the quote travels as a content block
 * whose type the official renderer does not know, so it would otherwise be dropped. The bar sits
 * outside the bubble so the reply's own text keeps the official layout.
 *
 * @param props - the quote to show.
 * @returns the bar, or `null` when there is nothing worth quoting.
 */
export const QuoteBar = ({ quote }: { readonly quote: QuotedMessage }): ReactNode => {
  if (quote.preview.length === 0) return null
  return (
    <div className={styles['quoteBar']} data-group-chat-quote={quote.messageId}>
      <span className={styles['quoteMark']} aria-hidden="true" />
      <span className={styles['quoteBody']}>
        {quote.authorName === undefined ? null : (
          <span className={styles['quoteAuthor']}>{quote.authorName}</span>
        )}
        <span className={styles['quoteText']}>{quote.preview}</span>
      </span>
    </div>
  )
}

/**
 * The control that starts a reply to one message.
 *
 * Rendered inside the wrapper this plugin already draws around another author's row, which is
 * the only place the message id is known. It reads its own hover state so the button appears
 * over the row it belongs to and nowhere else.
 *
 * @param props - the message it replies to, and the store the pick lands in.
 * @returns the button, or `null` when the message cannot be replied to.
 */
/** Source kind of the model-only quoted-message context; it must never be drawn as a message. */
const QUOTE_CONTEXT_KIND = 'group-chat-quote'

const ReplyControl = (props: {
  readonly roomId: string
  readonly messageId: string
  readonly authorName?: string
  readonly preview: string
  readonly quotes: QuoteStore
  readonly t: (key: GroupChatKey) => string
}): ReactNode => {
  const { roomId, messageId, authorName, preview, quotes, t } = props
  if (preview.length === 0) return null
  return (
    <button
      type="button"
      className={styles['replyButton']}
      data-group-chat-reply=""
      aria-label={t('reply')}
      title={t('reply')}
      onClick={() => {
        quotes.start({ roomId, messageId, preview, ...authorName === undefined ? {} : { authorName } })
      }}
    >
      {/* Inline rather than an icon from the primitives package: importing that package pulls its
          CSS into every module that renders a bubble, and the plain-function tests import this
          module without a bundler. The shape is a corner-turning arrow, the usual "answers that
          message" mark. */}
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 4 2.5 7.5 6 11" />
        <path d="M2.5 7.5h7A3.5 3.5 0 0 1 13 11v1.5" />
      </svg>
    </button>
  )
}

export const MessageSide = (props: MessageSideProps): ReactNode => {
  const { node, Official, getSelfId, subscribeSelf, sided, getRoster, quotes } = props
  // One subscription drives both lookups: identity and roster arrive from separate requests, so
  // subscribing twice would re-render on the same change and could draw the author before the
  // name is known.
  const selfId = useSyncExternalStore(subscribeSelf, getSelfId, getSelfId)
  if (typeof Official !== 'function' && typeof Official !== 'object') return null
  // The official props ride through unchanged apart from this plugin's own additions, which a
  // React component ignores. `t` in particular must survive: the seat supplies it from the
  // namespace this plugin's registration declares.
  const view = createElement(Official as OfficialView, props as unknown as Record<string, unknown>)
  const message = node?.data as MessageLike | undefined
  // The quoted-message context the host injects before a model step is background for the
  // model, not part of the conversation. It carries its own source kind so it is recognizable
  // here; drawing it would put an untrusted-background snapshot in the room under the member's
  // name, and the message it belongs to already shows the quote as a pointer.
  if (message?.source?.kind === QUOTE_CONTEXT_KIND) return null
  const side = sided ? messageSide(message, selfId) : undefined
  const quote = quoteOf(message)
  const roomId = message?.source?.roomId
  const roomKnown = typeof roomId === 'string' && roomId.length > 0
  // The id the room's log knows this message by. `source.messageId` is that row; `id` is the
  // message's own uuid. A reply and a search jump both point at the row — it is what the room
  // stores and what a reply carries — so it is resolved once here, before any branch uses it.
  const sourceMessageId = message?.source?.messageId
  const rawId = message?.id
  const messageId = typeof sourceMessageId === 'string' && sourceMessageId.length > 0
    ? sourceMessageId
    : typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined
  // A message outside a room has no roster to attribute it from and no room to reply into, so it
  // stays exactly as the official renderer drew it. A quote can still be present on a message
  // whose room id went missing; the bar is shown rather than dropped, because losing it would
  // make a reply look like it answered nothing.
  if (side === undefined || !roomKnown) {
    if (quote === undefined) return view
    return (
      <div
        className={styles['selfRow']}
        data-group-chat-side="self"
        {...messageId === undefined ? {} : { 'data-group-chat-message': messageId }}
      >
        <QuoteBar quote={quote} />
        {view}
      </div>
    )
  }

  const member = authorOf(message, getRoster(roomId))
  const name = authorNameOf(member)
  // The avatar and the name are drawn only when the room knows this author. An unknown author
  // still moves left — the side is decided from a fact the message carries — but is left
  // unlabelled rather than attributed to a guessed name or an internal id.
  const head = name === undefined || member === undefined
    ? null
    : (
        <div className={styles['author']} data-group-chat-author={member.userId}>
          <Avatar name={name} src={member.avatarUrl} size="sm" />
          <span className={styles['authorName']}>{name}</span>
        </div>
      )

  // The host prefixes what it publishes with the speaker's name so the model can tell who is
  // talking. That prefix is part of the stored text, so a quote taken from it would read
  // "DataOps Admin：DataOps Admin：…" once the bar draws the name itself.
  const rawPreview = previewOf(message)
  const preview = name === undefined
    ? rawPreview
    : rawPreview.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`), '')
  // Both halves are required: an id with no text has nothing to quote, and a message with no id
  // cannot be pointed at. Offering the control in either case would store a quote nobody can
  // resolve.
  const replying = quotes !== undefined && messageId !== undefined && preview.length > 0

  const actions = replying ? (
    <div className={side === 'self' ? styles['rowActionsSelf'] : styles['rowActions']}>
      <ReplyControl
        roomId={roomId}
        messageId={messageId}
        {...name === undefined ? {} : { authorName: name }}
        preview={preview}
        quotes={quotes}
        t={props.tOwn ?? ((key) => key)}
      />
    </div>
  ) : null

  // A message I wrote keeps the official right alignment; the reply control sits on its left,
  // where the bubble has room and where the pointer arrives from.
  if (side === 'self') {
    return (
      <div
        className={styles['selfRow']}
        data-group-chat-side="self"
        {...messageId === undefined ? {} : { 'data-group-chat-message': messageId }}
      >
        {quote === undefined ? null : <QuoteBar quote={quote} />}
        <div className={styles['selfBody']}>
          {view}
          {actions}
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles['otherRow']}
      data-group-chat-side="other"
      {...messageId === undefined ? {} : { 'data-group-chat-message': messageId }}
    >
      {head}
      {quote === undefined ? null : <QuoteBar quote={quote} />}
      <div className={styles['rowBody']}>
        {view}
        {actions}
      </div>
    </div>
  )
}
