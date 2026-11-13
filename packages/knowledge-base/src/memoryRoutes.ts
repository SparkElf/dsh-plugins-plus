/**
 * HTTP seam for the memory management page (design §22).
 *
 * This module owns no routing and no identity: `index.ts` resolves the caller and
 * builds the per-user stores, then hands this function the method name, the parsed
 * JSON body and the three collaborators. It returns `{status, body}` so the route
 * switch only has to call `writeJson`. That split is what lets the payload contract
 * be tested without a live backend or an HTTP server.
 *
 * Scope rules:
 * - every method acts ONLY on the caller's own personal memory
 *   (`<actualRoot>/personal/<userId>/个人记忆图谱`); a `userId` in the body is
 *   refused, never trusted;
 * - the memory menu is a product surface over `MemoryStore`, so it uses the same
 *   validation, tombstone and privacy rules as the guardian;
 * - list rows NEVER expose the raw session id. `memory.get` includes it under
 *   `source.sessionId` only because the detail drawer needs it for 「查看原文」.
 *
 * Methods: `memory.list`, `memory.get`, `memory.update`, `memory.forget`,
 * `memory.settings`, `memory.set-enabled`.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-routes
 */

import type { MemoryGraphWriter } from './memoryGraphWriter.ts'
import {
  MemoryStore,
  MemoryStoreError,
  type ListedMemoryEntry,
  type MemoryEntryPatch,
} from './memoryStore.ts'
import { MemorySettingsStore } from './memorySettings.ts'
import {
  MemoryValidationError,
  isPrivacy,
  type AnyMemoryEntry,
  type MemoryType,
  type Privacy,
} from './memoryTypes.ts'
import { isSafeUserId } from './views.ts'

/** The identity the route already resolved from the request. */
export interface MemoryRouteCaller {
  userId: string
  label?: string
}

/** Collaborators the route builds for the caller; injected so tests need no Context. */
export interface MemoryRouteInput {
  method: string
  /** Parsed JSON body; methods without a body may omit it. */
  body?: unknown
  caller: MemoryRouteCaller
  store: MemoryStore
  settings: MemorySettingsStore
  /** Manifest reconciliation after a write/delete; failure never undoes the memory write. */
  graphWriter: Pick<MemoryGraphWriter, 'syncAll'>
}

/** One response the route switch can pass straight to `writeJson`. */
export interface MemoryRouteResponse {
  status: number
  body: Record<string, unknown>
}

/** One row of the memory table. Deliberately no session id. */
export interface MemoryListRow {
  id: string
  type: MemoryType
  /** Short human line (the detail drawer carries the full value). */
  title: string
  /** Display-only source snapshot: session title, then scenario, then app. */
  sourceLabel: string
  /** When the remembered thing happened; falls back to `createdAt`. */
  sourceTime: string
  privacy: Privacy
  updatedAt: string
  /** Document path relative to the memory root (`偏好.md`, `SOP/<slug>.md`, ...). */
  path: string
}

/** Normalized entry + source shape returned by get/update. */
export interface MemoryEntryPayload {
  entry: ListedMemoryEntry
  title: string
  content: string
  source: {
    label: string
    at: string
    eventSeqs?: number[]
    /** Internal locator for 「查看原文」; never rendered as text. */
    sessionId?: string
  }
}

const PATCH_FIELDS = new Set(['title', 'content', 'value', 'statement', 'solution', 'steps', 'privacy'])

/** Which single field `content` corrects, per memory type. SOP uses `steps`. */
const CONTENT_FIELD: Partial<Record<MemoryType, keyof MemoryEntryPatch>> = {
  preference: 'value',
  pitfall: 'solution',
  episodic: 'summary',
  fact: 'statement',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ok = (body: Record<string, unknown>): MemoryRouteResponse => ({ status: 200, body })

const fail = (status: number, error: string, code?: string, extra?: Record<string, unknown>): MemoryRouteResponse => ({
  status,
  body: { error, ...(code === undefined ? {} : { code }), ...extra },
})

/** One short line for the table; whitespace collapsed and bounded. */
function clipLine(value: string, max = 80): string {
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** A technical token that should never be the first thing a reader sees in a row. */
function looksTechnical(value: string): boolean {
  if (/[\\/]|session-|kb_[a-z]|\.md\b|\bSOP\b|[a-z]+_[a-z]+/iu.test(value)) return true
  // Long all-ASCII kebab/underscore tokens are internal identifiers, not titles.
  return value.trim().length > 12 && /^[a-z0-9._-]+$/u.test(value.trim())
}

/** Short, non-technical fallback for entries written before displayTitle existed. */
function fallbackTitle(entry: AnyMemoryEntry): string {
  switch (entry.type) {
    case 'preference':
      return clipLine(looksTechnical(entry.value) ? entry.topic : entry.value, 20)
    case 'pitfall':
      return looksTechnical(entry.errorSignature) ? '踩坑记录' : clipLine(entry.errorSignature, 20)
    case 'episodic': {
      if (entry.tags?.includes('SOP评估')) return '方法评估'
      if (entry.tags?.includes('SOP晋升')) return '方法晋升'
      if (entry.tags?.includes('idle')) return '空闲触发'
      if (entry.tags?.includes('compaction')) return '压缩触发'
      if (entry.tags?.includes('dream')) return '记忆整理'
      return '情景记录'
    }
    case 'fact':
      return looksTechnical(entry.key) ? '事实记录' : clipLine(entry.key, 20)
    case 'sop':
      return clipLine(entry.title, 20)
  }
}

/** The table's 「记忆」 column: a short user-facing title, never an internal id. */
function entryTitle(entry: AnyMemoryEntry): string {
  if (typeof entry.displayTitle === 'string' && entry.displayTitle.trim() !== '') {
    return clipLine(entry.displayTitle, 24)
  }
  return fallbackTitle(entry)
}

/** The detail drawer's editable content, in a type-appropriate shape. */
function entryContent(entry: AnyMemoryEntry): string {
  switch (entry.type) {
    case 'preference':
      return entry.value
    case 'pitfall':
      return entry.solution
    case 'episodic':
      return entry.summary
    case 'fact':
      return entry.statement
    case 'sop':
      return entry.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')
  }
}

/**
 * Display source label. The snapshot written at record time wins; then the
 * scenario/app the guardian knew; only then the neutral label. A raw session id is
 * never used as the label.
 */
function sourceLabelOf(entry: AnyMemoryEntry): string {
  const label = entry.sourceLabel?.trim()
  if (label !== undefined && label !== '') return label
  const scenario = entry.scenario?.trim()
  if (scenario !== undefined && scenario !== '') return scenario
  const app = entry.app?.trim()
  if (app !== undefined && app !== '') return app
  return '历史会话'
}

const sourceTimeOf = (entry: AnyMemoryEntry): string => entry.sourceTime ?? entry.createdAt
const updatedAtOf = (entry: AnyMemoryEntry): string => entry.updatedAt ?? entry.createdAt

/** Whitelist the list row so an internal field can never leak by spread. */
function listRow(entry: ListedMemoryEntry): MemoryListRow {
  return {
    id: entry.id,
    type: entry.type,
    title: entryTitle(entry),
    sourceLabel: sourceLabelOf(entry),
    sourceTime: sourceTimeOf(entry),
    privacy: entry.privacy,
    updatedAt: updatedAtOf(entry),
    path: entry.path,
  }
}

function entryPayload(entry: ListedMemoryEntry): MemoryEntryPayload {
  return {
    entry,
    title: entryTitle(entry),
    content: entryContent(entry),
    source: {
      label: sourceLabelOf(entry),
      at: sourceTimeOf(entry),
      ...(entry.sourceSeqs === undefined ? {} : { eventSeqs: entry.sourceSeqs }),
      ...(entry.sourceSession === undefined ? {} : { sessionId: entry.sourceSession }),
    },
  }
}

/** Ids are opaque but must never become a path or a directory traversal. */
function readEntryId(body: Record<string, unknown>): string | undefined {
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (id === '' || id.length > 200 || /[\s/\\\u0000]/u.test(id)) return undefined
  return id
}

const readNonEmptyString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value : undefined
)

/** Extract and validate the patch, translating the generic `content` alias. */
function readUpdatePatch(
  body: Record<string, unknown>,
  entry: ListedMemoryEntry,
): { patch: MemoryEntryPatch } | { error: MemoryRouteResponse } {
  if (Object.prototype.hasOwnProperty.call(body, 'userId')) {
    return { error: fail(400, 'userId must not be supplied; the caller is resolved from the request', 'invalid') }
  }
  const hasPatchObject = Object.prototype.hasOwnProperty.call(body, 'patch')
  if (hasPatchObject && !isRecord(body.patch)) {
    return { error: fail(400, 'patch must be an object', 'invalid') }
  }
  const source = hasPatchObject ? (body.patch as Record<string, unknown>) : body
  if (hasPatchObject) {
    const extra = Object.keys(body).filter(key => key !== 'id' && key !== 'patch')
    if (extra.length > 0) {
      return { error: fail(400, `unsupported update field(s): ${extra.join(', ')}`, 'invalid') }
    }
  } else {
    const extra = Object.keys(body).filter(key => key !== 'id' && !PATCH_FIELDS.has(key))
    if (extra.length > 0) {
      return { error: fail(400, `unsupported update field(s): ${extra.join(', ')}`, 'invalid') }
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'userId')) {
    return { error: fail(400, 'userId must not be supplied; the caller is resolved from the request', 'invalid') }
  }
  const unknown = Object.keys(source).filter(key => (
    !PATCH_FIELDS.has(key) && (hasPatchObject || key !== 'id')
  ))
  if (unknown.length > 0) {
    return { error: fail(400, `unsupported update field(s): ${unknown.join(', ')}`, 'invalid') }
  }

  const patch: MemoryEntryPatch = {}
  if (source.title !== undefined) {
    const title = readNonEmptyString(source.title)
    if (title === undefined) return { error: fail(400, 'title must be a non-empty string', 'invalid') }
    patch.title = title
  }
  if (source.content !== undefined) {
    const content = readNonEmptyString(source.content)
    if (content === undefined) return { error: fail(400, 'content must be a non-empty string', 'invalid') }
    const field = CONTENT_FIELD[entry.type]
    if (field === undefined) {
      return { error: fail(400, `content cannot be edited on a ${entry.type} entry; edit title or steps`, 'invalid') }
    }
    if (source[field] !== undefined) {
      return { error: fail(400, `content conflicts with ${String(field)}`, 'invalid') }
    }
    ;(patch as Record<string, unknown>)[String(field)] = content
  }
  if (source.value !== undefined) {
    const value = readNonEmptyString(source.value)
    if (value === undefined) return { error: fail(400, 'value must be a non-empty string', 'invalid') }
    patch.value = value
  }
  if (source.statement !== undefined) {
    const statement = readNonEmptyString(source.statement)
    if (statement === undefined) return { error: fail(400, 'statement must be a non-empty string', 'invalid') }
    patch.statement = statement
  }
  if (source.solution !== undefined) {
    const solution = readNonEmptyString(source.solution)
    if (solution === undefined) return { error: fail(400, 'solution must be a non-empty string', 'invalid') }
    patch.solution = solution
  }
  if (source.steps !== undefined) {
    const steps = source.steps
    if (!Array.isArray(steps) || steps.length === 0
      || steps.some(step => typeof step !== 'string' || step.trim() === '')) {
      return { error: fail(400, 'steps must be a non-empty array of non-empty strings', 'invalid') }
    }
    patch.steps = steps as string[]
  }
  if (source.privacy !== undefined) {
    if (!isPrivacy(source.privacy)) {
      return { error: fail(400, 'privacy must be normal, private, sensitive or secret', 'invalid') }
    }
    patch.privacy = source.privacy
  }
  return { patch }
}

/** Reconcile the personal-memory graph; a derived failure must not undo the write. */
async function syncGraph(graphWriter: Pick<MemoryGraphWriter, 'syncAll'>): Promise<string | undefined> {
  try {
    await graphWriter.syncAll()
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/** Map a store/validation failure to an actionable status; unknown errors escape. */
function failureOf(error: unknown): MemoryRouteResponse {
  if (error instanceof MemoryValidationError) {
    return fail(400, error.message, 'invalid-memory', { issues: error.issues })
  }
  if (error instanceof MemoryStoreError) {
    const status = error.code === 'not-found' || error.code === 'sop-not-found'
      ? 404
      : error.code === 'invalid-memory-file' || error.code === 'duplicate-id'
        || error.code === 'duplicate-key' || error.code === 'sop-exists' || error.code === 'sop-terminal'
        ? 409
        : 400
    return fail(status, error.message, error.code)
  }
  throw error
}

/**
 * Handle one memory-management method.
 *
 * The caller's identity is already resolved by the route; this function validates
 * it once more before touching the filesystem and never accepts a body-supplied
 * user id. Expected failures return a status/body; unexpected failures throw so the
 * route's outer `try` reports a real 500 instead of a misleading 400.
 */
export async function handleMemoryRoute(input: MemoryRouteInput): Promise<MemoryRouteResponse> {
  const { method, caller, store, settings, graphWriter } = input
  if (!isSafeUserId(caller.userId)) {
    return fail(403, 'unsafe caller id; memory is scoped to the authenticated user', 'forbidden')
  }
  const body = isRecord(input.body) ? input.body : {}

  try {
    switch (method) {
      case 'memory.list': {
        const [enabled, entries] = await Promise.all([settings.isEnabled(caller.userId), store.listEntries()])
        return ok({ enabled, entries: entries.map(listRow) })
      }

      case 'memory.get': {
        const id = readEntryId(body)
        if (id === undefined) return fail(400, 'a safe entry id is required', 'invalid')
        const entry = await store.getEntry(id)
        if (entry === undefined) return fail(404, 'memory entry not found', 'not-found')
        return ok(entryPayload(entry) as unknown as Record<string, unknown>)
      }

      case 'memory.update': {
        const id = readEntryId(body)
        if (id === undefined) return fail(400, 'a safe entry id is required', 'invalid')
        const entry = await store.getEntry(id)
        if (entry === undefined) return fail(404, 'memory entry not found', 'not-found')
        const built = readUpdatePatch(body, entry)
        if ('error' in built) return built.error
        const updated = await store.updateEntry(id, built.patch)
        const graphSyncWarning = await syncGraph(graphWriter)
        return ok({
          ...entryPayload(updated) as unknown as Record<string, unknown>,
          ...(graphSyncWarning === undefined ? {} : { graphSyncWarning }),
        })
      }

      case 'memory.forget': {
        const id = readEntryId(body)
        if (id === undefined) return fail(400, 'a safe entry id is required', 'invalid')
        const forgotten = await store.forgetEntry(id)
        const graphSyncWarning = forgotten.removed ? await syncGraph(graphWriter) : undefined
        return ok({
          ...forgotten,
          ...(graphSyncWarning === undefined ? {} : { graphSyncWarning }),
        })
      }

      case 'memory.settings':
        return ok({ enabled: await settings.isEnabled(caller.userId) })

      case 'memory.set-enabled': {
        if (typeof body.enabled !== 'boolean') {
          return fail(400, 'enabled must be a boolean', 'invalid')
        }
        const next = await settings.setEnabled(caller.userId, body.enabled)
        return ok({ enabled: next.memoryEnabled })
      }

      default:
        return fail(404, `unknown memory method: ${method}`, 'not-found')
    }
  } catch (error) {
    return failureOf(error)
  }
}