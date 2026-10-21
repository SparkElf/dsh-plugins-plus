/**
 * The two composer-side pieces of a reply: the button that starts one and the bar that shows
 * the message being answered.
 *
 * Both are seats on official composers, and both are deliberately dumb: they read a pending
 * quote from the store and call back into it. Nothing here sends a message — the quote reaches
 * the room because `MessageSide` attaches it when the reply is submitted, and keeping that
 * decision in one place is why these two do not also try to.
 *
 * @module @sparkelf/dsh-group-chat/client/QuoteComposer
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { IconShareOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GroupChatKey } from './locales.ts'
import type { QuoteStore } from './quote.ts'
import type { RoomStore } from './store.ts'
import styles from './QuoteComposer.module.css'

/** The message a reply would point at, once the reader has picked one. */
export interface ReplyTarget {
  /** The id the room's event log knows this message by. */
  readonly messageId: string
  /** One line of what it said. */
  readonly preview: string
  /** Who said it, when the roster knows them. */
  readonly authorName?: string
}

/** Props the reply button seat receives. */
export interface ReplyButtonProps {
  readonly t: (key: GroupChatKey) => string
  /** The room this composer is writing into, or `undefined` outside a room. */
  readonly roomId: string | undefined
  readonly quotes: QuoteStore
  /** The message the reader picked, or `undefined` while they have not picked one. */
  readonly target: ReplyTarget | undefined
}

/**
 * The button that begins a reply.
 *
 * The share glyph, which is what this plugin's icon set offers for "point at another message";
 * there is no reply or quote icon, and a hand-rolled SVG would be the only one in the region.
 *
 * Rendered only inside a room with a message under the cursor, because a reply needs a target.
 */
export const ReplyButton = (props: ReplyButtonProps): ReactNode => {
  const { t, roomId, quotes, target } = props
  if (roomId === undefined || target === undefined) return null
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={t('reply')}
      title={t('reply')}
      onClick={() => {
        quotes.start({ roomId, ...target })
      }}
    >
      <IconShareOutlineRegular size={14} />
    </button>
  )
}

/** Props the quote bar seat receives. */
export interface QuoteBarProps {
  readonly t: (key: GroupChatKey) => string
  readonly quotes: QuoteStore
  /**
   * The room list store, read only for `activeRoomId`.
   *
   * The composer's seat hands over a session id, but it is not the room session's: the seat the
   * composer renders for is an ordinary `session-*`, so deriving the room from it never resolves.
   * The store already tracks which room the main panel has open, which is the same room the
   * composer is writing into.
   */
  readonly store: RoomStore
}

/**
 * The bar above the composer showing what the reply answers.
 *
 * Sits in the composer's own stack rather than over the input, so the text the reader types is
 * never covered by it. Absent when nothing is being answered, which is the common case.
 */
export const PendingQuoteBar = (props: QuoteBarProps): ReactNode => {
  const { t, quotes, store } = props
  const roomId = useSyncExternalStore(store.subscribe, () => store.getState().activeRoomId, () => store.getState().activeRoomId)
  const read = (): ReturnType<QuoteStore['getQuote']> => roomId === undefined ? undefined : quotes.getQuote(roomId)
  const quote = useSyncExternalStore(quotes.subscribe, read, read)
  if (roomId === undefined || quote === undefined) return null
  return (
    <div className={styles.bar} data-group-chat-pending-quote={quote.messageId}>
      <span className={styles.mark} aria-hidden="true" />
      <span className={styles.body}>
        {quote.authorName === undefined ? null : (
          <span className={styles.author}>{quote.authorName}</span>
        )}
        <span className={styles.text}>{quote.preview}</span>
      </span>
      <button
        type="button"
        className={styles.dismiss}
        aria-label={t('replyCancel')}
        title={t('replyCancel')}
        onClick={() => { quotes.clear(roomId) }}
      >
        ×
      </button>
    </div>
  )
}
