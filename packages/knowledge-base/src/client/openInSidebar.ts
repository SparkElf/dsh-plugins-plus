/**
 * Open a knowledge document in the product's own right-hand file window.
 *
 * The knowledge page does not draw a document preview of its own. Opening a document
 * hands it to the host's sidebar, which is the surface every other file in the
 * workspace opens into: tab strip, path input, preview/edit toggle, save, refresh,
 * outline. The knowledge page owns none of that chrome.
 *
 * Two host services are involved, both published before any panel mounts:
 *
 * - `sidebarRight` (`ui-sidebar-right`) owns the column. Its `openResource` claims the
 *   address, places it, and **reveals the column in the same step** -- the column
 *   expands as part of opening, so a document handed to it cannot land in a collapsed
 *   panel the reader never sees.
 * - `sidebarRightTabs` is the tab-type registry, whose ranking decides which kind
 *   claims a file address. Asking it keeps this open on the host's normal path instead
 *   of hard-coding a kind.
 *
 * The address is built with the official `fileAddressFor`, so a document opened from
 * here dedupes against the tab the chat file-link path already opened for the same
 * file rather than opening a second tab onto it.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { absoluteFileAddress } from 'dsh-better-sidebar/src/client/resource-address.ts'

/**
 * The slice of the host's right-sidebar controller this module calls.
 *
 * Declared structurally: the plugin receives `ctx` as an opaque object and only uses
 * `get`, so naming the single method keeps the dependency honest without importing the
 * host package (which is not in the platform module allowlist anyway).
 */
interface RightColumnOpener {
  openResource?: (address: string, options?: unknown) => void
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}

/**
 * The slice of the layout service this module drives.
 *
 * The column's own state machine decides whether it is on screen, but the *track*
 * (the width it occupies in the frame) is reported by the layout. Closing the track is
 * what returns the page to its full width; hiding a tab is not the same operation, so
 * the column interface above cannot do it.
 */
interface LayoutCloser {
  closeRightbar?: () => void
}

/** The slice of the sidebar tab registry this module probes. */
interface TabRegistryProbe {
  candidates?: (address: string) => readonly { readonly kind?: string }[]
}

/** What the context lookup needs. */
interface ContextLike {
  get?: (name: string) => unknown
}

/** Outcome of asking the host to show a document. */
export type OpenOutcome =
  | 'opened'
  | 'no-context'
  | 'no-registry'
  | 'unclaimed'
  | 'no-column'

/**
 * Ask the host to open a document in its right-hand file window.
 *
 * @param ctx - the client context the page was injected with.
 * @param sessionId - the conversation the sidebar column is scoped to.
 * @param cwd - the session's workspace root, used to shorten the address to a
 *   session-relative one so it dedupes against chat-opened tabs.
 * @param absolutePath - the document's absolute path inside the workspace.
 * @returns Why it did or did not open; the caller reports the failure rather than
 *   appearing to do nothing.
 */
export function openInSidebar(
  ctx: unknown,
  sessionId: string | undefined,
  cwd: string | undefined,
  absolutePath: string,
): OpenOutcome {
  if (sessionId === undefined || absolutePath === '') return 'no-context'
  const context = ctx as ContextLike | undefined
  if (typeof context?.get !== 'function') return 'no-context'

  const registry = context.get('sidebarRightTabs') as TabRegistryProbe | undefined
  if (registry === undefined || typeof registry.candidates !== 'function') return 'no-registry'

  // Address the document by its ABSOLUTE path, never by its spelling relative to the
  // session's cwd.
  //
  // The host resolves a session-relative address against whatever cwd the session
  // currently holds (`resolveSidebarPath`), and that cwd is not stable: opening a group
  // chat moves it to the room's directory. A document addressed as `kb/a.md` then
  // resolves under the room (`/workspace/group-chat-data/<room>/kb/a.md`) and the read
  // fails with ENOENT -- for a file that exists the whole time. An absolute address
  // carries the path the page already resolved and is returned as-is, so no cwd can
  // redirect it.
  const address = absoluteFileAddress(absolutePath)
  const best = registry.candidates(address)[0]
  if (best === undefined || best.kind === undefined) return 'unclaimed'

  const column = context.get('sidebarRight') as RightColumnOpener | undefined
  if (column === undefined || typeof column.openResource !== 'function') return 'no-column'

  // Reveal FIRST, then open. The column's own state machine keys "shown" on the
  // per-session `layout.expanded` flag, and that flag is not inherited across a
  // global panel switch: a reader who had the column open in the conversation sees it
  // collapsed again on this page, so `openResource` on its own would place content in
  // a track of width 0. Expanding first is the same control the host's own expand
  // button drives, and it is idempotent -- only called when the column reports
  // itself collapsed, so an already-open column is never toggled shut.
  if (typeof column.isExpanded === 'function' && column.isExpanded() === false) {
    column.toggleExpanded?.()
  }
  column.openResource(address)
  return 'opened'
}

/**
 * Return the right column's width to the page.
 *
 * Called when the knowledge page stops showing a document. It is deliberately separate
 * from {@link openInSidebar} rather than a mode flag: the two states need different
 * frames, and closing the track is what restores the page's own width. A host without
 * the layout service is left alone -- the page simply keeps whatever it had.
 * @param ctx - the client context the page runs in.
 */
/**
 * Report whether the host's right column is currently expanded.
 *
 * The page uses this to decide whether it may keep its own content column: a document
 * opened in the reader means the page's column is redundant, but only while the reader
 * is actually on screen. Reading it live (instead of tracking it in React state) keeps
 * the page and the frame from disagreeing when the reader closes the column themselves.
 * A host without the column service reports `false`, which keeps the page's own layout.
 * @param ctx - the client context the page runs in.
 * @returns whether the column is expanded right now.
 */
export function readColumnExpanded(ctx: unknown): boolean {
  const context = ctx as ContextLike | undefined
  if (typeof context?.get !== 'function') return false
  try {
    const column = context.get('sidebarRight') as RightColumnOpener | undefined
    return column?.isExpanded?.() === true
  } catch {
    return false
  }
}

export function closeSidebar(ctx: unknown): void {
  const context = ctx as ContextLike | undefined
  if (typeof context?.get !== 'function') return

  // Two separate pieces of host state have to go back, and closing only one of them
  // leaves the page in the very state this function exists to prevent:
  //
  // - `layout.closeRightbar()` removes the frame's third track.
  // - `sidebarRight.toggleExpanded()` collapses the column itself.
  //
  // The column's `isExpanded()` reads its own expanded flag, NOT the track width. So a
  // close that only hides the track leaves `isExpanded()` answering true, the page keeps
  // believing a reader is on screen, and its content column stays suppressed -- which is
  // exactly the blank column a reader sees after returning to the list.
  try {
    const layout = context.get('layout') as LayoutCloser | undefined
    layout?.closeRightbar?.()
  } catch {
    // A layout that refuses to close is not an error the reader needs to see; the
    // column collapse below still returns the page's own width.
  }
  try {
    const column = context.get('sidebarRight') as RightColumnOpener | undefined
    // Only collapse when it reports itself expanded: the toggle is bidirectional, so an
    // unconditional call would OPEN a column the reader had already dismissed.
    if (column?.isExpanded?.() === true) column.toggleExpanded?.()
  } catch {
    // Same rationale: refusal here is not the reader's problem.
  }
}

/** Whether a failure means the host's right column is simply not on this profile. */
export function isHostMissing(outcome: OpenOutcome): boolean {
  return outcome === 'no-context' || outcome === 'no-registry' || outcome === 'no-column'
}
