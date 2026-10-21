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
 * Whether the strip may fold now.
 *
 * Folded means "one summary line instead of a list". It folds when every task in both
 * groups reached a terminal state AND the batch has not been folded before -- the
 * second half is what stops it re-folding after a reader expanded a finished batch to
 * read which file failed.
 * @param uploads - the current batch's rows.
 * @param extractions - the extraction tasks the Host reports.
 * @param alreadyFolded - whether a fold already happened for this batch.
 * @returns Whether to fold.
 */
export function shouldFoldStrip(
  uploads: readonly { state: string }[],
  extractions: readonly { state: string }[],
  alreadyFolded: boolean,
): boolean {
  if (alreadyFolded) return false
  const uploadSettled = uploads.length === 0
    || uploads.every(task => task.state === 'done' || task.state === 'failed')
  const extractSettled = extractions.length === 0
    || extractions.every(task => task.state === 'succeeded' || task.state === 'failed' || task.state === 'unsupported')
  return uploadSettled && extractSettled
}

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
