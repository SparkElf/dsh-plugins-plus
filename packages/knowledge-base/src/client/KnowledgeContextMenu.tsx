/**
 * The row context menu for the knowledge tree.
 *
 * A right-click on a row used to jump straight to the permission surface, which meant a
 * reader looking for "save this file" got an operator's dialog instead. The menu is the
 * affordance a file list is expected to have, and it is built on the product's own `Menu`
 * primitive rather than a hand-rolled popover: keyboard walking, Escape, outside click,
 * and post-selection focus return are the primitive's behaviour, and a local copy of that
 * would drift.
 *
 * The menu is positioned from the pointer rather than from an anchor element, which is
 * what the primitive's `getAnchorRect` hook is for: a context menu opens where the reader
 * clicked, not below the row's own control.
 *
 * Every action here is a call to a route that already exists. Sharing is `grant`, the
 * star is `favorites.set`, and paste dispatches on what the clipboard holds: a cut pastes
 * through `move`, a copy through `copy`. Both resolve the destination from the entry's own
 * name, so a paste cannot rename; both carry a directory's whole subtree. The clipboard is
 * a client-side pair of paths and a flag -- nothing about a pending paste is worth a
 * server-side record, and a clipboard that survived a reload would be a paste the reader
 * could no longer see they had armed.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import { KnowledgeShareDialog, type ShareDialogCopy } from './KnowledgeShareDialog.tsx'

/** One row the menu can act on. */
export interface ContextTarget {
  /** Path relative to the knowledge root. */
  relPath: string
  /** Display name, used as the rename dialog's starting value. */
  name: string
  /** Whether the row is a directory (renaming one renames the directory). */
  isDir: boolean
}

/** The clipboard the copy/cut entries fill. */
export interface TreeClipboard {
  /** The path that was copied or cut. */
  relPath: string
  /** Its display name, so the paste label can name the entry. */
  name: string
  /** True when the source is removed on paste (cut); false for a copy request. */
  cut: boolean
}

/** Props for the context menu. */
export interface KnowledgeContextMenuProps {
  /** The row the menu is open on, or null when closed. */
  target: ContextTarget | null
  /** Where the pointer was, in viewport coordinates. */
  at: { x: number; y: number } | null
  /** Copy resolver for this package's namespace. */
  t: (key: string) => string
  /** Copy for the share dialog, which carries its own key set. */
  shareCopy: ShareDialogCopy
  /** Close the menu. */
  onClose: () => void
  /** Open the permission surface for this path. */
  onGrant: (path: string) => void
  /** Toggle the pin state for this path. */
  onPin: (path: string, pinned: boolean) => void
  /** Whether this path is currently pinned. */
  pinned: boolean
  /** Toggle the favourite state for this path. */
  onFavorite: (path: string, favorite: boolean) => void
  /** Whether this path is currently favourited. */
  favorite: boolean
  /** Insert a reference to this path into the conversation. */
  onReference: (path: string, isDir: boolean) => void
  /** Called after a rename succeeds, so the page reloads the tree. */
  onRenamed: () => void
  /** Called after a delete-to-trash succeeds, so the page reloads the tree. */
  onDeleted: () => void
  /** What the clipboard currently holds, or null when it is empty. */
  clipboard: TreeClipboard | null
  /** Put one entry on the clipboard. Recording only; nothing moves until paste. */
  onClipboard: (entry: TreeClipboard | null) => void
  /**
   * The directory a paste would land in.
   *
   * For a directory row the target is that directory; for a file it is the file's
   * parent. The menu states it so a paste never lands somewhere the reader cannot see,
   * and `null` means the destination is unknown, which disables the entry rather than
   * guessing.
   */
  pasteInto: string | null
  /** Called after a paste succeeds, so the page reloads both affected levels. */
  onMoved: () => void
}

/**
 * Trigger a browser download from a base64 payload.
 *
 * The bytes arrive as JSON (see the Host's `download` route) because the plugin's bridge
 * is JSON-only. Blob + an anchor click is the standard way to save from a page without a
 * second origin request, and `URL.revokeObjectURL` must follow or the blob stays resident
 * for the document's lifetime.
 * @param name - the file name the save dialog suggests.
 * @param base64 - the file's bytes.
 * @param mime - the MIME type to label the blob with.
 */
function saveBase64(name: string, base64: string, mime: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  // Some engines ignore a click on a detached node, so it joins the document for the
  // duration of the click and is removed immediately after.
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * The knowledge tree's row context menu.
 * @param props - the target row, the pointer position, and the actions.
 * @returns The menu, or nothing when it is closed.
 */
export function KnowledgeContextMenu(props: KnowledgeContextMenuProps) {
  const { target, at, t, onClose } = props
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /**
   * The row the share dialog is open for, captured when the menu row is chosen.
   *
   * The menu and the dialog have different lifetimes: choosing "Share" closes the menu,
   * and the parent then clears `target` -- so a dialog reading the live target would
   * unmount in the same commit that opened it. Holding the row here is what lets the
   * dialog outlive the menu.
   */
  const [shareTarget, setShareTarget] = useState<ContextTarget | null>(null)

  /**
   * Position the dropdown at the pointer.
   *
   * Recomputed on every frame the primitive asks for, because the pointer does not move
   * once the menu is open: returning the same rect is correct and cheaper than letting
   * the primitive measure a zero-size wrapper.
   */
  const getAnchorRect = useCallback((): DOMRect | null => {
    if (at === null) return null
    return new DOMRect(at.x, at.y, 0, 0)
  }, [at])

  /** Save one file to disk. */
  const download = async (row: ContextTarget): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.download), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: row.relPath }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ name?: string; base64?: string; mime?: string }>(response)
      if (!response.ok || body.error !== undefined || body.base64 === undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      saveBase64(body.name ?? row.name, body.base64, body.mime ?? 'application/octet-stream')
      onClose()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Rename the row, keeping it in its directory. */
  const rename = async (row: ContextTarget): Promise<void> => {
    // A prompt rather than an inline editor: the tree is a dense list and an inline field
    // would reflow it. The starting value is the current name so a small edit is cheap.
    const next = window.prompt(t('renamePrompt'), row.name)
    if (next === null) { onClose(); return }
    const name = next.trim()
    if (name === '' || name === row.name) { onClose(); return }
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.rename), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: row.relPath, name }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      onClose()
      props.onRenamed()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('renameFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Remove the row into the caller's own trash. */
  const remove = async (row: ContextTarget): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.trashRemove), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `kind` lets the tombstone say a whole directory disappeared rather than a
        // file, which is what the trash page words its rows from.
        body: JSON.stringify({ relPath: row.relPath, kind: row.isDir ? 'directory' : 'file' }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      onClose()
      props.onDeleted()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Paste the clipboard entry into this row's directory.
   *
   * The route follows the clipboard's own flag, because those are the two different
   * promises the reader was made: a cut pastes through `move` and the source disappears,
   * a copy through `copy` and the source stays. Doing both with `move` would delete a
   * file the reader asked to duplicate. Both routes resolve the destination name from the
   * source path, so neither can rename, and both carry a directory's whole subtree.
   *
   * The refusal is surfaced rather than swallowed, because a paste that silently did
   * nothing is the one outcome a clipboard must not have.
   */
  const paste = async (): Promise<void> => {
    const clip = props.clipboard
    const into = props.pasteInto
    if (clip === null || into === null) return
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: clip.relPath, to: into }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      onClose()
      props.onMoved()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('pasteFailed'))
    } finally {
      setBusy(false)
    }
  }

  // The menu is positioned from the pointer and needs a row; the share dialog is a
  // separate overlay with its own lifetime, so it is rendered even when the menu has
  // already closed (which is exactly what choosing "Share" does). `row` is the
  // non-null view of the target the menu handlers close over.
  const menuOpen = target !== null && at !== null
  const row: ContextTarget | null = menuOpen ? target : null

  const clipboardEmpty = props.clipboard === null || props.pasteInto === null
  const items: MenuEntry[] = row !== null ? [
    // A directory has no bytes to save, so the row is absent rather than disabled: a
    // permanently disabled entry teaches the reader nothing.
    ...(row.isDir ? [] : [{ id: 'download', label: t('actionDownload'), disabled: busy }]),
    { id: 'rename', label: t('actionRename'), disabled: busy },
    { id: 'share', label: t('actionShare') },
    { id: 'favorite', label: props.favorite ? t('actionUnfavorite') : t('actionFavorite') },
    { type: 'separator', id: 'sep-clip' },
    { id: 'copy', label: t('actionCopy') },
    { id: 'cut', label: t('actionCut') },
    {
      id: 'paste',
      // Disabled with an empty clipboard, and when there is no known destination. The
      // label names what will be pasted, so a paste is never a surprise about content
      // or about where it went.
      label: clipboardEmpty
        ? t('actionPaste')
        : (props.clipboard?.cut === true ? t('actionPasteCut') : t('actionPasteCopy'))
          + ' ' + (props.clipboard?.name ?? ''),
      disabled: busy || clipboardEmpty,
    },
    { type: 'separator', id: 'sep-2' },
    { id: 'pin', label: props.pinned ? t('actionUnpin') : t('actionPin') },
    { id: 'reference', label: t('actionReference') },
    { type: 'separator', id: 'sep-3' },
    { id: 'grant', label: t('actionPermissions') },
    { id: 'delete', label: t('actionDelete'), danger: true, disabled: busy },
  ] : []

  return (
    <>
      <Menu
        open={menuOpen}
        anchor={<span />}
        items={items}
        onSelect={(id) => {
          // The menu only exists while `row` is set; this keeps the handlers typed
          // against a real target rather than re-checking at each branch.
          if (row === null) return
          if (id === 'download') { void download(row); return }
          if (id === 'rename') { void rename(row); return }
          if (id === 'share') {
            // Capture first: `onClose` clears the parent's target in the same commit.
            setShareTarget(row)
            onClose()
            return
          }
          if (id === 'favorite') { props.onFavorite(row.relPath, !props.favorite); onClose(); return }
          if (id === 'copy') {
            props.onClipboard({ relPath: row.relPath, name: row.name, cut: false })
            onClose()
            return
          }
          if (id === 'cut') {
            props.onClipboard({ relPath: row.relPath, name: row.name, cut: true })
            onClose()
            return
          }
          if (id === 'paste') { void paste(); return }
          if (id === 'pin') { props.onPin(row.relPath, !props.pinned); onClose(); return }
          if (id === 'reference') { props.onReference(row.relPath, row.isDir); onClose(); return }
          if (id === 'grant') { props.onGrant(row.relPath); onClose() }
          if (id === 'delete') { void remove(row) }
        }}
        onClose={onClose}
        portal
        getAnchorRect={getAnchorRect}
        side="bottom"
        align="start"
        autoFocus
      />
      {notice !== undefined && <p role="alert">{notice}</p>}
      <KnowledgeShareDialog
        relPath={shareTarget === null ? null : shareTarget.relPath}
        isDir={shareTarget?.isDir === true}
        copy={props.shareCopy}
        onClose={() => { setShareTarget(null) }}
        onShared={() => {
          setShareTarget(null)
          props.onRenamed()
        }}
      />
    </>
  )
}
