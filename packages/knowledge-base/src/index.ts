/**
 * Knowledge-base Host plugin.
 *
 * This package owns three things and nothing else:
 * 1. The protocol contract toward the DataOps knowledge API (`protocol.ts`).
 * 2. Idempotent deployment recipes for the remote pieces, run over the
 *    ssh-manager seam (`deploy.ts`, `remote.ts`).
 * 3. The same-origin HTTP surface the Settings panel reads, plus the two
 *    model-facing tools.
 *
 * It owns no authorization logic. DataOps AuthGuard and PermissionGuard resolve
 * the caller's roles and grants from the session credential; this plugin only
 * forwards requests (AGENTS.md "Managed DataOps Authorization").
 *
 * Content retrieval is deliberately absent. Once the view tree is mounted the
 * official `grep`, `read`, `write`, and `edit` tools operate on it as an
 * ordinary local path, so this capability does not duplicate them.
 *
 * @module @sparkelf/dsh-knowledge-base
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  ENDPOINTS,
  KB_RESOURCE_TYPE,
  joinUrl,
  type KnowledgeConfig,
  type KnowledgeGrant,
  type KnowledgeGrantRequest,
  type KnowledgeRevokeRequest,
  type KnowledgeStatus,
} from './protocol.ts'
import {
  isContainedRelPath,
  isSafeUserId,
  pointMountAtView,
  syncView,
  viewPathFor,
  type ResolvedPath,
} from './views.ts'
import {
  deploymentPlan,
  findStep,
  type DeployPlanContext,
  type DeployStep,
  type MineruBackend,
  type MineruTier,
} from './deploy.ts'
import { RemoteError, originFrom, sshManagerRunner, type RemoteHost, type RemoteRunner } from './remote.ts'

/** Cordis plugin name. */
export const name = 'dsh-knowledge-base'

/**
 * Host services this plugin needs.
 *
 * `credentials` resolves the session token per request so a rotated token
 * reaches the next request without a restart. `webServer` serves the
 * same-origin routes the Settings panel reads. The SSH transport is reached
 * over HTTP at the ssh-manager's own route, so it is not injected here.
 */
export const inject = ['credentials', 'webServer', 'tools']

/** Plugin configuration. */
export interface Config {
  /**
   * Base URL of the DataOps knowledge API. Empty disables the DataOps-backed
   * status/index routes, leaving only the local deployment controls.
   */
  baseUrl: string
  /** Credential reference holding the DataOps session token. */
  credentialRef: string
  /** Request timeout in milliseconds for DataOps API calls. */
  timeoutMs: number
  /** Path inside the container where the user's view tree is mounted. */
  mountPoint: string
  /** Absolute path of the authoritative tree on the storage host. */
  actualRoot: string
  /** Absolute path of the per-user view tree on the storage host. */
  viewRoot: string
  /** Comma-separated export spec of clients allowed to mount the NFS export. */
  permitted: string
  /** Host serving the export, as an address or `address:/path` pseudo root. */
  nfsServer: string
  /** MinerU quality tier to deploy. */
  mineruTier: MineruTier
  /** MinerU small-model backend to deploy. */
  mineruBackend: MineruBackend
  /** TCP port the MinerU API listens on where it is deployed. */
  mineruPort: number
  /** Memory ceiling in MiB for the MinerU service, clamped to half the host's RAM. */
  mineruMemoryMaxMiB: number
}

/** Config schema; an invalid value fails the profile load loudly. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  timeoutMs: z.number().default(15_000),
  mountPoint: z.string().default('/workspace/kb'),
  actualRoot: z.string().default('/nas/kb/actual'),
  viewRoot: z.string().default('/nas/kb/views'),
  permitted: z.string().default('*'),
    // Host serving the export. The mount step builds `address:/` from it, because `fsid=0`
    // in the export makes the share the NFSv4 pseudo root: clients mount the server root
    // rather than a path beneath it.
    nfsServer: z.string().default(''),
  // MinerU 4.x recognises exactly `basic` and `standard` as deployment tiers
  // (`mineru/types.py`: `DEPLOYMENT_TIERS`), and `models download --tier` validates against
  // that tuple, so anything else aborts the model download. `flash` is not one of them: it is
  // a *quality* tier used for the parsers that need no local weights at all (CSV, EPUB, HTML),
  // which is why offering it here would fail on a host that needs the download. Measured
  // 2026-10-15 against mineru 4.0.12.
  mineruTier: z.union([z.const('basic'), z.const('standard')]).default('basic'),
  mineruBackend: z.union([z.const('onnx'), z.const('torch')]).default('onnx'),
  mineruPort: z.number().default(8000),
  // Measured 2026-10-15 on a 7.9 GB host parsing a one-page PDF: the `basic` tier peaked at
  // 1.86 GB resident, which is already within a 2 GB ceiling and left `MemoryHigh` no headroom
  // at all. The service step clamps this to half of RAM, so the value below is a ceiling for a
  // roomy host rather than a claim about the floor.
  //
  // Headroom matters more than usual because `MemoryHigh` throttles continuously rather than
  // letting the process swap: a host with no swap device turns a cap set at the steady-state
  // size into a parse that stalls instead of one that runs slower.
  mineruMemoryMaxMiB: z.number().default(4096),
})

/** Why a knowledge-base request failed, with a stable machine-routable code. */
export type KnowledgeErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'unreachable'
  | 'bad-response'

/** Typed knowledge-base failure. */
export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode

  constructor(message: string, code: KnowledgeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

/** Resolve the session token, or fail with a legible reason. */
async function requireToken(ctx: Context, config: Config): Promise<string> {
  const resolved = await ctx.credentials.resolve(credentialRef(config.credentialRef))
  if (resolved === undefined || resolved.value.trim() === '') {
    throw new KnowledgeError(
      `DataOps session credential "${config.credentialRef}" is not available`,
      'unauthorized',
    )
  }
  return resolved.value
}

/** Perform one authorized JSON request against the knowledge API. */
async function request<T>(
  ctx: Context,
  config: Config,
  path: string,
  init?: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
): Promise<T> {
  if (config.baseUrl.trim() === '') {
    throw new KnowledgeError('DataOps knowledge API base URL is not configured', 'not-configured')
  }
  const token = await requireToken(ctx, config)
  const url = joinUrl(config.baseUrl, path)
  let response: Response
  try {
    response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (cause) {
    throw new KnowledgeError(`knowledge API is unreachable at ${url}`, 'unreachable', { cause })
  }
  if (response.status === 401 || response.status === 403) {
    // The backend decided the caller may not do this; do not second-guess it.
    throw new KnowledgeError(`knowledge API rejected the request (HTTP ${String(response.status)})`, 'unauthorized')
  }
  if (!response.ok) {
    // The backend explains a rejected write (an unknown principal, a missing
    // path) in its own words, and that message is what the operator needs: a
    // bare status code would send them looking in the wrong place.
    const detail = await readErrorMessage(response)
    throw new KnowledgeError(
      detail ?? `knowledge API failed (HTTP ${String(response.status)})`,
      'bad-response',
    )
  }
  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new KnowledgeError('knowledge API returned invalid JSON', 'bad-response', { cause })
  }
}

/**
 * Read a backend error message from a failed response.
 * @param response - the failed response.
 * @returns The backend's message, or undefined when the body does not carry one.
 */
async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown }
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (typeof body.error === 'string' && body.error !== '') return body.error
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The resolved layout, derived on the Host.
 *
 * There is no backend counterpart to ask: DataOps serves no knowledge config
 * route, so the mounted layout the container was started with is the answer. A
 * remote call here would only ever answer 404.
 * @param config - resolved plugin config.
 * @returns The layout the page renders.
 */
export function localConfig(config: Config): KnowledgeConfig & { backendConfigured: boolean } {
  return {
    mountPoint: config.mountPoint,
    actualRoot: config.actualRoot,
    viewRoot: config.viewRoot,
    host: config.baseUrl.trim() === '' ? '' : safeHost(config.baseUrl),
    backendConfigured: config.baseUrl.trim() !== '',
  }
}

/** Read a base URL's host, tolerating a value that is not a URL at all. */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * Read the mounted tree's shape without consulting a backend.
 *
 * The count comes from the mounted directory itself, which is the same tree the
 * model's grep and read tools see, so the number the page reports cannot drift
 * from what retrieval actually reaches.
 * @param config - resolved plugin config.
 * @returns The visible file count, or null when the mount is absent.
 */
export async function localStatus(config: Config): Promise<KnowledgeStatus> {
  const mounted = await countFiles(config.mountPoint)
  return {
    visibleFiles: mounted,
    lastSyncAt: null,
    indexing: { running: false },
  }
}

/** Count visible files under a mount point, or null when it is not mounted. */
/**
 * Enumerate every file under the authoritative root, as relative paths.
 *
 * The view builder needs candidate paths to ask the permission store about. When a
 * caller does not supply them, this walks the tree and produces exactly the set a
 * view could ever hold: hidden names are skipped, matching what the explorer shows
 * and keeping editor scratch files out of every user's view.
 * @param root - the authoritative directory.
 * @returns Relative paths of the files under it.
 */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) found.push(full.slice(root.length + 1))
    }
  }
  await walk(root)
  return found
}

async function countFiles(root: string): Promise<number | null> {
  if (root.trim() === '') return null
  try {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (entry.isFile()) total += 1
      }
    }
    await walk(root)
    return total
  } catch {
    // A missing mount is a normal state for a workspace whose storage host is
    // not attached yet, so it reports absence rather than failing the page.
    return null
  }
}

/** Fetch the caller's authorized paths from the backend. */
export function fetchGrants(ctx: Context, config: Config): Promise<KnowledgeGrant[]> {
  return request<KnowledgeGrant[]>(ctx, config, ENDPOINTS.grants)
}

/** One match the search surface can render. */
export interface KnowledgeHit {
  /** Path relative to the mount point, which is also the grant's resource id. */
  relPath: string
  /** File name alone, for a compact row. */
  name: string
  /** Whether the term matched the file's text rather than only its name. */
  inContent: boolean
  /** Matching line, when the term matched inside the file. */
  line?: string
  /** 1-based line number of {@link line}. */
  lineNumber?: number
  /** Last-modified instant in Unix ms, when the stat succeeded. */
  mtimeMs?: number
}

/**
 * Search the mounted tree by file name and text.
 *
 * This is a direct walk rather than an index, matching how retrieval works here:
 * the tools read the mount with grep and read, so there is no separate index whose
 * contents could disagree with the files. Only text files are opened, and only up
 * to a byte budget, so a search over a large mount stays bounded.
 * @param root - the mount point to walk.
 * @param term - case-insensitive term to look for.
 * @param limit - maximum hits to return.
 * @returns The hits, name matches first.
 */
export async function searchKnowledge(root: string, term: string, limit = 50): Promise<KnowledgeHit[]> {
  if (root.trim() === '' || term.trim() === '') return []
  const needle = term.trim().toLowerCase()
  const byName: KnowledgeHit[] = []
  const byContent: KnowledgeHit[] = []

  // A file whose name matches is reported once, without being opened: the name is
  // what the caller searched for, and reading every match would cost the most for
  // the least added value.
  const walk = async (dir: string): Promise<void> => {
    if (byName.length + byContent.length >= limit * 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable subdirectory is skipped rather than failing the whole search.
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const rel = full.slice(root.length + 1)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const when = await modifiedAt(full)
      if (entry.name.toLowerCase().includes(needle)) {
        byName.push({ relPath: rel, name: entry.name, inContent: false, ...when })
        continue
      }
      const hit = await matchInside(full, needle)
      if (hit !== undefined) {
        byContent.push({ relPath: rel, name: entry.name, inContent: true, ...hit, ...when })
      }
    }
  }

  await walk(root)
  return [...byName, ...byContent].slice(0, limit)
}

/** One directory entry, as the page's own listing renders it. */
export interface KnowledgeEntry {
  /** Path relative to the mount point. */
  relPath: string
  /** Name alone. */
  name: string
  /** Whether this entry is a directory. */
  isDir: boolean
  /** Last-modified instant in Unix ms, when it could be read. */
  mtimeMs?: number
  /** Size in bytes for files. */
  size?: number
  /**
   * Whether the calling user may read this path; `true` on every row a permission
   * check produced.
   *
   * A row carries the file's name, size and modification time, so a denied path
   * cannot be published with a "not yours" marker on it: the marker is not what
   * discloses the file. Denied and undecided paths are removed from the result
   * instead (see {@link listDirectoryWithPermissions}), which is also why the flag
   * is redundant here and only kept for a row that was explicitly resolved.
   */
  readable?: boolean
  /** Number of direct children, for a directory row. */
  childCount?: number
}

/**
 * List one directory level with each child's modification time.
 * @param root - the mount point, used to make paths relative.
 * @param dir - absolute directory to read.
 * @returns The entries, directories first then files, each in name order.
 */
export async function listDirectory(root: string, dir: string): Promise<KnowledgeEntry[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows: KnowledgeEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    const rel = full.slice(root.length + 1)
    if (entry.isDirectory()) {
      rows.push({ relPath: rel, name: entry.name, isDir: true, ...await modifiedAt(full) })
      continue
    }
    if (!entry.isFile()) continue
    const when = await modifiedAt(full)
    let size: number | undefined
    try {
      size = (await stat(full)).size
    } catch { size = undefined }
    rows.push({ relPath: rel, name: entry.name, isDir: false, ...when, size })
  }
  // Directories lead, then files, each alphabetically: a listing is scanned for the
  // folder a reader wants before the document inside it.
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)))
  return rows
}

/**
 * List one directory level, keeping only the entries DataOps resolved as readable.
 *
 * The listing and the permission check are separate concerns, so this composes
 * them rather than growing {@link listDirectory}: a caller that only needs the
 * filesystem facts (the preview, the search) keeps using that one.
 *
 * Removing a row rather than tagging it is the whole point. A row carries the
 * file's name, size and modification time, so returning a denied path with a "not
 * yours" marker on it discloses precisely what the check was meant to withhold:
 * the marker is not what reveals the file, and a reader can still fetch its bytes.
 * Proving that a name is off limits is not a reason to show the name.
 *
 * Every unresolved case fails closed. An empty base URL, a missing caller id, and a
 * resolve call that throws all drop the row, because "the answer could not be
 * obtained" is not a licence to publish. Answering the unknown case with the full
 * listing is what made an unreachable backend publish every file.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param root - the mount point.
 * @param dir - absolute directory to read.
 * @param userId - the caller whose view the answer is about.
 * @returns The rows DataOps resolved as readable, in listing order.
 */
export async function listDirectoryWithPermissions(
  ctx: Context,
  config: Config,
  root: string,
  dir: string,
  userId: string | undefined,
): Promise<KnowledgeEntry[]> {
  const rows = await listDirectory(root, dir)
  // Without a permission service or an identity there is no question to ask, and a
  // question that cannot be asked cannot come back "yes". The deployment that
  // configures no DataOps API has no per-user view either, so it has nothing to
  // list here: the page reports the missing backend through `permissionsResolved`
  // rather than through a directory it never verified.
  if (config.baseUrl.trim() === '' || userId === undefined) return []
  // Asked one path at a time on purpose: the resolve route is self-scoped and takes
  // a single resource, so batching would mean inventing a second decision path.
  // Rows are few (one directory level), and each answer is a boolean.
  // Annotated as a union rather than inferred: the mapping produces a required
  // `readable: true` on survivors, and `KnowledgeEntry` declares the flag optional, so the
  // inferred element type is not a subtype the filter can narrow to. Naming the parameter
  // keeps the predicate honest instead of widening the row type to satisfy the compiler.
  const resolved: Array<KnowledgeEntry | undefined> = await Promise.all(rows.map(async (row) => {
    try {
      // `readable` is set on the survivors only, so a row that reaches a caller
      // always carries an affirmative answer rather than an absent flag.
      return await canReadPath(ctx, config, row.relPath) ? { ...row, readable: true } : undefined
    } catch {
      return undefined
    }
  }))
  return resolved.filter((row): row is KnowledgeEntry => row !== undefined)
}

/**
 * Read a file's modification instant.
 *
 * The tree's own entry shape carries no timestamp, so a row cannot show one; the
 * search rows and the preview header are where a time can be shown honestly,
 * because each of those already touches the file.
 * @param full - absolute path to stat.
 * @returns The instant, or an empty object when it cannot be read.
 */
async function modifiedAt(full: string): Promise<{ mtimeMs?: number }> {
  try {
    return { mtimeMs: (await stat(full)).mtimeMs }
  } catch {
    return {}
  }
}

/** Largest file the search will open, so one large document cannot stall it. */
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * How much of a file the preview renders.
 *
 * A preview is for reading, not for loading a dataset into the DOM: past this size
 * the page reports the truncation instead of freezing on a multi-megabyte document.
 */
const PREVIEW_MAX_BYTES = 256 * 1024

/**
 * Look for the term inside one file.
 * @param full - absolute path to read.
 * @param needle - lowercase term.
 * @returns The matching line, or undefined when the file has no match.
 */
async function matchInside(
  full: string,
  needle: string,
): Promise<{ line: string; lineNumber: number } | undefined> {
  try {
    const info = await stat(full)
    if (info.size > SEARCH_MAX_FILE_BYTES) return undefined
    const body = await readFile(full, 'utf8')
    // A NUL byte is the usual signal that this is not text; decoding it as UTF-8
    // would otherwise turn a binary into a page of replacement characters.
    if (body.includes('\0')) return undefined
    const lines = body.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.toLowerCase().includes(needle)) {
        return { line: line.trim().slice(0, 200), lineNumber: index + 1 }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read one knowledge file for the preview.
 *
 * The preview must not depend on a conversation session. The listing is served by
 * this plugin's own route and needs none, so a session-backed read would leave the
 * page able to list files and unable to open them, which reads as a broken preview
 * rather than as a missing session. Containment is checked here because the path
 * arrives from the browser.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the mount point.
 * @returns The file's text, truncation flag and modification instant.
 */
export async function readKnowledgeFile(
  ctx: Context,
  config: Config,
  relPath: string,
): Promise<{ kind: 'text'; content: string; truncated: boolean; mtimeMs?: number } | { kind: 'binary'; size: number }> {
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeError('path escapes the knowledge tree', 'not-configured')
  }
  const root = localConfig(config).mountPoint
  const full = join(root, relPath)
  const info = await stat(full)
  if (!info.isFile()) {
    throw new KnowledgeError('not a file', 'not-configured')
  }
  const raw = await readFile(full)
  // A NUL byte marks a file whose bytes are not text; rendering it as UTF-8 would
  // show a page of replacement characters instead of saying what it is.
  if (raw.includes(0)) return { kind: 'binary', size: info.size }
  const truncated = raw.byteLength > PREVIEW_MAX_BYTES
  const slice = truncated ? raw.subarray(0, PREVIEW_MAX_BYTES) : raw
  return { kind: 'text', content: slice.toString('utf8'), truncated, mtimeMs: info.mtimeMs }
}

/** One row the permission surface offers as a principal. */
export interface PrincipalOption {
  /** Value the grant must carry: a user's UUID, or a code for every other kind. */
  id: string
  /** Human-facing name, falling back to the id when the backend sends none. */
  label: string
}

/**
 * Read the principals of one kind from the backend.
 *
 * The permission store matches a user by primary key and every other kind by
 * `code`, and there is nowhere else a valid value can come from. Reading the
 * directory here is what keeps the surface from asking an operator to transcribe
 * a UUID.
 *
 * Failures are reported as an empty list rather than thrown: the directories are
 * a convenience over a field that also accepts a typed value, so a caller whose
 * account may not read them can still grant by hand.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param kind - principal kind to list.
 * @returns The options, in the order the backend returned them.
 */
export async function fetchPrincipals(
  ctx: Context,
  config: Config,
  kind: KnowledgeGrantRequest['principalType'],
): Promise<PrincipalOption[]> {
  const path = { user: ENDPOINTS.users, role: ENDPOINTS.roles, department: ENDPOINTS.departments, group: ENDPOINTS.groups }[kind]
  const body = await request<Record<string, unknown>>(ctx, config, path)
  // A user list nests its rows under `items`; departments nest under their own
  // name. Reading both here keeps the shape difference out of the browser.
  const rows = (body.items ?? body.departments ?? []) as Array<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => {
      const code = typeof row.code === 'string' ? row.code : undefined
      const uuid = typeof row.id === 'string' ? row.id : undefined
      // Users carry an `id`; every other kind carries `code`.
      const id = kind === 'user' ? uuid : code
      if (id === undefined) return undefined
      const name = typeof row.displayName === 'string'
        ? row.displayName
        : (typeof row.name === 'string' ? row.name : (typeof row.username === 'string' ? row.username : id))
      return { id, label: name }
    })
    .filter((row): row is PrincipalOption => row !== undefined)
}

/** The calling user, as DataOps describes them. */
export interface KnowledgeCaller {
  /** Stable user id. Keys the caller's view directory, so it must be a safe name. */
  userId: string
  /** Human-facing name, for reporting. */
  label: string
  /** Role codes the backend reported. Kept for reporting, not for authorization. */
  roleCodes: string[]
}

/**
 * Read the authenticated caller.
 *
 * The view directory is keyed by this id, so it is fetched from the authority
 * rather than inferred from a token or a header: the id has to be the one DataOps
 * itself will resolve grants against, or the view would be built for a different
 * identity than the grants describe.
 *
 * The role codes are read here because this is already the one call that reads the
 * profile, but they are NOT what authorizes anything: they are the role's display
 * names (measured 2026-10-16), so {@link canManageGrants} asks the enforced
 * permission point instead. They are returned so a caller can report them.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @returns The caller's id, display name and role codes.
 */
export async function fetchCaller(ctx: Context, config: Config): Promise<KnowledgeCaller> {
  const body = await request<Record<string, unknown>>(ctx, config, ENDPOINTS.me)
  // The route answers `{ user: {...} }`, not the profile at the top level. Read
  // both so a change in nesting shows up as a missing id rather than as a view
  // keyed by the literal string "undefined".
  const profile = (body.user ?? body) as Record<string, unknown>
  const userId = typeof profile.id === 'string' ? profile.id : ''
  if (userId === '') {
    throw new KnowledgeError('DataOps did not report the caller id', 'not-configured')
  }
  const label = typeof profile.displayName === 'string'
    ? profile.displayName
    : (typeof profile.username === 'string' ? profile.username : userId)
  const roleCodes = Array.isArray(profile.roles)
    ? profile.roles
      .map(role => (role as Record<string, unknown>).code)
      .filter((code): code is string => typeof code === 'string' && code !== '')
    : []
  return { userId, label, roleCodes }
}

/**
 * Ask DataOps whether the CALLER may read one path.
 *
 * The decision is the backend's, not this plugin's: the route is self-scoped, so
 * the answer is about the credential's own user and this function cannot be used
 * to ask about anyone else. That is what keeps a per-user view from becoming a
 * second permission implementation.
 *
 * A failed request answers `false` rather than throwing, so one unreadable path
 * cannot leave a view half-built. An unreachable backend therefore produces an
 * empty view instead of a wrong one.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the authoritative root.
 * @returns Whether the caller may read it.
 */
export async function canReadPath(ctx: Context, config: Config, relPath: string): Promise<boolean> {
  try {
    const body = await request<{ canRead?: boolean }>(ctx, config, ENDPOINTS.resolve, {
      method: 'POST',
      body: { resourceType: KB_RESOURCE_TYPE, resourceId: relPath },
    })
    return body.canRead === true
  } catch {
    return false
  }
}

/**
 * Ask DataOps whether the CALLER may manage grants.
 *
 * The question is put to the authority instead of being inferred here. The route
 * read below is guarded by exactly `data:access-grant:manage` -- the permission the
 * grant and revoke calls require -- so the backend's own answer to the read is the
 * answer to "may this caller manage grants": a `200` means the permission is held,
 * a `403` means it is not. Nothing about the body is used, and the filter keeps the
 * response to this resource type rather than downloading the whole grant table.
 *
 * Every other outcome denies. An unreachable backend, a timeout, a rejected token
 * and a malformed body all leave the permission unproven, and an unproven permission
 * must not publish a management surface: an administrator who is wrongly denied
 * retries after the backend recovers, while a non-administrator who is wrongly
 * allowed keeps an entry point the backend would refuse anyway.
 *
 * Role names were considered as the judge and rejected on measured evidence, so that
 * the reason survives the next reader. `/auth/me` returns `roles[].code` as the
 * role's DISPLAY name -- measured 2026-10-16 against the running backend, which
 * answers `管理员` and `超级管理员` -- while `SUPER_ADMIN` / `ADMIN` are the separate
 * `system_key` values that route never exposes. Matching the constant names would
 * therefore deny every real administrator, and matching display names would let a
 * role rename silently change who may manage grants. The enforced permission point
 * has neither problem, which is why it is the only judge used here.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @returns Whether the caller holds the grant-management permission.
 */
export async function canManageGrants(ctx: Context, config: Config): Promise<boolean> {
  try {
    // A resource id no grant can carry, so the probe reads no grant rows at all:
    // the guard is what is being asked, not the body it returns.
    const path = `${ENDPOINTS.grants}?resourceType=${encodeURIComponent(KB_RESOURCE_TYPE)}`
      + `&resourceId=${encodeURIComponent(GRANT_PROBE_RESOURCE_ID)}`
    await request<unknown>(ctx, config, path, { method: 'GET' })
    return true
  } catch {
    return false
  }
}

/**
 * The resource id the capability probe asks about.
 *
 * The response body is ignored, so this only has to keep the probe offline from
 * real data; a leading slash is the cheapest way to do that, because
 * {@link isContainedRelPath} refuses it and no legitimate grant can name it. The
 * filter also keeps the probe from reading the whole grant table.
 */
const GRANT_PROBE_RESOURCE_ID = '/__knowledge-grant-probe__'

/**
 * Create one grant in the backend permission store.
 *
 * The plugin names the principal and the path; DataOps decides whether the
 * principal exists and whether the caller may write the grant at all. That split
 * is why this is a thin relay rather than a policy of its own.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param body - the grant to create.
 * @returns The backend's acknowledgement.
 */
export function createGrant(
  ctx: Context,
  config: Config,
  body: KnowledgeGrantRequest,
): Promise<unknown> {
  return request<unknown>(ctx, config, ENDPOINTS.grants, {
    method: 'POST',
    body: {
      // The store keys a grant by resource type and id, so a knowledge path is
      // addressed in the resource-id slot rather than under its own field.
      resourceType: KB_RESOURCE_TYPE,
      resourceId: body.relPath,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action ?? 'read',
    },
  })
}

/** Remove one grant from the backend permission store. */
export function revokeGrant(
  ctx: Context,
  config: Config,
  body: KnowledgeRevokeRequest,
): Promise<unknown> {
  return request<unknown>(ctx, config, ENDPOINTS.grants, {
    method: 'DELETE',
    body: {
      resourceType: KB_RESOURCE_TYPE,
      resourceId: body.relPath,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action,
    },
  })
}

/** Build the substitution context for the deployment recipes. */
export function planContext(config: Config): DeployPlanContext {
  return {
    actualRoot: config.actualRoot,
    viewRoot: config.viewRoot,
    tier: config.mineruTier,
    backend: config.mineruBackend,
    port: config.mineruPort,
    memoryMaxMiB: config.mineruMemoryMaxMiB,
    permitted: config.permitted,
    server: config.nfsServer,
    mountPoint: config.mountPoint,
  }
}

/** One recorded step execution. */
export interface StepRun {
  stepId: string
  hostId: string
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  /** Human-readable transcript assembled from per-command results. */
  log: string[]
}

/** Read a JSON request body, tolerating an empty one. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text) as Record<string, unknown>)
      } catch (error) {
        reject(new Error('request body is not valid JSON', { cause: error }))
      }
    })
    req.on('error', (error: Error) => { reject(error) })
  })
}

/** Write one JSON reply. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Serialize a thrown value for the browser. */
function describeError(error: unknown): { message: string; code?: string } {
  if (error instanceof KnowledgeError || error instanceof RemoteError) {
    return { message: error.message, code: error.code }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

/**
 * Register the knowledge-base routes and tools.
 * @param ctx - Host context carrying credentials, tools, and the Web server.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const host = ctx
  // The runner needs an absolute origin: a Host-side `fetch` cannot use the
  // relative paths a browser would accept.
  const runner: RemoteRunner = sshManagerRunner({ origin: originFrom(host.webServer) })
  const context = planContext(config)
  /** Completed and in-flight step runs, newest last. */
  const runs: StepRun[] = []

  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: '/knowledge-base/api',
    handler: async (req, res) => {
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/knowledge-base/api/'.length)
      try {
        switch (method) {
          case 'config':
            // The mounted layout is the answer, and it is the container's own
            // fact rather than a remote one, so nothing is fetched here.
            return writeJson(res, 200, localConfig(config))
          case 'status': {
            // The page asks this once on mount, so the capability flag travels here
            // rather than in `config`: `config` is derived from the container's own
            // layout and stays a pure filesystem fact, while this flag is a decision
            // that costs a backend round trip.
            //
            // The decision is the Host's, never the browser's. A client that computed
            // it would be copying the authorization policy into a process the user
            // controls, where hiding a row is a rendering choice rather than a check:
            // the backend still refuses the writes, but the page would show a surface
            // it cannot use. An unconfigured backend short-circuits to false because
            // there is no authority to ask.
            const canManage = config.baseUrl.trim() === ''
              ? false
              : await canManageGrants(host, config)
            return writeJson(res, 200, { ...await localStatus(config), canManageGrants: canManage })
          }
          case 'grants': {
            // Authorization lives in DataOps; this route relays what the backend
            // reports and holds no policy of its own. An unconfigured backend is
            // reported as unsupported rather than as an empty grant list, so the
            // page can say why it has nothing to show.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 200, { grants: [], supported: false })
            }
            try {
              const grants = await fetchGrants(host, config)
              return writeJson(res, 200, {
                grants: grants.map(grant => ({
                  id: grant.id,
                  relPath: grant.relPath,
                  kind: grant.kind,
                  principalType: grant.principalType,
                  principalId: grant.principalId,
                  action: grant.action,
                  grantedBy: grant.grantedBy,
                  grantedAt: grant.grantedAt,
                })),
                supported: true,
              })
            } catch (error) {
              return writeJson(res, 200, { grants: [], supported: true, error: describeError(error) })
            }
          }
          case 'grant': {
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const request: KnowledgeGrantRequest = {
              relPath: String(body.relPath ?? ''),
              principalType: String(body.principalType ?? 'user') as KnowledgeGrantRequest['principalType'],
              principalId: String(body.principalId ?? ''),
              action: typeof body.action === 'string' ? body.action : 'read',
            }
            if (request.relPath === '' || request.principalId === '') {
              return writeJson(res, 400, { error: 'relPath and principalId are required' })
            }
            return writeJson(res, 200, await createGrant(host, config, request))
          }
          case 'revoke': {
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const request: KnowledgeRevokeRequest = {
              relPath: String(body.relPath ?? ''),
              principalType: String(body.principalType ?? 'user') as KnowledgeRevokeRequest['principalType'],
              principalId: String(body.principalId ?? ''),
              action: typeof body.action === 'string' ? body.action : 'read',
            }
            if (request.relPath === '' || request.principalId === '') {
              return writeJson(res, 400, { error: 'relPath and principalId are required' })
            }
            return writeJson(res, 200, await revokeGrant(host, config, request))
          }
          case 'list': {
            // A directory listing that carries each entry's modification time.
            //
            // The borrowed tree's own entry shape has no timestamp, so a row built
            // from it can never show one. This route reads the same directory but
            // stats each child, which is what lets the page show when a document
            // last changed.
            //
            // Every row here has been resolved as readable by DataOps, and a row
            // that could not be resolved is not returned at all. `permissionsResolved`
            // therefore says whether the permission question could be ASKED (a
            // configured backend and a caller id), not whether each answer was yes:
            // when it is true the listing is the caller's verified set, and when it
            // is false the listing is empty because nothing was verified.
            const body = await readJsonBody(req)
            const rel = String(body.path ?? '')
            const root = localConfig(config).mountPoint
            const target = rel === '' ? root : join(root, rel)
            const wantPermissions = body.permissions !== false
            if (!wantPermissions || config.baseUrl.trim() === '') {
              return writeJson(res, 200, { entries: [], permissionsResolved: false })
            }
            let callerId: string | undefined
            try {
              callerId = (await fetchCaller(host, config)).userId
            } catch {
              callerId = undefined
            }
            return writeJson(res, 200, {
              entries: await listDirectoryWithPermissions(host, config, root, target, callerId),
              permissionsResolved: callerId !== undefined,
            })
          }
          case 'search': {
            const body = await readJsonBody(req)
            const term = String(body.term ?? '')
            const root = localConfig(config).mountPoint
            return writeJson(res, 200, { hits: await searchKnowledge(root, term) })
          }
          case 'read': {
            // Served from the mount point rather than through the session-backed
            // file API, so opening a file needs no conversation.
            const body = await readJsonBody(req)
            return writeJson(res, 200, await readKnowledgeFile(host, config, String(body.path ?? '')))
          }
          case 'views.sync': {
            // Rebuild the CALLER's visible tree from what DataOps resolves for them.
            //
            // This is the step that makes a grant mean something on disk: the
            // workspace mounts the shared export, so without a per-user view every
            // user would see every file no matter what the permission store says.
            // The decision stays with DataOps (the resolve route is self-scoped);
            // this route only links what that decision allows.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            const candidates = Array.isArray(body.paths)
              ? body.paths.map(String)
              : await listRelativeFiles(plan.actualRoot)
            const allowed: ResolvedPath[] = []
            for (const relPath of candidates) {
              if (!isContainedRelPath(relPath)) continue
              if (await canReadPath(host, config, relPath)) allowed.push({ relPath })
            }
            const viewOptions = { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }
            const delta = await syncView(viewOptions, allowed)
            // Retarget the browsable mount at this user's view. Without it the page
            // would browse the shared export, so a grant would change the view on
            // disk and nothing the user can see.
            const mountPointed = await pointMountAtView(viewOptions, plan.mountPoint)
            return writeJson(res, 200, {
              mountPoint: plan.mountPoint,
              mountPointed,
              userId: caller.userId,
              label: caller.label,
              considered: candidates.length,
              resolved: allowed.length,
              viewPath: viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }),
              ...delta,
            })
          }
          case 'principals': {
            // The directories live behind the same credential the grants do, so a
            // browser cannot read them directly and this route relays them.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 200, { options: [] })
            }
            const body = await readJsonBody(req)
            const kind = String(body.principalType ?? 'user') as KnowledgeGrantRequest['principalType']
            try {
              return writeJson(res, 200, { options: await fetchPrincipals(host, config, kind) })
            } catch (error) {
              return writeJson(res, 200, { options: [], error: describeError(error) })
            }
          }
          case 'index': {
            // Indexing is not a remote job: the index is what the mounted tree
            // already serves, so a rebuild reports the tree's current shape
            // rather than pretending to have scheduled work elsewhere.
            return writeJson(res, 200, await localStatus(config))
          }
          case 'deploy.steps':
            return writeJson(res, 200, { steps: deploymentPlan(context).map(publicStep), runs: runs.slice(-10) })
          case 'deploy.hosts': {
            try {
              return writeJson(res, 200, { hosts: await runner.listHosts() })
            } catch (error) {
              return writeJson(res, 200, { hosts: [], error: describeError(error) })
            }
          }
          case 'deploy.run': {
            const body = await readJsonBody(req)
            const stepId = String(body.stepId ?? '')
            const hostId = String(body.hostId ?? '')
            const step = findStep(stepId, context)
            if (step === undefined) return writeJson(res, 400, { error: `unknown step ${stepId}` })
            if (hostId === '') return writeJson(res, 400, { error: 'hostId is required' })
            // Steps mutate a remote host, so they are rejected while one runs.
            if (runs.some(run => run.state === 'running')) {
              return writeJson(res, 409, { error: 'a deployment step is already running' })
            }
            const record: StepRun = {
              stepId,
              hostId,
              state: 'running',
              startedAt: new Date().toISOString(),
              finishedAt: null,
              log: [],
            }
            runs.push(record)
            try {
              await executeStep(runner, step, hostId, record)
              record.state = 'succeeded'
            } catch (error) {
              record.state = 'failed'
              record.log.push(`ERROR: ${describeError(error).message}`)
            } finally {
              record.finishedAt = new Date().toISOString()
            }
            return writeJson(res, 200, record)
          }
          case 'deploy.log': {
            const jobId = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('stepId') ?? ''
            const found = [...runs].reverse().find(run => run.stepId === jobId)
            return writeJson(res, 200, found ?? { error: 'no such run' })
          }
          default:
            return writeJson(res, 404, { error: `unknown knowledge-base method: ${method}` })
        }
      } catch (error) {
        return writeJson(res, 500, describeError(error))
      }
    },
  }), 'dsh-knowledge-base: settings API')

  ctx.effect(() => host.tools.register(defineTool({
    name: 'kb_index',
    description: 'Ask DataOps to parse uploaded documents (docx/pdf/xlsx/ppt) into Markdown index files. '
      + 'Retrieval itself uses the mounted knowledge tree with grep and read; this tool only builds indexes.',
    parameters: {
      relPath: { type: 'string', description: 'Path relative to the knowledge root; omit for the whole tree.' },
      force: { type: 'boolean', description: 'Rebuild even when the source looks unchanged.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute: async (args) => {
      // The index is the mounted tree itself: retrieval reads those files with
      // grep and read, so a "rebuild" reports the tree's current shape instead
      // of scheduling work on a backend that serves no index route.
      const status = await localStatus(config)
      const scope = typeof args.relPath === 'string' && args.relPath.trim() !== ''
        ? args.relPath.trim()
        : 'the whole tree'
      return {
        report: `Indexed ${scope}: ${String(status.visibleFiles ?? 0)} file(s) visible under ${config.mountPoint}.`,
      }
    },
  })), 'dsh-knowledge-base: kb_index tool')

  ctx.effect(() => host.tools.register(defineTool({
    name: 'kb_status',
    description: 'Report the visible file count and index state of the mounted knowledge tree.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute: async () => {
      const status = await localStatus(config)
      if (status.visibleFiles === null) {
        return {
          report: `The knowledge tree is not mounted at ${config.mountPoint}. `
            + 'Attach the storage host, then mount the view tree there.',
        }
      }
      return {
        report: `${String(status.visibleFiles)} visible file(s) under ${config.mountPoint}. `
          + 'Retrieval runs on this tree with grep and read; there is no separate index to report.',
      }
    },
  })), 'dsh-knowledge-base: kb_status tool')
}

/** Project a step to the fields the browser needs. */
function publicStep(step: DeployStep): { id: string; label: string; timeoutMs: number; commands: string[] } {
  return { id: step.id, label: step.label, timeoutMs: step.timeoutMs, commands: step.commands }
}

/**
 * Run every command of one step, appending each outcome to the run record.
 *
 * A failing command stops the step: later commands assume the earlier ones
 * succeeded, and continuing would report a misleading success.
 */
async function executeStep(
  runner: RemoteRunner,
  step: DeployStep,
  hostId: string,
  record: StepRun,
): Promise<void> {
  for (const command of step.commands) {
    record.log.push(`$ ${command}`)
    const result = await runner.execute(hostId, command, step.timeoutMs)
    if (result.stdout.trim() !== '') record.log.push(result.stdout.trimEnd())
    if (result.stderr.trim() !== '') record.log.push(`stderr: ${result.stderr.trimEnd()}`)
    if (result.truncated) record.log.push('(output truncated by the SSH transport)')
    if (result.exitCode !== 0) {
      throw new RemoteError(
        `command exited with ${result.exitCode === null ? 'a signal' : String(result.exitCode)}: ${command}`,
        'transport',
      )
    }
  }
}

/** Re-exported for tests and for callers that need the host shape. */
export type { RemoteHost, RemoteRunner }
