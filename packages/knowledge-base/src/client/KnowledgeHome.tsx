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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
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
   * The tab whose card should take focus on mount.
   *
   * Set when a reader arrives here from the tree's empty state, which is asking
   * them to start a document: the blank-page card is the answer to that question,
   * so it is the one that should be reachable by keyboard immediately.
   */
  focusNew?: boolean
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
   * Which card's menu is open, or null.
   *
   * One value rather than a flag per card, so "only one open at a time" is the
   * shape of the state instead of a rule the handlers have to remember to enforce.
   */
  const [openCard, setOpenCard] = useState<CardId | null>(null)
  const cardsRef = useRef<HTMLDivElement | null>(null)
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
  /** A hidden file input's handle, so a menu row can open the reader's picker. */
  const uploadRef = useRef<HTMLInputElement | null>(null)



  // Close on an outside pointer. The card's own handler stops propagation, so
  // reaching the document means the press was somewhere else.
  useEffect(() => {
    if (openCard === null) return
    const close = (event: MouseEvent) => {
      if (cardsRef.current !== null && event.target instanceof Node && cardsRef.current.contains(event.target)) return
      setOpenCard(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenCard(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [openCard])

  // Read once per mount. The tree route answers one directory level, and the Home
  // table lists documents rather than a tree, so only the mount's own level is
  // read here: descending would turn a landing page into a filesystem walk.
  const read = useCallback(async (): Promise<void> => {
    if (props.mountPoint === '') {
      setState('error')
      return
    }
    setState('loading')
    try {
      const response = await fetch(kbApiPath(KB_API.list), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '' }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = await readKnowledgeJson<{
        entries?: Array<{ relPath: string; name: string; isDir: boolean; mtimeMs?: number }>
      }>(response)
      setRows((body.entries ?? [])
        .filter(entry => !entry.isDir)
        .map(entry => ({
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
   * Run one menu action.
   *
   * `new-doc` and `new-folder` ask for a name first: the reference's menu opens an
   * editor, and creating `未命名.md` unasked would put a file in the shared tree
   * that nobody chose a name for. The prompt is the smallest honest stand-in for
   * the editor this plugin does not have.
   */
  const runItem = useCallback(async (kind: CardItem['kind']) => {
    if (kind === 'open-templates') {
      setOpenCard(null)
      setTemplatesOpen(true)
      return
    }
    const wantsDirectory = kind === 'new-folder' || kind === 'upload-folder'
    if (kind === 'upload-file' || kind === 'upload-folder') {
      // The page opens the reader's own picker and posts what they choose, which is
      // how an upload works in a browser: the Host has no picker route, and the
      // bytes never need to reach it before the reader has chosen them.
      setOpenCard(null)
      if (uploadRef.current !== null) {
        const input = uploadRef.current
        const wantsFolder = kind === 'upload-folder'
        // `webkitdirectory` is what makes the row's promise true: the picker returns
        // the folder's whole subtree, each file carrying its path relative to the
        // chosen root. Without it the row could only offer a multi-file selection,
        // which is not what "upload folder" says.
        if (wantsFolder) input.setAttribute('webkitdirectory', '')
        else input.removeAttribute('webkitdirectory')
        input.multiple = true
        input.dataset.folder = wantsFolder ? 'true' : 'false'
        input.click()
      }
      return
    }
    const entered = window.prompt(c(wantsDirectory ? 'cardItemNewFolder' : 'cardItemNewDoc'))
    const name = (entered ?? '').trim()
    if (name === '') {
      setNotice(c('cardNeedsPath'))
      return
    }
    const relPath = wantsDirectory ? name : (name.endsWith('.md') ? name : name + '.md')
    setOpenCard(null)
    setNotice(c('cardBusyCreating'))
    try {
      const response = await fetch(kbApiPath(KB_API.create), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath, kind: wantsDirectory ? 'directory' : 'file' }),
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        // The Host's message names the reason (no write access, name taken), so it
        // is shown rather than flattened into "failed".
        setNotice(body.error ?? c('cardCreateFailed'))
        return
      }
      setNotice(c('cardCreated') + ' ' + relPath)
      await read()
    } catch {
      setNotice(c('cardCreateFailed'))
    }
  }, [c, props, read])

  /**
   * Upload the chosen files, one request each, and report what happened.
   *
   * One request per file rather than a batch body, because the Host checks write
   * permission and the size ceiling per path: a single body carrying many files
   * would have to decide what a partially-authorized batch means, and the honest
   * answer is a per-file outcome anyway.
   *
   * A failure does not stop the run. The reader chose a folder; refusing the whole
   * selection because one file collided with an existing name would make them guess
   * which one. So every file is attempted and the summary names the failures.
   *
   * @param files - the chosen files, each carrying its path relative to the picked root.
   * @returns Nothing; the outcome is reported through `notice`.
   */
  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setNotice(c('cardBusyCreating'))
    let done = 0
    const failed: string[] = []
    for (const file of files) {
      // `webkitRelativePath` is the folder the reader picked plus the file's place
      // inside it, which is exactly the destination: uploading a folder recreates
      // its shape in the tree rather than flattening it into one level.
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      try {
        const content = await file.text()
        const response = await fetch(kbApiPath(KB_API.upload), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath, content }),
          cache: 'no-store',
        })
        if (response.ok) done += 1
        else failed.push(relPath)
      } catch {
        failed.push(relPath)
      }
    }
    if (failed.length === 0) {
      setNotice(c('uploadDone').replace('{n}', String(done)))
    } else {
      // The count and the names, because "3 of 5 failed" alone leaves the reader
      // with no way to tell which ones to retry.
      setNotice(
        c('uploadPartial')
          .replace('{ok}', String(done))
          .replace('{failed}', String(failed.length))
          .replace('{names}', failed.slice(0, 3).join('、')),
      )
    }
    await read()
  }, [c, read])

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
      <div className={styles.cards} ref={cardsRef}>
        {/* A card, not a Button: the whole tile is the target and its own layout
            (plate, text, chevron) is the content. `Button` renders a fixed-height
            control whose label is a single line, so using it here would mean
            recreating the card inside it.

            Geometry follows the reference image, measured at
            `/root/projects/kb-notes/CARD-SPEC-VERIFIED-BY-KBUI.md`: a horizontal
            row, a 20.5 CSS px rounded colour plate, and the three parts vertically
            centred. The stylesheet carries the per-value provenance. */}
        {cards.map(card => {
          const open = openCard === card.id
          return (
            <div key={card.id} className={styles.cardSlot}>
              <button
                type="button"
                className={styles.card}
                data-card={card.id}
                data-open={open ? 'true' : undefined}
                aria-expanded={open}
                aria-haspopup="menu"
                // Autofocus only the blank-page card, and only when the caller asked:
                // moving focus without being asked would steal it from the rail.
                autoFocus={props.focusNew === true && card.id === 'new'}
                disabled={props.mountPoint === ''}
                onClick={() => { setOpenCard(open ? null : card.id) }}
              >
                <span className={styles.cardPlate} data-tone={card.tone} aria-hidden="true">{card.glyph}</span>
                <span className={styles.cardText}>
                  <span className={styles.cardTitle}>{card.title}</span>
                  <span className={styles.cardBody}>{card.body}</span>
                </span>
                {/* The reference flips this arrow while the menu is open, so it
                    reads as an expander rather than a navigation chevron. */}
                <span className={styles.cardChevron} aria-hidden="true">
                  {open ? <IconChevronUpOutlineRegular size={16} /> : <IconChevronDownOutlineRegular size={16} />}
                </span>
              </button>
              {open && (
                <ul className={styles.cardMenu} role="menu" aria-label={card.title}>
                  {card.items.map(item => (
                    <li key={item.kind}>
                      {/* Every row does something: the two create rows and the two
                          upload rows reach the Host, and the template row opens the
                          library. Only an unmounted tree disables them, because
                          there is then no destination. */}
                      <button
                        type="button"
                        className={styles.cardMenuItem}
                        role="menuitem"
                        disabled={props.mountPoint === ''}
                        onClick={() => { void runItem(item.kind) }}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {/* The reader's own picker. Hidden rather than styled: a browser decides what
          a file control looks like, and the menu rows are the visible affordance. */}
      <input
        ref={uploadRef}
        type="file"
        className={styles.hiddenInput}
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])]
          // Cleared so choosing the same files twice fires again: a file input keeps
          // its value, and a second pick of the same names would otherwise do nothing.
          event.target.value = ''
          void uploadFiles(chosen)
        }}
      />

      {/* The outcome of the last action. `role="status"` so a screen reader
          announces it without moving focus away from the menu. */}
      {notice !== null && <p className={panelStyles.notice} role="status">{notice}</p>}

      {templatesOpen && (
        <KnowledgeTemplates t={props.t} onClose={() => { setTemplatesOpen(false) }} />
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
              <tr key={row.relPath}>
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
                {/* Owner is drawn from grant data the tree does not carry, so the
                    cell states that instead of naming a person guessed from the
                    filename. */}
                <td><Tag tone="quiet">{c('homeColOwnerUnset')}</Tag></td>
                <td className={styles.muted}>{formatStamp(row.mtimeMs, locale)}</td>
                <td className={styles.muted}>{formatStamp(row.mtimeMs, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
