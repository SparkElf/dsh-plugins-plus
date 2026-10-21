/**
 * The progress strip's two decisions, kept out of the component.
 *
 * Both are answers about data rather than about React: whether a batch is finished, and
 * whether a retry button would help. They live here because a `.tsx` module that imports
 * the UI primitives cannot be loaded by the test runner (the primitives package imports
 * CSS at module scope, which the runner cannot resolve), so a test that imported the
 * component would fail before reaching any assertion.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/**
 * Whether a retry button would help for this state.
 *
 * Only a failure is worth retrying. `unsupported` means no extractor exists for the
 * type, so a retry fails identically and the button would be a lie; the pending and
 * running states are already being handled.
 * @param state - the extraction state.
 * @returns Whether to offer a retry.
 */
export function canRetryExtraction(state: string): boolean {
  return state === 'failed'
}

/**
 * A failure reason that survives a response which is not JSON.
 *
 * A gateway answering 502 sends HTML, and `response.json()` rejects on it. If that
 * rejection escaped, the row would report "failed" with no reason at all -- which is
 * exactly the silence this strip exists to remove. So the body is attempted, and an
 * unreadable body falls back to the status code, which still tells the reader whether
 * the server refused them (4xx) or broke (5xx).
 * @param body - the parsed body, when it parsed.
 * @param status - the HTTP status.
 * @returns A sentence a reader can act on.
 */
export function failureReason(body: { error?: unknown; code?: unknown } | undefined, status: number): string {
  if (typeof body?.error === 'string' && body.error !== '') return body.error
  if (body?.code === 'too-large') return 'file is too large'
  if (status === 413) return 'file is too large'
  if (status === 409) return 'the knowledge base is not configured'
  if (status === 403) return 'write access is required here'
  if (status >= 500) return 'the server failed while writing the file (HTTP ' + String(status) + ')'
  return 'the upload was refused (HTTP ' + String(status) + ')'
}

/** The strip's height bounds, in pixels. */
export const PROGRESS_MIN_HEIGHT = 44
export const PROGRESS_DEFAULT_HEIGHT = 180
/** The share of the panel's height the strip may take, leaving the tree the rest. */
export const PROGRESS_MAX_SHARE = 0.6

/**
 * Clamp a dragged height into the strip's legal range.
 *
 * The upper bound is a share of the PANEL, not a constant: the strip must never grow
 * until the file tree is unreachable, and how much room that is depends on how tall the
 * panel currently is. A 600px panel and a 1200px panel therefore allow different
 * maximums, which is what keeps the tree visible on both.
 * @param desired - the height the pointer asked for.
 * @param panelHeight - the panel's own height, when known.
 * @returns The height to use.
 */
export function clampProgressHeight(desired: number, panelHeight: number | undefined): number {
  const shareMax = panelHeight === undefined || panelHeight <= 0
    ? PROGRESS_DEFAULT_HEIGHT * 2
    : Math.floor(panelHeight * PROGRESS_MAX_SHARE)
  const max = Math.max(PROGRESS_MIN_HEIGHT, shareMax)
  if (!Number.isFinite(desired)) return PROGRESS_DEFAULT_HEIGHT
  return Math.min(max, Math.max(PROGRESS_MIN_HEIGHT, Math.round(desired)))
}
