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
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'

/** One row the menu can act on. */
export interface ContextTarget {
  /** Path relative to the knowledge root. */
  relPath: string
  /** Display name, used as the rename dialog's starting value. */
  name: string
  /** Whether the row is a directory (renaming one renames the directory). */
  isDir: boolean
}

/** Props for the context menu. */
export interface KnowledgeContextMenuProps {
  /** The row the menu is open on, or null when closed. */
  target: ContextTarget | null
  /** Where the pointer was, in viewport coordinates. */
  at: { x: number; y: number } | null
  /** Copy resolver for this package's namespace. */
  t: (key: string) => string
  /** Close the menu. */
  onClose: () => void
  /** Open the permission surface for this path. */
  onGrant: (path: string) => void
  /** Toggle the pin state for this path. */
  onPin: (path: string, pinned: boolean) => void
  /** Whether this path is currently pinned. */
  pinned: boolean
  /** Insert a reference to this path into the conversation. */
  onReference: (path: string, isDir: boolean) => void
  /** Called after a rename succeeds, so the page reloads the tree. */
  onRenamed: () => void
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

  if (target === null || at === null) return null

  const items: MenuEntry[] = [
    // A directory has no bytes to save, so the row is absent rather than disabled: a
    // permanently disabled entry teaches the reader nothing.
    ...(target.isDir ? [] : [{ id: 'download', label: t('actionDownload'), disabled: busy }]),
    { id: 'rename', label: t('actionRename'), disabled: busy },
    { type: 'separator', id: 'sep-1' },
    { id: 'pin', label: props.pinned ? t('actionUnpin') : t('actionPin') },
    { id: 'reference', label: t('actionReference') },
    { type: 'separator', id: 'sep-2' },
    { id: 'grant', label: t('actionPermissions') },
  ]

  return (
    <>
      <Menu
        open
        anchor={<span />}
        items={items}
        onSelect={(id) => {
          if (id === 'download') { void download(target); return }
          if (id === 'rename') { void rename(target); return }
          if (id === 'pin') { props.onPin(target.relPath, !props.pinned); onClose(); return }
          if (id === 'reference') { props.onReference(target.relPath, target.isDir); onClose(); return }
          if (id === 'grant') { props.onGrant(target.relPath); onClose() }
        }}
        onClose={onClose}
        portal
        getAnchorRect={getAnchorRect}
        side="bottom"
        align="start"
        autoFocus
      />
      {notice !== undefined && <p role="alert">{notice}</p>}
    </>
  )
}
