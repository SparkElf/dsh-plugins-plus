import { clearQuote, registerQuote } from './api.ts'

/**
 * The message a reply is being written against, shared by the three surfaces that need it.
 *
 * Replying spans two parts of the UI that do not otherwise talk to each other: the button on a
 * message that starts a reply, and the composer that has to show what is being answered. A store
 * this plugin already owns is the smallest thing that lets them agree, and it keeps the pending
 * reply in one place instead of in three components' props.
 *
 * The value is per room, not global: a member can be writing a reply in one room and switch to
 * another, and carrying the quote across that switch would attach it to a message the reader
 * never picked.
 *
 * @module @sparkelf/dsh-group-chat/client/quote
 */

/**
 * The block type a reply uses to carry the message it answers.
 *
 * Declared in this shared module rather than beside the renderer that reads it: the same string
 * is written by the host when it publishes the reply, and a second literal there would let the
 * two drift into a quote nothing renders.
 */
export const QUOTE_BLOCK_TYPE = 'group-chat-quote'

/**
 * The parts of a message row this module reads.
 *
 * A minimal structural shape rather than the official message type: the renderer receives the
 * official `UserMessage` and this module only ever looks at these fields, so naming the larger
 * type would tie it to a package this plugin does not depend on.
 */
export interface MessageLike {
  readonly source?: {
    /** Producer of the message; `group-chat-quote` marks model-only context. */
    readonly kind?: unknown
    readonly roomId?: unknown
    readonly memberId?: unknown
    readonly authorKind?: unknown
    readonly memberName?: unknown
    /** The room's log row this message was stored as; what a reply points at. */
    readonly messageId?: unknown
  } | null
  readonly content?: unknown
  readonly id?: unknown
}

/**
 * The message a reply points at, as the reply carries it.
 *
 * The quote rides inside the message's own `content` as a block, not as a top-level field: the
 * event envelope is the official `UserMessage` and anything outside `content`/`source` is
 * dropped on the way to the surface. A block survives, and the backend's block type is open
 * (`AiChatContentBlock` is `{ type: string; ... }`), so an unknown type passes through instead
 * of failing validation.
 */
export interface QuotedMessage {
  /** The id of the message being answered. */
  readonly messageId: string
  /** That message's author, as their name read when the reply was written. */
  readonly authorName?: string
  /** The first line of what they said, already trimmed for display. */
  readonly preview: string
}

/** How much of the quoted message to keep. One line, like the composer shows. */
const QUOTE_PREVIEW_CHARS = 120

/**
 * Reads the quoted message out of a reply, if it has one.
 *
 * Returns `undefined` rather than a partial object: a quote with no preview has nothing to show,
 * and drawing an empty bar above the bubble would look like a rendering fault.
 *
 * @param message - the message data the node carries.
 * @returns the quote to draw, or `undefined` for an ordinary message.
 */
/**
 * The text of a message, joined from its text blocks.
 *
 * Only `text` blocks contribute: an image or a file has no words to quote, and including a
 * placeholder for it would put text in the reply that the author never wrote.
 *
 * @param message - the message data the node carries.
 * @returns the collapsed text, or `''` when the message has none.
 */
export const previewOf = (message: MessageLike | undefined): string => {
  const content = message?.content
  // A text-only message carries its body as a plain string, not as a block list: that is the
  // shape the official composer submits, and reading only arrays left every ordinary message
  // with an empty preview — which silently removed the reply control from all of them.
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const text = record['text']
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export const quoteOf = (message: MessageLike | undefined): QuotedMessage | undefined => {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] !== QUOTE_BLOCK_TYPE) continue
    const messageId = record['messageId']
    const preview = record['preview']
    if (typeof messageId !== 'string' || messageId.length === 0) return undefined
    if (typeof preview !== 'string') return undefined
    const authorName = typeof record['authorName'] === 'string' && record['authorName'].trim().length > 0
      ? record['authorName'].trim()
      : undefined
    return { messageId, ...authorName === undefined ? {} : { authorName }, preview }
  }
  return undefined
}

/**
 * Builds the block a reply carries.
 *
 * Whitespace collapses to single spaces and the result is cut to one line: the quote is a
 * pointer, and a bar showing a paragraph would push the actual reply off the screen.
 *
 * @param messageId - the message being answered.
 * @param preview - what it said, taken from its text blocks.
 * @param authorName - who said it, when known.
 * @returns the block to append to the reply's content.
 */
export const quoteBlock = (
  messageId: string,
  preview: string,
  authorName?: string,
): Record<string, unknown> => {
  const collapsed = preview.replace(/\s+/g, ' ').trim()
  const trimmed = collapsed.length > QUOTE_PREVIEW_CHARS
    ? `${collapsed.slice(0, QUOTE_PREVIEW_CHARS - 1)}…`
    : collapsed
  return {
    type: QUOTE_BLOCK_TYPE,
    messageId,
    preview: trimmed,
    ...authorName === undefined ? {} : { authorName },
  }
}


/** What a pending reply points at, resolved to what the composer bar has to draw. */
export interface PendingQuote {
  /** The room the quoted message belongs to. */
  readonly roomId: string
  /** The id of the message being answered, as the room's event log knows it. */
  readonly messageId: string
  /** The author's display name, as the roster gave it when the reply was started. */
  readonly authorName?: string
  /** One line of what they said, already collapsed and trimmed for display. */
  readonly preview: string
}

/** The read side the components subscribe to, and the write side they call. */
export interface QuoteStore {
  /** The pending quote for one room, retold on every change. */
  readonly getQuote: (roomId: string) => PendingQuote | undefined
  /** Notified whenever any room's pending quote changes. */
  readonly subscribe: (listener: () => void) => () => void
  /** Starts a reply in one room, replacing whatever was pending there. */
  readonly start: (quote: PendingQuote) => void
  /** Drops the pending reply for one room, after it was sent or dismissed. */
  readonly clear: (roomId: string) => void
  /**
   * Drops the pending reply on this side only, leaving the host's copy for it to consume.
   *
   * Used when the composer submits: the host attaches the quote to the message it is about to
   * publish and then forgets it. Telling the host to delete at that moment would erase the quote
   * before the message arrives, and the reply would go out bare.
   */
  readonly clearLocal: (roomId: string) => void
  /** Reads the current quote for a room without subscribing, for one-shot decisions. */
  readonly peek: (roomId: string) => PendingQuote | undefined
}

/**
 * Creates the store.
 *
 * A plain observable rather than a framework store, for the same reason the room list is one:
 * every consumer is a component this plugin already owns, so the subscription contract is just
 * `useSyncExternalStore`.
 *
 * @returns the store the client entry hands to the components that need it.
 */
export const createQuoteStore = (): QuoteStore => {
  const quotes = new Map<string, PendingQuote>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    getQuote: (roomId) => quotes.get(roomId),
    peek: (roomId) => quotes.get(roomId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: (quote) => {
      quotes.set(quote.roomId, quote)
      notify()
      // The host has to know too: it is the side that attaches the quote, because the message
      // itself is submitted by the official composer and never passes through this plugin.
      // Fire-and-forget — the bar is already on screen, and a failed registration only means the
      // sent message arrives without the quote.
      void registerQuote(quote.roomId, quote).catch(() => undefined)
    },
    clear: (roomId) => {
      const had = quotes.delete(roomId)
      notify()
      if (had) void clearQuote(roomId).catch(() => undefined)
    },
    clearLocal: (roomId) => {
      if (!quotes.delete(roomId)) return
      notify()
    },
  }
}
