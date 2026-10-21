/**
 * One official dialog behind the Home surface's three create/upload actions, plus the
 * destination picker and name field they all share.
 *
 * The reference had a dropdown per card whose rows opened a browser `window.prompt` for
 * a name and dropped the result into `global/`. Two things were wrong with that: a
 * prompt cannot show where the file will land, and it cannot offer to change it -- so
 * every new document silently published to the one bucket everybody reads.
 *
 * All three actions therefore share one dialog, because they ask the same two questions
 * (what is it called, and where does it go) and differ only in what they write: `create`
 * for a document, `create` with `kind: 'directory'` for a folder, and `upload` per file
 * for an upload. Keeping them together means the validation, the destination default and
 * the keyboard contract cannot drift apart between them.
 *
 * The dialog is a `Modal` and the fields are `Input`/`Button` from the primitives -- no
 * hand-built layer -- so Escape, the mask, focus return and the card chrome all come
 * from the same implementation every other DSH dialog uses. The directory picker reads
 * the live tree one level at a time through the Host's own listing route (`KB_API.list`),
 * so it can never offer a directory the caller may not read, and it takes a
 * `defaultPath` chosen by {@link defaultDestination} rather than guessing.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeCreateDialog.module.css'

/** One directory level as the Host's listing route reports it. */
interface ListingEntry {
  relPath: string
  name: string
  isDir: boolean
}

/**
 * Where a create or upload should land when the reader has not said otherwise.
 *
 * The order is the whole point of this function, and it is deliberately not
 * "global first":
 *
 * 1. The directory the reader is looking at. If they navigated into
 *    `department/OPS/specs` and then pressed New, that is where they mean -- a
 *    create that jumps elsewhere makes the tree they are reading a lie.
 * 2. The reader's own personal directory. Without a current directory this is the
 *    only bucket that is theirs by construction, so it is the safe default: a file
 *    created there cannot surprise a colleague.
 * 3. `global`, last, and only as a last resort. It is the shared bucket, so
 *    defaulting to it is how a private draft becomes a team announcement.
 *
 * @param currentDir - the tree-relative directory the reader is browsing, if any.
 * @param userId - the caller's DataOps id, from the status route.
 * @returns A tree-relative directory that exists or is expected to.
 */
export function defaultDestination(currentDir: string | undefined, userId: string | undefined): string {
  if (currentDir !== undefined && currentDir !== '') return currentDir
  if (userId !== undefined && userId !== '') return 'personal/' + userId
  return 'global'
}

/**
 * Read one directory level from the Host.
 * @param path - tree-relative path; empty for the mount root.
 * @returns The directory's entries, or an empty list when it cannot be read.
 */
async function listLevel(path: string): Promise<ListingEntry[]> {
  const response = await fetch(kbApiPath(KB_API.list), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  const body = await readKnowledgeJson<{ entries?: ListingEntry[] }>(response)
  return (body.entries ?? []).filter(entry => entry.isDir)
}

/** Props for the destination picker. */
export interface KnowledgeDestinationPickerProps {
  /** Tree-relative directory currently selected. */
  value: string
  /** Called with a new tree-relative directory. */
  onChange: (path: string) => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Disables the control while the dialog is submitting. */
  disabled?: boolean
}

/**
 * A breadcrumb-style directory chooser: the current path, a way back up, and the
 * subdirectories of the level being shown.
 * @param props - the selected path and its change handler.
 * @returns The picker.
 */
export function KnowledgeDestinationPicker(props: KnowledgeDestinationPickerProps) {
  const { value, onChange, t, disabled } = props
  const [entries, setEntries] = useState<readonly ListingEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  // Load whichever level is selected, so the list under the breadcrumb is always the
  // children of the path the reader is about to commit to.
  useEffect(() => {
    let cancelled = false
    setState('loading')
    void (async () => {
      try {
        const rows = await listLevel(value)
        if (cancelled) return
        setEntries(rows)
        setState('ready')
      } catch {
        if (cancelled) return
        setEntries([])
        setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [value])

  /** The path one level up, or undefined at the top. */
  const parent = useMemo(() => {
    const cut = value.lastIndexOf('/')
    if (cut === -1) return undefined
    return value.slice(0, cut)
  }, [value])

  /** Segments for the breadcrumb, each carrying the path it stands for. */
  const crumbs = useMemo(() => {
    if (value === '') return []
    const parts = value.split('/')
    return parts.map((part, index) => ({ name: part, path: parts.slice(0, index + 1).join('/') }))
  }, [value])

  const goUp = useCallback((): void => {
    if (parent !== undefined) onChange(parent)
  }, [onChange, parent])

  const resetToRoot = useCallback((): void => { onChange('') }, [onChange])

  return (
    <div className={styles.picker}>
      <div className={styles.pickerBar}>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={resetToRoot}>
          {t('createAtRoot')}
        </Button>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className={styles.crumbWrap}>
            <span className={styles.crumbSep} aria-hidden="true">/</span>
            <button
              type="button"
              className={styles.crumb}
              disabled={disabled || index === crumbs.length - 1}
              onClick={() => { onChange(crumb.path) }}
            >
              {crumb.name}
            </button>
          </span>
        ))}
        {parent !== undefined && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={goUp}>
            {t('createAtUp')}
          </Button>
        )}
      </div>

      {/* The chosen path, always visible: the reader has to be able to read where the
          file will land without inferring it from the breadcrumb. */}
      <p className={styles.pickerPath}>
        <span className={styles.pickerPathLabel}>{t('createDestination')}</span>
        <code className={styles.pickerPathValue}>{'/' + (value === '' ? '' : value)}</code>
      </p>

      <div className={styles.pickerList} role="group" aria-label={t('createDestination')}>
        {state === 'loading' && <p className={styles.pickerMuted}>{t('createLoading')}</p>}
        {state === 'error' && <p className={styles.pickerMuted}>{t('createListingFailed')}</p>}
        {state === 'ready' && entries.length === 0 && (
          <p className={styles.pickerMuted}>{t('createNoSubfolders')}</p>
        )}
        {state === 'ready' && entries.map(entry => (
          <button
            key={entry.relPath}
            type="button"
            className={styles.pickerRow}
            disabled={disabled}
            onClick={() => { onChange(entry.relPath) }}
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Props for the name field, shared by the document and folder forms. */
export interface KnowledgeNameFieldProps {
  /** What the reader has typed so far. */
  value: string
  /** Called on every keystroke. */
  onChange: (next: string) => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Placeholder naming the kind being created. */
  placeholder: string
  /** Set while submitting. */
  disabled?: boolean
  /** A validation message to show under the field. */
  error?: string
}

/**
 * Reject a name this tree cannot store.
 *
 * The rule mirrors the Host's `isContainedRelPath`: a name may not be empty, may not
 * contain a separator (that would silently make the "name" a path), and may not be
 * a traversal segment. Rejecting it here turns a refused request into an inline
 * sentence before the reader presses Create.
 * @param name - the candidate name, without any directory part.
 * @returns A locale key naming the problem, or undefined when the name is fine.
 */
export function validateEntryName(name: string): 'createNameEmpty' | 'createNameSeparator' | 'createNameTraversal' | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'createNameEmpty'
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'createNameSeparator'
  if (trimmed === '.' || trimmed === '..') return 'createNameTraversal'
  return undefined
}

/**
 * The name field with its inline validation.
 * @param props - the field's state.
 * @returns The labelled input.
 */
export function KnowledgeNameField(props: KnowledgeNameFieldProps) {
  const { value, onChange, t, placeholder, disabled, error } = props
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('createName')}</span>
      <Input
        value={value}
        placeholder={placeholder}
        aria-label={t('createName')}
        aria-invalid={error !== undefined}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
        data-modal-autofocus
      />
      {error !== undefined && <span className={styles.fieldError} role="alert">{t(error)}</span>}
    </label>
  )
}

// ── the dialog itself ───────────────────────────────────────────────────────────

/**
 * Which of the three flows the dialog is running.
 *
 * `upload-file` and `upload-folder` differ only in how the browser's picker is
 * configured (`webkitdirectory`), not in what the dialog asks; the destination is a
 * single choice for the whole selection, which is what "choose where these go"
 * means.
 */
export type CreateMode = 'new-doc' | 'new-folder' | 'upload-file' | 'upload-folder'

/** One file a reader chose, with the path it should land at. */
export interface PendingUpload {
  /** The file as the browser handed it over. */
  file: File
  /** Its name relative to the picked root: a folder upload keeps its shape. */
  relative: string
}

/** Props for the dialog. */
export interface KnowledgeCreateDialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Which flow to run. */
  mode: CreateMode
  /** Close without writing anything. */
  onClose: () => void
  /** The directory the dialog should start in, from {@link defaultDestination}. */
  defaultPath: string
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /**
   * Report the outcome and refresh the caller's listing.
   * @param message - a locale-bound sentence to show under the cards.
   */
  onDone: (message: string) => void
}

/** Join a directory and a name into a tree-relative path. */
function joinRel(directory: string, name: string): string {
  return directory === '' ? name : directory + '/' + name
}

/**
 * The create/upload dialog.
 * @param props - the flow, its starting directory, and the outcome channel.
 * @returns The dialog, or null while closed.
 */
export function KnowledgeCreateDialog(props: KnowledgeCreateDialogProps) {
  const { open, mode, onClose, defaultPath, t, onDone } = props

  const [name, setName] = useState('')
  const [destination, setDestination] = useState(defaultPath)
  const [pending, setPending] = useState<readonly PendingUpload[]>([])
  const [busy, setBusy] = useState(false)
  /** How many files of the current upload are done, for the progress line. */
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined)
  /** A refusal from the Host, shown in the dialog's own words. */
  const [serverError, setServerError] = useState<string | undefined>(undefined)

  const isUpload = mode === 'upload-file' || mode === 'upload-folder'
  const isFolder = mode === 'new-folder'

  // A fresh open starts from the caller's default destination and an empty name: the
  // previous run's answers belong to a different intent.
  useEffect(() => {
    if (!open) return
    setName('')
    setDestination(defaultPath)
    setPending([])
    setBusy(false)
    setProgress(undefined)
    setServerError(undefined)
  }, [open, defaultPath, mode])

  /** The name as it will be stored: a document gains `.md` when it has no extension. */
  const storedName = useMemo(() => {
    const trimmed = name.trim()
    if (isFolder || isUpload) return trimmed
    return trimmed.endsWith('.md') ? trimmed : trimmed + '.md'
  }, [isFolder, isUpload, name])

  const nameError = useMemo(() => validateEntryName(name), [name])

  /** The absolute-ish target the reader is about to write, for the summary line. */
  const target = useMemo(() => joinRel(destination, storedName), [destination, storedName])

  /** Write a document or a folder through the existing create route. */
  const submitCreate = useCallback(async (): Promise<void> => {
    setBusy(true)
    setServerError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.create), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: target, kind: isFolder ? 'directory' : 'file' }),
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        // The Host names the reason (no write access, name already taken), so it is
        // shown rather than flattened into "failed".
        setServerError(body.error ?? t('cardCreateFailed'))
        return
      }
      onDone(t('createDone').replace('{path}', target))
      onClose()
    } catch {
      setServerError(t('cardCreateFailed'))
    } finally {
      setBusy(false)
    }
  }, [isFolder, onClose, onDone, t, target])

  /** Write every chosen file, one request each, and report a per-file summary. */
  const submitUpload = useCallback(async (): Promise<void> => {
    if (pending.length === 0) return
    setBusy(true)
    setServerError(undefined)
    setProgress({ done: 0, total: pending.length })
    let done = 0
    const failed: string[] = []
    for (const item of pending) {
      try {
        const content = await item.file.text()
        const response = await fetch(kbApiPath(KB_API.upload), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: joinRel(destination, item.relative), content }),
          cache: 'no-store',
        })
        if (response.ok) done += 1
        else failed.push(item.relative)
      } catch {
        failed.push(item.relative)
      }
      // Every completion moves the line, which is what makes a long upload legible.
      setProgress({ done: done + failed.length, total: pending.length })
    }
    setProgress(undefined)
    setBusy(false)
    if (failed.length === 0) {
      onDone(t('uploadDone').replace('{n}', String(done)))
    } else {
      // The count and the names: "3 of 5 failed" alone leaves no way to tell which
      // ones to retry.
      onDone(
        t('uploadPartial')
          .replace('{ok}', String(done))
          .replace('{failed}', String(failed.length))
          .replace('{names}', failed.slice(0, 3).join('、')),
      )
    }
    onClose()
  }, [destination, onClose, onDone, pending, t])

  /** Run whichever flow this dialog is in. */
  const submit = useCallback((): void => {
    if (busy) return
    if (isUpload) {
      if (pending.length === 0) return
      void submitUpload()
      return
    }
    if (nameError !== undefined) return
    void submitCreate()
  }, [busy, isUpload, nameError, pending.length, submitCreate, submitUpload])

  /** Enter submits, except while a field is refusing the value. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter') return
    // A textarea or a button keeps its own Enter behavior.
    const tag = (event.target as HTMLElement | null)?.tagName
    if (tag === 'TEXTAREA') return
    event.preventDefault()
    submit()
  }, [submit])

  /** The browser's own picker fills the pending list; the dialog decides the path. */
  const chooseFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])]
    // Cleared so picking the same files twice fires again.
    event.target.value = ''
    setPending(chosen.map(file => ({
      file,
      // A folder upload carries the picked root plus the file's place inside it, so
      // recreating the shape is the honest reading of "upload this folder".
      relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })))
  }, [])

  const title = isUpload
    ? (mode === 'upload-folder' ? t('homeUploadTitle') : t('cardItemUploadFile'))
    : (isFolder ? t('cardItemNewFolder') : t('cardItemNewDoc'))

  /** Why the primary button cannot run yet, in the reader's words. */
  const blocker = isUpload
    ? (pending.length === 0 ? t('createPickFiles') : undefined)
    : (nameError !== undefined ? undefined : undefined)

  const disabled = busy || (isUpload ? pending.length === 0 : nameError !== undefined)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('cancel')}
      description={isUpload ? t('createUploadHint') : t('createDialogHint')}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={submit}>
            {busy
              ? (progress === undefined
                ? t('cardBusyCreating')
                : t('createProgress').replace('{done}', String(progress.done)).replace('{total}', String(progress.total)))
              : (isUpload ? t('createUpload') : t('createSubmit'))}
          </Button>
        </>
      )}
    >
      <div className={styles.dialog} onKeyDown={onKeyDown}>
        {!isUpload && (
          <KnowledgeNameField
            value={name}
            onChange={setName}
            t={t}
            placeholder={isFolder ? t('createFolderPlaceholder') : t('createDocPlaceholder')}
            disabled={busy}
            error={nameError}
          />
        )}

        {isUpload && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('createFiles')}</span>
            <input
              type="file"
              multiple
              className={styles.fileInput}
              disabled={busy}
              {...(mode === 'upload-folder' ? { webkitdirectory: '' } : {})}
              onChange={chooseFiles}
            />
            {pending.length === 0
              ? <span className={styles.fieldHint}>{t('createPickFiles')}</span>
              : (
                // Every file's own landing path, so a folder upload's shape is visible
                // before the reader commits.
                <ul className={styles.fileList}>
                  {pending.slice(0, 8).map(item => (
                    <li key={item.relative} className={styles.fileRow}>
                      <span className={styles.fileName}>{item.relative}</span>
                      <code className={styles.fileTarget}>{'/' + joinRel(destination, item.relative)}</code>
                    </li>
                  ))}
                  {pending.length > 8 && (
                    <li className={styles.fileRow}>
                      <span className={styles.fileName}>
                        {t('createMoreFiles').replace('{n}', String(pending.length - 8))}
                      </span>
                    </li>
                  )}
                </ul>
              )}
          </div>
        )}

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('createDestinationPicker')}</span>
          <KnowledgeDestinationPicker
            value={destination}
            onChange={setDestination}
            t={t}
            disabled={busy}
          />
        </div>

        {/* The composed target, restated in full: the two controls above are the
            inputs to it, and this is the answer. */}
        {!isUpload && nameError === undefined && (
          <p className={styles.summary}>{t('createWillCreate').replace('{path}', '/' + target)}</p>
        )}

        {blocker !== undefined && <p className={styles.fieldHint}>{blocker}</p>}
        {serverError !== undefined && <p className={styles.fieldError} role="alert">{serverError}</p>}
      </div>
    </Modal>
  )
}
