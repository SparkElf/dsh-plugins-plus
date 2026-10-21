/**
 * The template library: a card grid in an official dialog, with a maintenance side.
 *
 * A template is a document plus the few facts that describe it -- name, one-line
 * description, category, optional tags. That is the whole model, and it is why the
 * store is a directory of documents next to one JSON index rather than a table: the
 * file IS the template, and the index only says what to call it.
 *
 * Two jobs live here, because they are two readings of the same list:
 *
 * - USING a template. A card's primary action copies the template's document into a
 *   directory the reader picks, through the same upload route any new document uses,
 *   then opens it. Nothing about a template is special enough to need its own write
 *   path.
 * - MAINTAINING the list. Adding a template is "choose a document, fill in the
 *   metadata"; editing is the same form with the file already stored; taking one
 *   offline removes the record and its document.
 *
 * The empty states are the honest ones: "nothing stored yet" and "could not read the
 * store" are different facts and say so separately, because a reader told the library
 * is empty will believe it.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  Modal,
  SegmentedTabs,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  KB_API,
  kbApiPath,
  readKnowledgeJson,
  type KnowledgeTemplateSaveInput,
  type KnowledgeTemplateView,
} from '../api.ts'
import {
  KnowledgeDestinationPicker,
  defaultDestination,
} from './KnowledgeCreateDialog.tsx'
import styles from './KnowledgeTemplates.module.css'

/** How long the template read may take before the surface gives up. */
const TEMPLATE_TIMEOUT_MS = 8_000

/** Which side of the dialog is showing. */
type TemplateTab = 'library' | 'manage'

/** The metadata form's state, shared by "add" and "edit". */
interface TemplateDraft {
  /** Set when editing an existing template. */
  id?: string
  title: string
  description: string
  category: string
  tags: string
  fileName: string
  /** The document text, for an added template. */
  content: string
}

/** An empty form, for "add". */
const EMPTY_DRAFT: TemplateDraft = {
  title: '', description: '', category: '', tags: '', fileName: '', content: '',
}

/** Props for the template library. */
export interface KnowledgeTemplatesProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Close the dialog. */
  onClose: () => void
  /** The knowledge root, for the "use this template" destination default. */
  mountPoint?: string
  /** The caller's id, so the destination default prefers their own folder. */
  callerId?: string
  /** Open a document once it has been created from a template. */
  onOpen?: (relPath: string) => void
}

/** A byte count in the reader's units. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * Split a tags field the way a reader types it.
 * @param raw - comma or space separated tags.
 * @returns Trimmed, de-duplicated tags.
 */
function splitTags(raw: string): string[] {
  return [...new Set(raw.split(/[,，\s]+/u).map(tag => tag.trim()).filter(tag => tag !== ''))]
}

/**
 * Read the template library.
 *
 * The deadline is enforced by a RACE, not by the abort alone. Measured earlier on this
 * surface: a fetch that never settles and ignores its signal kept the dialog reading
 * "Loading templates..." past seven seconds, because the abort was requested and the
 * transport did not care. The race makes the deadline authoritative whatever the
 * transport does, which is the whole reason the bound exists.
 * @returns The templates, or the literal `'timeout'` when the deadline won.
 */
async function loadTemplates(): Promise<
  { templates: KnowledgeTemplateView[]; error?: string } | 'timeout'
> {
  const controller = new AbortController()
  const deadline = new Promise<'timeout'>(resolve => {
    setTimeout(() => { controller.abort(); resolve('timeout') }, TEMPLATE_TIMEOUT_MS)
  })
  const read = (async (): Promise<{ templates: KnowledgeTemplateView[]; error?: string }> => {
    const response = await fetch(kbApiPath(KB_API.templates), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const body = await readKnowledgeJson<{ templates?: KnowledgeTemplateView[]; error?: string }>(response)
    return {
      templates: body.templates ?? [],
      ...(body.error === undefined ? {} : { error: body.error }),
    }
  })()
  try {
    return await Promise.race([read, deadline])
  } finally {
    // The losing branch must not keep a socket or a timer alive.
    controller.abort()
  }
}

/**
 * Render the template library.
 * @param props - copy resolver, the knowledge root, and the close handler.
 * @returns The dialog.
 */
export function KnowledgeTemplates(props: KnowledgeTemplatesProps) {
  const c = props.t
  const [tab, setTab] = useState<TemplateTab>('library')
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rows, setRows] = useState<KnowledgeTemplateView[]>([])
  const [readError, setReadError] = useState<string | undefined>(undefined)
  const [term, setTerm] = useState('')

  /** The form when it is open, undefined when it is closed. */
  const [draft, setDraft] = useState<TemplateDraft | undefined>(undefined)
  /** The template awaiting a remove confirmation. */
  const [confirming, setConfirming] = useState<KnowledgeTemplateView | undefined>(undefined)
  /** The destination a "use" copies into. */
  const [destination, setDestination] = useState(defaultDestination(undefined, props.callerId))
  /** A busy flag covering save, remove and use. */
  const [busy, setBusy] = useState(false)
  /** A sentence reporting the last outcome, or a refusal. */
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** The template being copied, so its own card can show progress. */
  const [usingId, setUsingId] = useState<string | undefined>(undefined)

  /** Set on unmount so a read that lands later cannot write to a dead component. */
  const live = useRef(true)

  /** Read the list, tolerating an unreachable Host as "unavailable". */
  const reload = useCallback(async (): Promise<void> => {
    setState('loading')
    try {
      const result = await loadTemplates()
      if (!live.current) return
      if (result === 'timeout') {
        // A timeout is "could not ask", not "there are none": an empty grid would
        // claim the source holds nothing, which this read never learned.
        setState('unavailable')
        return
      }
      setRows(result.templates)
      setReadError(result.error)
      // A store that reported a problem says so; the grid still renders what it
      // could read, because hiding rows that exist would be a second lie.
      setState(result.error === undefined ? 'ready' : 'unavailable')
    } catch {
      if (!live.current) return
      setRows([])
      setState('unavailable')
    }
  }, [])

  useEffect(() => {
    live.current = true
    void reload()
    return () => { live.current = false }
  }, [reload])

  /** The rows the search filter leaves. */
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter((row) => {
      const haystack = [row.title, row.description, row.category, ...row.tags].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [rows, term])

  /** Open the form for a new template. */
  const startAdd = useCallback((): void => {
    setNotice(undefined)
    setDraft({ ...EMPTY_DRAFT })
  }, [])

  /** Open the form for an existing template, with its file already stored. */
  const startEdit = useCallback((template: KnowledgeTemplateView): void => {
    setNotice(undefined)
    setDraft({
      id: template.id,
      title: template.title,
      description: template.description,
      category: template.category,
      tags: template.tags.join(', '),
      fileName: template.fileName,
      // Editing metadata does not re-send the document; the route keeps the stored
      // file when no content is supplied.
      content: '',
    })
  }, [])

  /** Read a chosen document into the draft. */
  const chooseFile = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    void (async () => {
      try {
        const content = await file.text()
        setDraft((current) => {
          if (current === undefined) return current
          return {
            ...current,
            content,
            fileName: file.name,
            // A title is still the reader's to write, but an empty one is filled from
            // the file name: it is the only name the system already knows.
            title: current.title.trim() === '' ? file.name.replace(/\.[^.]+$/u, '') : current.title,
          }
        })
      } catch {
        setNotice(c('templateFileUnreadable'))
      }
    })()
  }, [c])

  /** Write the draft through the save route. */
  const saveDraft = useCallback((): void => {
    if (draft === undefined || busy) return
    if (draft.title.trim() === '') {
      setNotice(c('templateNeedTitle'))
      return
    }
    if (draft.fileName.trim() === '') {
      setNotice(c('templateNeedFile'))
      return
    }
    setBusy(true)
    setNotice(undefined)
    void (async () => {
      try {
        const input: KnowledgeTemplateSaveInput = {
          title: draft.title.trim(),
          description: draft.description.trim(),
          category: draft.category.trim(),
          tags: splitTags(draft.tags),
          fileName: draft.fileName.trim(),
          ...(draft.content === '' ? {} : { content: draft.content }),
          ...(draft.id === undefined ? {} : { id: draft.id }),
        }
        const response = await fetch(kbApiPath(KB_API.templateSave), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          cache: 'no-store',
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) {
          setNotice(body.error ?? c('templateSaveFailed'))
          return
        }
        setDraft(undefined)
        setNotice(c('templateSaved'))
        await reload()
      } catch {
        setNotice(c('templateSaveFailed'))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, c, draft, reload])

  /** Take one template offline. */
  const removeConfirmed = useCallback((): void => {
    if (confirming === undefined || busy) return
    setBusy(true)
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.templateRemove), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: confirming.id }),
          cache: 'no-store',
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string; removed?: boolean }
        if (!response.ok) {
          setNotice(body.error ?? c('templateRemoveFailed'))
          return
        }
        setConfirming(undefined)
        setNotice(c('templateRemoved'))
        await reload()
      } catch {
        setNotice(c('templateRemoveFailed'))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, c, confirming, reload])

  /**
   * Copy one template's document into the chosen directory and open it.
   *
   * Two existing routes, in order: read the stored document, then upload it under the
   * destination with the same file name. A name that is already taken is refused by
   * the upload route rather than overwritten, so this reports the collision instead of
   * silently replacing someone's document.
   */
  const useTemplate = useCallback((template: KnowledgeTemplateView): void => {
    if (busy) return
    setBusy(true)
    setUsingId(template.id)
    setNotice(undefined)
    void (async () => {
      try {
        const readResponse = await fetch(kbApiPath(KB_API.read), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: template.relPath }),
          cache: 'no-store',
        })
        if (!readResponse.ok) {
          setNotice(c('templateUseFailed'))
          return
        }
        const read = await readKnowledgeJson<{ content?: string }>(readResponse)
        if (typeof read.content !== 'string') {
          setNotice(c('templateUseFailed'))
          return
        }
        const target = destination === '' ? template.fileName : destination + '/' + template.fileName
        const writeResponse = await fetch(kbApiPath(KB_API.upload), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: target, content: read.content }),
          cache: 'no-store',
        })
        const body = (await writeResponse.json().catch(() => ({}))) as { error?: string }
        if (!writeResponse.ok) {
          // A taken name is the common refusal, and it is worth naming as such: the
          // reader's next step (rename it or pick another folder) is different from a
          // permission failure.
          setNotice(body.error ?? c('templateUseFailed'))
          return
        }
        setNotice(c('templateUsed').replace('{path}', target))
        props.onOpen?.(target)
        props.onClose()
      } catch {
        setNotice(c('templateUseFailed'))
      } finally {
        setBusy(false)
        setUsingId(undefined)
      }
    })()
  }, [busy, c, destination, props])

  /** Update one field of the open draft. */
  const setField = useCallback(<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void => {
    setDraft(current => (current === undefined ? current : { ...current, [key]: value }))
  }, [])

  return (
    <Modal
      open
      onClose={props.onClose}
      title={c('templateTitle')}
      closeLabel={c('templateClose')}
      description={c('templateSubtitle')}
      footer={(
        <Button variant="ghost" onClick={props.onClose}>{c('templateClose')}</Button>
      )}
    >
      <div className={styles.dialog}>
        <div className={styles.toolbar}>
          <SegmentedTabs
            value={tab}
            // `id`/`panelId` pair each tab with the pane below it, which is what makes
            // the control a tab list rather than a pair of buttons.
            items={[
              { value: 'library', id: 'kb-template-tab-library', panelId: 'kb-template-panel', label: c('templateTabLibrary') },
              { value: 'manage', id: 'kb-template-tab-manage', panelId: 'kb-template-panel', label: c('templateTabManage') },
            ]}
            label={c('templateTitle')}
            onChange={(next) => { setTab(next); setDraft(undefined); setNotice(undefined) }}
          />
          <Input
            value={term}
            placeholder={c('templateSearch')}
            aria-label={c('templateSearch')}
            onChange={(event) => { setTerm(event.target.value) }}
          />
        </div>

        {notice !== undefined && <p className={styles.notice} role="status">{notice}</p>}

        {tab === 'library' && (
          <div className={styles.library}>
            {/* Where a "use" lands, shown before any card is pressed: the choice is
                part of using a template, not an afterthought after clicking one. */}
            <div className={styles.destination}>
              <span className={styles.destinationLabel}>{c('templateUseInto')}</span>
              <KnowledgeDestinationPicker
                value={destination}
                onChange={setDestination}
                t={c}
                disabled={busy}
              />
            </div>

            {state === 'loading' && <p className={styles.muted}>{c('templateLoading')}</p>}
            {state === 'unavailable' && (
              <p className={styles.muted}>
                {readError === undefined
                  ? c('templateUnavailable')
                  : c('templateUnavailableReason').replace('{reason}', readError)}
              </p>
            )}
            {state === 'ready' && visible.length === 0 && (
              <p className={styles.muted}>{term.trim() === '' ? c('templateEmpty') : c('templateNoMatch')}</p>
            )}
            {state === 'ready' && visible.length > 0 && (
              <ul className={styles.grid}>
                {visible.map(template => (
                  <li key={template.id} className={styles.card}>
                    <div className={styles.cardHead}>
                      <span className={styles.cardTitle}>{template.title}</span>
                      <Tag>{template.extension === '' ? c('templateFileBadge') : template.extension}</Tag>
                    </div>
                    {template.description !== '' && (
                      <p className={styles.cardBody}>{template.description}</p>
                    )}
                    <div className={styles.cardTags}>
                      {template.category !== '' && <Tag tone="neutral">{template.category}</Tag>}
                      {template.tags.slice(0, 4).map(tag => <Tag key={tag}>{tag}</Tag>)}
                    </div>
                    <div className={styles.cardFoot}>
                      <span className={styles.cardMeta}>
                        {sizeText(template.bytes)}
                        {' · '}
                        {template.updatedAt.slice(0, 10)}
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => { useTemplate(template) }}
                      >
                        {usingId === template.id ? c('templateUsing') : c('templatePick')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'manage' && (
          <div className={styles.manage}>
            {draft === undefined && (
              <>
                <div className={styles.manageBar}>
                  <Button variant="primary" onClick={startAdd}>{c('templateAdd')}</Button>
                </div>
                {rows.length === 0
                  ? <p className={styles.muted}>{c('templateManageEmpty')}</p>
                  : (
                    <ul className={styles.manageList}>
                      {rows.map(template => (
                        <li key={template.id} className={styles.manageRow}>
                          <span className={styles.manageName}>{template.title}</span>
                          <span className={styles.cardMeta}>{template.fileName} · {sizeText(template.bytes)}</span>
                          <span className={styles.manageActions}>
                            <Button variant="ghost" size="sm" onClick={() => { startEdit(template) }}>
                              {c('templateEdit')}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => { setConfirming(template) }}>
                              {c('templateRemove')}
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </>
            )}

            {draft !== undefined && (
              <div className={styles.form}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateName')}</span>
                  <Input
                    value={draft.title}
                    placeholder={c('templateNamePlaceholder')}
                    aria-label={c('templateName')}
                    onChange={(event) => { setField('title', event.target.value) }}
                    data-modal-autofocus
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateDescription')}</span>
                  <Input
                    value={draft.description}
                    placeholder={c('templateDescriptionPlaceholder')}
                    aria-label={c('templateDescription')}
                    onChange={(event) => { setField('description', event.target.value) }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateCategory')}</span>
                  <Input
                    value={draft.category}
                    placeholder={c('templateCategoryPlaceholder')}
                    aria-label={c('templateCategory')}
                    onChange={(event) => { setField('category', event.target.value) }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateTags')}</span>
                  <Input
                    value={draft.tags}
                    placeholder={c('templateTagsPlaceholder')}
                    aria-label={c('templateTags')}
                    onChange={(event) => { setField('tags', event.target.value) }}
                  />
                </label>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateDocument')}</span>
                  <input
                    type="file"
                    accept=".md,.markdown,.txt,.docx,.pdf"
                    className={styles.fileInput}
                    onChange={chooseFile}
                  />
                  {draft.fileName !== '' && (
                    <span className={styles.fieldHint}>
                      {draft.id === undefined
                        ? c('templateFileChosen').replace('{name}', draft.fileName)
                        : c('templateFileKept').replace('{name}', draft.fileName)}
                    </span>
                  )}
                </div>
                <div className={styles.formActions}>
                  <Button variant="ghost" onClick={() => { setDraft(undefined) }}>{c('cancel')}</Button>
                  <Button variant="primary" disabled={busy} onClick={saveDraft}>
                    {busy ? c('templateSaving') : c('templateSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Removing is destructive and irreversible from this surface, so it asks. */}
      <Modal
        open={confirming !== undefined}
        onClose={() => { setConfirming(undefined) }}
        title={c('templateRemoveTitle')}
        closeLabel={c('cancel')}
        description={c('templateRemoveBody').replace('{name}', confirming?.title ?? '')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setConfirming(undefined) }}>{c('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={removeConfirmed}>{c('templateRemove')}</Button>
          </>
        )}
      >
        <span />
      </Modal>
    </Modal>
  )
}
