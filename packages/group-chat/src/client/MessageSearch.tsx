/**
 * The message search box and its result list.
 *
 * A separate surface from the room filter above it: that one narrows the list of rooms by name,
 * this one finds text inside them. Combining the two would mean one box whose meaning changes
 * with what it matched, which is the sort of ambiguity that makes a search feel broken.
 *
 * The panel is a list seat in the sidebar footer, below the room rows: results are transient and
 * belong to the moment the reader is looking for something, not beside the rooms they live in.
 *
 * @module @sparkelf/dsh-group-chat/client/MessageSearch
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { searchMessages, type MessageHit } from './api.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './MessageSearch.module.css'

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250

export interface MessageSearchProps {
  readonly t: (key: GroupChatKey) => string
  /** Opens a room and, when the room knows how, scrolls to the matched message. */
  readonly onOpen: (roomId: string, eventId: string) => void
}

/**
 * Renders the search field and, once something was typed, the hits.
 *
 * Results are debounced and the newest request wins: typing quickly issues several searches, and
 * an early one resolving late would replace the results of a later, more specific query.
 */
/**
 * The hit text with the matched words marked.
 *
 * Splitting on the query rather than rendering the raw string gives the reader the one thing a
 * result list has to offer: where in a long message the words actually are. Case is preserved
 * from the source text; only the comparison is case-insensitive.
 */
const highlighted = (text: string, query: string): ReactNode => {
  const needle = query.trim()
  if (needle.length === 0) return text
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  const target = needle.toLowerCase()
  let from = 0
  let at = lower.indexOf(target)
  let key = 0
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={key} className={styles['mark']}>{text.slice(at, at + needle.length)}</mark>)
    key += 1
    from = at + needle.length
    at = lower.indexOf(target, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

export const MessageSearch = (props: MessageSearchProps): ReactNode => {
  const { t, onOpen } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly MessageHit[]>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  /** Increments per issued search, so a stale response can be recognized and dropped. */
  const issued = useRef(0)

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setHits([])
      setBusy(false)
      return
    }
    const ticket = issued.current + 1
    issued.current = ticket
    setBusy(true)
    const timer = setTimeout(() => {
      void searchMessages(trimmed)
        .then((found) => { if (issued.current === ticket) setHits(found) })
        .catch(() => { if (issued.current === ticket) setHits([]) })
        .finally(() => { if (issued.current === ticket) setBusy(false) })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [query, open])

  // Escape closes the panel and clears what was typed, the same way the room filter behaves.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setQuery('')
      setHits([])
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className={styles['root']} data-group-chat-message-search="">
      <div className={styles['bar']}>
        <button
          type="button"
          className={styles['toggle']}
          aria-label={t('searchMessages')}
          aria-expanded={open}
          title={t('searchMessages')}
          onClick={() => {
            setOpen((was) => {
              const next = !was
              if (next) requestAnimationFrame(() => { input.current?.focus() })
              else { setQuery(''); setHits([]) }
              return next
            })
          }}
        >
          {/* A magnifier over a small card: the room filter's own magnifier is already in use
              above, and repeating it would suggest both boxes do the same thing. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="m10.2 10.2 3 3" />
            <path d="M4.2 5.4h5.6" />
            <path d="M4.2 7.4h4" />
          </svg>
        </button>
        {open ? (
          <input
            ref={input}
            className={styles['input']}
            type="search"
            value={query}
            placeholder={t('searchMessagesPlaceholder')}
            aria-label={t('searchMessages')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        ) : null}
      </div>
      {open && query.trim().length > 0 ? (
        <div className={styles['results']} role="listbox" aria-label={t('searchMessages')}>
          {busy && hits.length === 0 ? (
            <p className={styles['hint']}>{t('searching')}</p>
          ) : hits.length === 0 ? (
            <p className={styles['hint']}>{t('searchMessagesEmpty')}</p>
          ) : (
            hits.map((hit) => (
              <button
                key={`${hit.roomId}:${hit.eventId}`}
                type="button"
                role="option"
                aria-selected={false}
                className={styles['hit']}
                onClick={() => {
                  onOpen(hit.roomId, hit.eventId)
                  // Collapse after opening: the panel covers the room list, and the reader asked
                  // to go somewhere, not to keep searching.
                  setQuery('')
                  setHits([])
                  setOpen(false)
                }}
              >
                <span className={styles['hitHead']}>
                  <span className={styles['hitRoom']}>{hit.roomName}</span>
                  {hit.authorName === null ? null : (
                    <span className={styles['hitAuthor']}>{hit.authorName}</span>
                  )}
                </span>
                <span className={styles['hitText']}>{highlighted(hit.text, query)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
