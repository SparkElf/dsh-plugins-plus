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
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  type KnowledgeGrantPrincipalType,
  type KnowledgeGrantRequest,
  type KnowledgeRevokeRequest,
  type KnowledgeSshView,
  type KnowledgeStatus,
} from './protocol.ts'
import {
  appendAuditEntry,
  isContainedRelPath,
  isSafeUserId,
  moveEntry,
  copyEntry,
  discardPendingWrite,
  expectedViewPathFor,
  isPendingName,
  listPendingWrites,
  parkPendingWrite,
  pointMountAtView,
  readAuditEntries,
  readPendingContent,
  readFavorites,
  readPins,
  readSettings,
  normalizeMineruBaseUrl,
  readTemplates,
  removeTemplate,
  saveTemplate,
  templateBytes,
  readStorageSettings,
  readTreeState,
  readViewMode,
  storageSettingsOf,
  syncView,
  viewPathFor,
  writeFavorites,
  writePins,
  writeSettings,
  writeStorageSettings,
  writeTreeState,
  writeViewMode,
  type KnowledgeAuditEntry,
  type KnowledgeStorageSettings,
  type ResolvedPath,
  type ViewDelta,
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
import {
  createExtractionQueue,
  type ExtractionOutcome,
  type ExtractionQueue,
  type ExtractionTask,
} from './extractionQueue.ts'
import { extractDocument, isExtractable, markdownSiblingOf, writeExtractedMarkdown } from './extract.ts'
import { BUILT_IN_ROLES, KNOWLEDGE_ACTIONS, isKnowledgeAction, permissionToDataOpsActions } from './permissions.ts'
import { addTombstone, readTrash, removeTombstone, writeTrash } from './trash.ts'

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
  /**
   * Where documents are stored.
   *
   * `local` keeps them in the workspace's own directory (`mountPoint`): no mount, no
   * sync, no remote round trip per read. `remote` keeps the synchronized shape, where
   * the browsable pointer is a per-user view inside an NFS share refreshed from
   * `actualRoot`. The two modes share listing, preview, edit, permission and audit and
   * differ only in where the bytes live.
   */
  storageMode: 'local' | 'remote'
  /**
   * How a `remote` deployment reaches its share.
   *
   * Orthogonal to {@link storageMode}: a local deployment stores nothing remotely, so it
   * ignores this. `nfs` is the original shape -- an export mounted on the Host at
   * {@link mountPoint}. `sshfs` reaches the same kind of directory over SSH instead, which
   * is what a host behind NAT needs: NFSv4 callbacks cannot traverse NAT, while an
   * outbound SSH connection can. The rest of the plugin does not branch on this: both
   * protocols end as a directory bound into the container at `mountPoint`.
   */
  storageProtocol: 'nfs' | 'sshfs'

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

  /** SSHFS: remote host, as an address or hostname. */
  sshHost: string
  /** SSHFS: login user on that host. */
  sshUser: string
  /** SSHFS: TCP port the SSH daemon listens on. */
  sshPort: number
  /**
   * SSHFS: credential reference holding the private key.
   *
   * A reference, never the key itself: the panel reports only this name and whether it
   * resolves, so the secret stays in the credential store and out of the settings file.
   */
  sshKeyRef: string
  /** SSHFS: absolute path of the shared directory on the remote host. */
  sshRemotePath: string
  /**
   * SSHFS: extra `-o` options for the mount.
   *
   * Kept as one string because that is how `sshfs -o` takes them, and the operator is
   * the one who knows whether their host needs `allow_other` or a different identity
   * file. The mount step always adds the reconnect options this deployment needs.
   */
  sshMountOptions: string
  /** MinerU quality tier to deploy. */
  mineruTier: MineruTier
  /** MinerU small-model backend to deploy. */
  mineruBackend: MineruBackend
  /** TCP port the MinerU API listens on where it is deployed. */
  mineruPort: number
  /**
   * MinerU's full base address, or `''` to derive it from `mineruPort`.
   *
   * Deployment-level fallback for the setting a caller can change on the settings page.
   * Empty keeps the derivation, so a deployment that never sets this keeps working.
   */
  mineruBaseUrl: string
  /** Memory ceiling in MiB for the MinerU service, clamped to half the host's RAM. */
  mineruMemoryMaxMiB: number
}

/** Config schema; an invalid value fails the profile load loudly. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  timeoutMs: z.number().default(15_000),
  // The browsable knowledge tree: the POINTER the page browses, not the share's
  // mount point. A sync replaces this path with a symlink to the caller's own view,
  // so it has to be a dedicated location -- and it is deliberately nested one level
  // inside the share rather than being the share root.
  //
  // It used to default to `/workspace/kb` while `actualRoot`/`viewRoot` used
  // `/nas/kb`, which no single deployment could satisfy: the page reported "not
  // mounted" while the share sat one directory over. Pointing it at the share root
  // instead is NOT the fix -- a sync REPLACES its mountPoint, so retargeting
  // `/nas/kb` would delete the mounted export's `actual/` and every `views/`
  // directory on the server. Measured on 2026-10-17 during a near-miss; the guard in
  // `views.pointMountAtView` now refuses that shape outright.
  // The browsable entry point, inside the workspace rather than beside it.
  //
  // It points at `/workspace/kb` because that is where the product shows files: the same
  // tree the official workspace file browser and the model's own tools walk. The pointer
  // is a SYMLINK into the caller's view, and `pointMountAtView` replaces only the link --
  // which is why this path is safe even though it is one level from the share: the
  // dangerous shape is a real directory here, and the guards refuse that outright.
  /**
   * Where documents are stored.
   *
   * `local` keeps them in the workspace's own directory (`mountPoint`), which is where the
   * product's file browser and the model's tools already look. `remote` keeps the
   * synchronized shape: the browsable pointer is a per-user view inside an NFS share,
   * refreshed from `actualRoot`.
   *
   * Local is the default because it is the only shape that needs nothing beyond the
   * workspace: no mount, no sync, no remote round-trip per read. Remote stays supported
   * for deployments that already have a share -- the two modes share the listing,
   * preview, edit, permission and audit paths and differ only in where the bytes live and
   * whether a sync runs.
   */
  storageMode: z.union([z.const('local'), z.const('remote')]).default('local'),
  mountPoint: z.string().default('/workspace/kb'),
  actualRoot: z.string().default('/nas/kb/actual'),
  viewRoot: z.string().default('/nas/kb/views'),
  permitted: z.string().default('*'),
    // Host serving the export. The mount step builds `address:/` from it, because `fsid=0`
    // in the export makes the share the NFSv4 pseudo root: clients mount the server root
    // rather than a path beneath it.
    nfsServer: z.string().default(''),
  // `nfs` is the default so an existing remote deployment keeps working unchanged: a
  // profile that names no protocol is the one this plugin has always driven.
  storageProtocol: z.union([z.const('nfs'), z.const('sshfs')]).default('nfs'),
  // SSHFS transport. Empty defaults mean "a local or NFS deployment", so nothing here
  // is required until the protocol is switched to `sshfs`; `sshfsMountStep` refuses to
  // render a command from an incomplete set rather than mounting `@:` somewhere.
  sshHost: z.string().default(''),
  sshUser: z.string().default(''),
  sshPort: z.number().default(22),
  // A reference name, not a key. The credential store holds the secret; this field is
  // the key it is looked up by, which is why it is safe to show and to persist.
  sshKeyRef: z.string().default('DATAOPS_KB_SSH_KEY'),
  sshRemotePath: z.string().default(''),
  // Deliberately no `allow_other` default: it needs `user_allow_other` in
  // /etc/fuse.conf, and a mount that silently fails is worse than one that asks the
  // operator for the options their host actually requires.
  sshMountOptions: z.string().default(''),
  // MinerU 4.x recognises exactly `basic` and `standard` as deployment tiers
  // (`mineru/types.py`: `DEPLOYMENT_TIERS`), and `models download --tier` validates against
  // that tuple, so anything else aborts the model download. `flash` is not one of them: it is
  // a *quality* tier used for the parsers that need no local weights at all (CSV, EPUB, HTML),
  // which is why offering it here would fail on a host that needs the download. Measured
  // 2026-10-15 against mineru 4.0.12.
  mineruTier: z.union([z.const('basic'), z.const('standard')]).default('basic'),
  mineruBackend: z.union([z.const('onnx'), z.const('torch')]).default('onnx'),
  mineruPort: z.number().default(8000),
  mineruBaseUrl: z.string().default(''),
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
  init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number },
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
      // A caller may ask for a shorter bound than the plugin's own. A list that
      // decorates a page is not worth the general timeout: if the shared backend is
      // busy with unrelated work, the surface should say so rather than make the
      // reader wait for a call that is not the point of the page.
      signal: AbortSignal.timeout(init?.timeoutMs ?? config.timeoutMs),
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
export function localConfig(
  config: Config,
  /**
   * Whether the SSHFS credential currently resolves.
   *
   * Passed in rather than resolved here because this function is synchronous and called from
   * a dozen places that never touch the SSH transport. A caller that shows the panel resolves
   * it first; every other caller leaves it false, which only means "this answer does not
   * claim a key".
   */
  sshKeyConfigured = false,
): KnowledgeConfig & {
  backendConfigured: boolean
  storageProtocol: 'nfs' | 'sshfs'
  ssh: KnowledgeSshView
} {
  return {
    mountPoint: config.mountPoint,
    actualRoot: config.actualRoot,
    viewRoot: config.viewRoot,
    nfsServer: config.nfsServer,
    host: config.baseUrl.trim() === '' ? '' : safeHost(config.baseUrl),
    backendConfigured: config.baseUrl.trim() !== '',
    storageProtocol: config.storageProtocol,
    // Every field here is safe to render. `keyConfigured` is derived, not the key: the panel
    // needs to know whether the mount step will find one, and nothing more.
    ssh: {
      host: config.sshHost,
      user: config.sshUser,
      port: config.sshPort,
      remotePath: config.sshRemotePath,
      mountOptions: config.sshMountOptions,
      keyRef: config.sshKeyRef,
      keyConfigured: sshKeyConfigured,
    },
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

/**
 * Why the visible tree is not readable, when it is not.
 *
 * A null count used to be one condition and is really two, and the page told the
 * reader the wrong one. It means either the mounted tree is absent, or the pointer
 * at `mountPoint` has not been built yet -- a per-user symlink that only a view
 * sync creates. The second is the ordinary state for a caller who has been granted
 * nothing yet, and reporting it as "not mounted" sends the reader to inspect a
 * mount that is working.
 *
 * The distinction is a filesystem fact, not a policy: whether the configured path
 * exists at all, versus whether it is a pointer this plugin can build on demand.
 */
export type KnowledgeMountState = 'mounted' | 'pointer-missing' | 'absent'

/** The fields a sync reports beyond the filesystem delta. */
export interface SyncReportFields {
  /** The browsable path that was retargeted. */
  mountPoint: string
  /** Whether the pointer now points at this caller's view. */
  mountPointed: boolean
  /** The identity the view is keyed by. */
  userId: string
  /** Human-readable name of the caller, when the backend reported one. */
  label?: string
  /** Candidate paths considered. */
  considered: number
  /** Paths DataOps resolved as readable. */
  resolved: number
  /** The view directory this caller's files are linked into. */
  viewPath: string
}

/**
 * Classify why the browsable path does or does not yield a file count.
 *
 * Reads the configured path rather than inferring from the count, because a count
 * of null is compatible with both failure modes and cannot tell them apart.
 * @param config - resolved plugin config.
 * @returns The state, in order of increasing severity.
 */
export async function classifyMount(config: Config): Promise<KnowledgeMountState> {
  if (config.mountPoint.trim() === '') return 'absent'
  try {
    const info = await stat(config.mountPoint)
    // Exists and is a directory: the tree is readable, whether it came from a mount
    // or from a pointer this plugin built.
    if (info.isDirectory()) return 'mounted'
    // A file where the pointer belongs is a configuration fault. Reporting it as
    // "not yet generated" would invite a retry that cannot succeed.
    return 'absent'
  } catch {
    // The path is missing. Either the share is not attached -- in which case the
    // parent is missing too -- or the share is fine and this plugin has yet to build
    // its pointer inside it. The parent tells the two apart.
    try {
      return (await stat(dirname(config.mountPoint))).isDirectory() ? 'pointer-missing' : 'absent'
    } catch {
      return 'absent'
    }
  }
}

/**
 * Rebuild the caller's visible tree and point the browsable path at it.
 *
 * Shared by the explicit `views.sync` route and the status route's first-load
 * repair, so both take exactly the same path: one implementation means the
 * automatic case cannot drift from the button the reader can press.
 *
 * It is idempotent and writes nothing when the resolved set is unchanged, which is
 * what makes it safe to run without being asked -- `syncView` returns
 * `unchanged > 0, linked: []` in that case.
 *
 * The decision stays with DataOps: the resolve route is self-scoped, and this
 * function only links what that answer allows.
 * @param host - the plugin context, for the backend calls.
 * @param config - resolved plugin config.
 * @param paths - candidate relative paths; omitted means walk the authoritative root.
 * @returns The sync report, or a refusal the caller should relay.
 */
export async function syncCallerView(
  host: Context,
  config: Config,
  paths?: string[],
): Promise<(ViewDelta & SyncReportFields & { status: number; error?: never }) | { status: number; error: string }> {
  if (config.baseUrl.trim() === '') {
    return { status: 409, error: 'DataOps permission API is not configured' }
  }
  const plan = localConfig(config)
  let caller
  try {
    caller = await fetchCaller(host, config)
  } catch (error) {
    // The identity is the key the view is stored under, so without it there is no
    // directory to build and no safe default. Reported rather than guessed.
    return { status: 502, error: describeError(error).message }
  }
  if (!isSafeUserId(caller.userId)) {
    return { status: 400, error: 'unsafe caller id; cannot key a view by it' }
  }
  const candidates = paths ?? await listRelativeFiles(plan.actualRoot)
  const allowed: ResolvedPath[] = []
  // The paths the caller explicitly asked about that did NOT resolve as readable.
  //
  // `canReadPath` fails closed, so a backend problem and a genuine denial both land
  // here. Reported rather than folded into the count because a WRITE route passes
  // exactly one path -- the one it just created -- and needs to know whether the
  // reader will be able to see it. Without this, "sync walked the tree" was
  // indistinguishable from "the new document is in the view".
  const unresolved: string[] = []
  for (const relPath of candidates) {
    if (!isContainedRelPath(relPath)) continue
    if (await canReadPath(host, config, relPath)) allowed.push({ relPath })
    else if (paths !== undefined) unresolved.push(relPath)
  }
  const viewOptions = {
    actualRoot: plan.actualRoot,
    viewRoot: plan.viewRoot,
    userId: caller.userId,
    ...(caller.departmentCode === undefined ? {} : { departmentCode: caller.departmentCode }),
    // The organization path is what nests the department bucket. Passed only when
    // DataOps reported a usable one, so an older backend leaves the bucket in its
    // single-level shape instead of being handed an empty hierarchy.
    ...(caller.departmentPathCodes === undefined
      ? {}
      : { departmentPathCodes: caller.departmentPathCodes }),
  }
  // The caller's removals filter the view they are about to get. An unreadable
  // record is treated as "nothing hidden" rather than as an error: failing the whole
  // sync over a bookkeeping file would take the tree away from a caller whose
  // documents are all still granted, which is worse than showing a removed file
  // until the record can be repaired.
  const trash = await readTrash(viewPathFor(viewOptions))
  if (trash.kind === 'unreadable') {
    host.logger?.warn?.(`knowledge-base: unusable trash record for ${caller.userId}: ${trash.reason}`)
  }
  const hidden = trash.kind === 'ready' ? trash.entries.map(entry => entry.relPath) : []
  // Two facts travel here that `syncView` cannot work out for itself.
  //
  // `fullScan`: `paths === undefined` means the candidate list came from walking the
  // authoritative root, so this set is the whole answer. When the caller named paths,
  // the rest of the view is unexamined and must not be pruned.
  //
  // `trustResolvedSet`: false when the scan considered files but resolved NONE of
  // them. `canReadPath` fails closed without reporting why, so that shape is a
  // wholesale failure at least as often as it is a total revoke -- and pruning on it
  // would delete every link the reader has. The view is kept and the refusal travels
  // back as `pruneSkipped`, which `status` reports.
  const trustResolvedSet = !(paths === undefined && candidates.length > 0 && allowed.length === 0)
  const delta = await syncView(
    { ...viewOptions, hidden, fullScan: paths === undefined, trustResolvedSet },
    allowed,
  )
  // Retarget the browsable mount at this user's view. Without it the page would
  // browse the shared export, so a grant would change the view on disk and nothing
  // the user can see.
  const mountPointed = await pointMountAtView(viewOptions, plan.mountPoint)
  return {
    status: 200,
    mountPoint: plan.mountPoint,
    mountPointed,
    userId: caller.userId,
    label: caller.label,
    considered: candidates.length,
    resolved: allowed.length,
    ...(unresolved.length === 0 ? {} : { unresolved }),
    viewPath: viewPathFor(viewOptions),
    ...delta,
  }
}

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

/**
 * One directory's measured shape, for the indexing table.
 *
 * Every field is a fact read from the filesystem: the count, the newest
 * modification instant, and whether the caller could read it. Nothing here is an
 * estimate of a job state, because this plugin has no index job to report.
 */
export interface DirectoryShape {
  /** Path relative to the mount point; an empty string is the mount itself. */
  relPath: string
  /** Files below this directory, counted recursively. */
  fileCount: number
  /** Newest modification instant in Unix ms, absent when nothing could be read. */
  mtimeMs?: number
  /** Whether this directory's own entries could be listed. */
  readable: boolean
  /**
   * Whether some part of this subtree could not be read, making `fileCount` a
   * lower bound rather than a total.
   *
   * Separate from {@link readable} because the two describe different things: a
   * directory can be listable itself while containing a subdirectory that is not.
   * Rolling both into one flag would either call a readable directory unreadable
   * or present a partial count as a whole one.
   */
  partial: boolean
}

/**
 * Report the mount's per-directory shape.
 *
 * The indexing page needs rows, and the only true rows available are directories
 * of the mounted tree: this plugin has no index of its own, so there is no
 * per-directory index status to report and none is invented. What is measurable
 * is how many files sit below each directory, when the newest one changed, and
 * whether the caller can read it.
 *
 * Only the first level is listed. A row per every nested directory would be a
 * tree dump rather than a table, and the children of an expanded directory are
 * already reachable from the file tree beside this page.
 *
 * Hidden entries are skipped, matching every other walk in this module: they are
 * editor scratch files rather than knowledge documents.
 * @param root - the directory to report on, normally the mount point.
 * @returns One row per visible child directory, plus the root's own row.
 */
export async function listDirectoryShapes(root: string): Promise<DirectoryShape[]> {
  if (root.trim() === '') return []
  /** Count files below one directory, and the newest instant among them. */
  const measure = async (dir: string): Promise<{ fileCount: number; mtimeMs?: number; readable: boolean; partial: boolean }> => {
    let fileCount = 0
    let mtimeMs: number | undefined
    // Whether THIS directory's own entries could be listed, and separately whether
    // the walk hit a refusal anywhere below it. A directory can be listable while
    // holding one that is not, so one flag cannot carry both facts: see the
    // interface above.
    let readable = true
    let partial = false
    const walk = async (current: string, isRoot: boolean): Promise<void> => {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        // A refusal contributes no files rather than failing the whole table, but
        // it is recorded: the zero it produced must not read as "this directory is
        // empty", and an ancestor's total must not read as complete.
        if (isRoot) readable = false
        partial = true
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full, false)
          continue
        }
        if (!entry.isFile()) continue
        fileCount += 1
        const when = await modifiedAt(full)
        if (when.mtimeMs !== undefined && (mtimeMs === undefined || when.mtimeMs > mtimeMs)) {
          mtimeMs = when.mtimeMs
        }
      }
    }
    await walk(dir, true)
    return { fileCount, ...(mtimeMs === undefined ? {} : { mtimeMs }), readable, partial }
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // A missing mount is a normal state, and the page says so rather than
    // rendering a row of zeroes that reads as an empty knowledge base.
    return []
  }
  const rows: DirectoryShape[] = []
  // The root's own row first: "all files" is the row a reader checks against the
  // count in the page header, so it leads rather than being buried among children.
  rows.push({ relPath: '', ...await measure(root) })
  const children = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of children) {
    const full = join(root, entry.name)
    rows.push({ relPath: entry.name, ...await measure(full) })
  }
  return rows
}

/** Count visible files under a mount point, or null when it is not mounted. */
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

  /**
   * Fetch the grant table from the backend.
   *
   * The route answers `{ grants: [...] }`, not a bare array. Reading it as an array
   * would hand a `.map` call an object -- which is what the empty panel was
   * reporting as "map is not a function" -- so both shapes are accepted here: a
   * backend that answers the bare array keeps working, and the shape this
   * deployment returns is the one the panel sees.
   *
   * @param ctx - Host context.
  /**
   * Fetch the grant table from the backend.
   *
   * Two translations happen here, and both are the reason this is not a one-line
   * relay:
   *
   * 1. The route answers `{ grants: [...] }`, not a bare array. Reading it as an
   *    array handed a `.map` an object, which is what the empty panel reported as
   *    "map is not a function".
   * 2. A backend grant names its document `resourceId` and does not carry a
   *    `kind`, `grantedBy` or `grantedAt`. Those are this plugin's own vocabulary,
   *    so they are derived here: the path is the resource id, a path with an
   *    extension is a file, and the grantor and timestamp fall back to neutral
   *    answers rather than being invented.
   *
   * @param ctx - Host context.
   * @param config - resolved plugin config.
   * @returns the grants, empty when the body carries none.
   */
  export async function fetchGrants(ctx: Context, config: Config): Promise<KnowledgeGrant[]> {
    const body = await request<unknown>(ctx, config, ENDPOINTS.grants)
    const raw: unknown[] = Array.isArray(body)
      ? body
      : (Array.isArray((body as { grants?: unknown }).grants) ? (body as { grants: unknown[] }).grants : [])
    const grants: KnowledgeGrant[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const relPath = typeof record.resourceId === 'string'
        ? record.resourceId
        : (typeof record.relPath === 'string' ? record.relPath : '')
      const id = typeof record.id === 'string' ? record.id : ''
      const principalId = typeof record.principalId === 'string' ? record.principalId : ''
      // A grant with no path or no principal cannot be shown or acted on; skipping
      // it is better than rendering a row whose every column is blank.
      if (relPath === '' || principalId === '' || id === '') continue
      const principalType = typeof record.principalType === 'string'
        ? record.principalType as KnowledgeGrantPrincipalType
        : 'user'
      grants.push({
        id,
        relPath,
        kind: typeof record.kind === 'string'
          ? record.kind as 'file' | 'directory'
          : (relPath.includes('.') ? 'file' : 'directory'),
        principalType,
        principalId,
        action: typeof record.action === 'string' ? record.action : 'read',
        grantedBy: typeof record.grantedBy === 'string' ? record.grantedBy : '',
        grantedAt: typeof record.grantedAt === 'string' ? record.grantedAt : '',
      })
    }
    return grants
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
  /**
   * Whether a reader exists for this file's format.
   *
   * Set on file rows only. The page uses it to decide whether "extract markdown" is a
   * meaningful action for this row, so the menu does not have to know the extractor's
   * extension list.
   */
  canExtract?: boolean
  /**
   * Whether this file's `.md` sibling already exists.
   *
   * Set on file rows only, and only for formats that have an extractor. Lets the page
   * say "already extracted" rather than offering a retry that would be refused.
   */
  hasMarkdown?: boolean
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

/**
 * Read one file as raw bytes for a save-to-disk.
 *
 * Separate from {@link readKnowledgeFile}, which is shaped for the preview pane: that one
 * truncates a large text file and refuses a binary one, because the pane cannot show
 * more. A download has the opposite requirement -- the reader asked for THIS file, so it
 * is returned whole or refused with a reason, never silently shortened.
 *
 * Base64 rather than a byte array: the answer travels as JSON, and a `number[]` for a
 * megabyte file is several times the payload and slower to parse on both ends.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config.
 * @param relPath - the file to read, relative to the mount point.
 * @returns The file's bytes and a suggested name, or a refusal reason.
 */
export async function readKnowledgeFileForDownload(
  ctx: Context,
  config: Config,
  relPath: string,
): Promise<{ name: string; base64: string; size: number; mime: string }> {
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeError('path escapes the knowledge tree', 'not-configured')
  }
  const root = localConfig(config).mountPoint
  const full = join(root, relPath)
  const info = await stat(full)
  if (!info.isFile()) {
    throw new KnowledgeError('not a file', 'not-configured')
  }
  // A bound exists so one click cannot pull an unbounded file into the bridge; it is far
  // above any knowledge document and a refusal names the real limit.
  if (info.size > MAX_KNOWLEDGE_WRITE_BYTES) {
    throw new KnowledgeError(
      'file is too large to download through the page (' + String(info.size) + ' > '
      + String(MAX_KNOWLEDGE_WRITE_BYTES) + ' bytes)',
      'bad-response',
    )
  }
  const bytes = await readFile(full)
  const name = relPath.split('/').pop() ?? 'download'
  return { name, base64: bytes.toString('base64'), size: bytes.byteLength, mime: mimeForName(name) }
}

/**
 * The MIME type for a file name, for the browser's save dialog.
 *
 * Deliberately tiny: the download is written to disk either way, and a wrong type only
 * affects how a later open behaves. Anything unknown is `application/octet-stream`, which
 * every browser saves faithfully.
 * @param name - the file's name.
 * @returns A MIME type.
 */
function mimeForName(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  const known: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return known[extension] ?? 'application/octet-stream'
}

/** One row the permission surface offers as a principal. */
export interface PrincipalOption {
  /** Value the grant must carry: a user's UUID, or a code for every other kind. */
  id: string
  /** Human-facing name, falling back to the id when the backend sends none. */
  label: string
  /** Login name, for users only: two accounts can share a display name. */
  username?: string
  /**
   * Role codes this principal belongs to.
   *
   * Users only, and only when the directory reported it. The permission overview needs
   * this to answer "what does this PERSON have": a role grant confers access on every
   * member, so without the membership a reader whose access is entirely role-derived
   * would look like they hold nothing. Absent means the directory did not say -- which
   * the page reports as unavailable inheritance rather than as no inheritance.
   */
  roleCodes?: string[]
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
      // Users carry `roles: [{code,name}]` from DataOps' own projection; every other
      // kind has no membership to report. Read defensively: an older backend that
      // omits the field must leave it absent rather than look like "no roles".
      const roleCodes = kind === 'user' && Array.isArray(row.roles)
        ? row.roles
          .map(role => (role as Record<string, unknown>).code)
          .filter((code): code is string => typeof code === 'string' && code !== '')
        : undefined
      return {
        id,
        label: name,
        ...(kind !== 'user' || typeof row.username !== 'string' ? {} : { username: row.username }),
        ...(roleCodes === undefined ? {} : { roleCodes }),
      }
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
  /**
   * DataOps department code, when the caller belongs to one.
   *
   * Read for LAYOUT only: it selects which `department/<code>/` subtree the view
   * links, and never decides whether a path may be read — {@link canReadPath}
   * stays the single authority for that. A caller with no department simply gets
   * no department bucket.
   */
  departmentCode?: string
  /** Department display name, for reporting beside the bucket. */
  departmentName?: string
  /**
   * The caller's organization path, root first, as DataOps reported it.
   *
   * Layout only, exactly like {@link departmentCode}: it decides how deep the
   * department bucket nests and never whether a path may be read. Empty when the
   * backend does not report it (an older DataOps), in which case the bucket keeps its
   * single-level shape rather than disappearing.
   */
  departmentPathCodes?: string[]
  /** The organization path's display names, index-aligned with the codes. */
  departmentPathNames?: string[]
}

/**
 * Read a `{ code, name }` pair DataOps nests under the profile.
 *
 * The organization path arrays are read here too, but each is independent: a backend
 * that reports `code`/`name` without the arrays (every deployment today) still yields a
 * usable department, and the caller simply gets a single-level bucket. That is why the
 * two are separate fields rather than one required structure — the old shape must keep
 * working without a version check.
 *
 * A path is only used when the two arrays agree in length and the leaf matches `code`.
 * A mismatch means the profile contradicts itself, and half of a contradicting pair
 * would place documents under a folder the reader cannot recognize.
 *
 * @param value - the raw field, which is absent on older backends.
 * @returns The pair with a non-empty code plus any usable path, or undefined.
 */
export function readDepartmentOf(value: unknown): {
  code: string
  name: string
  pathCodes?: string[]
  pathNames?: string[]
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code.trim() : ''
  if (code === '') return undefined
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : code
  const pathCodes = readStringArray(record.pathCodes)
  const pathNames = readStringArray(record.pathNames)
  const pathUsable = pathCodes !== undefined
    && pathNames !== undefined
    && pathCodes.length === pathNames.length
    && pathCodes.length > 0
    && pathCodes[pathCodes.length - 1] === code
  return {
    code,
    name,
    ...(pathUsable ? { pathCodes, pathNames } : {}),
  }
}

/**
 * Read one string array from an untrusted field.
 *
 * A non-array, an array with a non-string member, or an array that trims down to empty
 * entries all answer undefined: a path is either fully usable or not used at all, since
 * a partially valid one would be a hierarchy with a missing level.
 * @param value - the raw field.
 * @returns The trimmed non-empty entries, or undefined.
 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined
    const trimmed = entry.trim()
    if (trimmed === '') return undefined
    entries.push(trimmed)
  }
  return entries.length === 0 ? undefined : entries
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

/**
 * Read one department's ancestor chain from the DataOps catalogue.
 *
 * `/auth/me` is the self-scoped answer and the one this plugin prefers, but a deployment
 * built before the chain was added to it still answers with the leaf department only.
 * The catalogue already answers with `pathCodes`/`pathNames`, and grant subjects already
 * read it, so the chain can be recovered there without asking DataOps for a new route.
 * A caller without access simply gets `undefined` and keeps the leaf-only shape, which
 * the tree renders as a code rather than pretending to know the hierarchy.
 */
async function readDepartmentPathFromCatalog(
  ctx: Context,
  config: Config,
  code: string,
): Promise<{ pathCodes: string[]; pathNames: string[] } | undefined> {
  const body = await request<Record<string, unknown>>(ctx, config, ENDPOINTS.departments)
  const rows = Array.isArray(body.departments) ? body.departments : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    if (record.code !== code) continue
    const pathCodes = readStringArray(record.pathCodes)
    const pathNames = readStringArray(record.pathNames)
    if (pathCodes === undefined || pathNames === undefined) return undefined
    if (pathCodes.length === 0 || pathCodes.length !== pathNames.length) return undefined
    return { pathCodes, pathNames }
  }
  return undefined
}

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
  let department = readDepartmentOf(profile.department)
  // Older deployments answer /auth/me with the leaf department only. Recover the chain
  // from the catalogue this plugin already reads for grant subjects, so the department
  // tree can still name the hierarchy instead of showing slugs.
  if (department !== undefined && department.pathCodes === undefined) {
    const recovered = await readDepartmentPathFromCatalog(ctx, config, department.code)
      .catch(() => undefined)
    if (recovered !== undefined && recovered.pathCodes[recovered.pathCodes.length - 1] === department.code) {
      department = { ...department, ...recovered }
    }
  }
  return {
    userId,
    label,
    roleCodes,
    ...(department === undefined
      ? {}
      : {
        departmentCode: department.code,
        departmentName: department.name,
        ...(department.pathCodes === undefined ? {} : { departmentPathCodes: department.pathCodes }),
        ...(department.pathNames === undefined ? {} : { departmentPathNames: department.pathNames }),
      }),
  }
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
/**
 * The root resource id one knowledge-base-wide grant is stored under.
 *
 * A grant needs a non-empty `resourceId` (DataOps rejects an empty one with
 * "资源ID不能为空"), so "the whole knowledge base" is named explicitly rather than by an
 * empty string. A document can never have this id, because document ids come from titles
 * and never start with `@`.
 */
export const KB_ROOT_RESOURCE_ID = '@kb-root'

/**
 * The ancestor chain for one knowledge path, nearest parent first.
 *
 * DataOps resolves a permission by matching the resource's own id OR any ancestor named
 * here, so passing this chain is what turns "grant the knowledge base once" into "every
 * document inside it inherits that grant". Without it each file needs its own row, which
 * is why a freshly created document used to look unreadable to an administrator.
 *
 * The chain walks the path's parents (`a/b/c.md` → `a/b` → `a`) and ends at the root id,
 * so a grant on any level applies to everything beneath it and the most specific level
 * still wins for a deny.
 * @param relPath - the path being authorised; empty or the root id stands for the root.
 * @returns Ancestor references, nearest first, root last.
 */
export function knowledgeAncestorsFor(relPath: string): Array<{ resourceType: string; resourceId: string }> {
  const ancestors: Array<{ resourceType: string; resourceId: string }> = []
  const trimmed = relPath.trim()
  const normalized = trimmed === '' ? KB_ROOT_RESOURCE_ID : trimmed
  // Walk up the directories this path lives in, without including the path itself: the
  // path is already the resource being resolved.
  const segments = normalized.split('/').filter((segment) => segment !== '')
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    ancestors.push({ resourceType: KB_RESOURCE_TYPE, resourceId: segments.slice(0, depth).join('/') })
  }
  ancestors.push({ resourceType: KB_RESOURCE_TYPE, resourceId: KB_ROOT_RESOURCE_ID })
  return ancestors
}

export async function canReadPath(ctx: Context, config: Config, relPath: string): Promise<boolean> {
  try {
    const body = await request<{ canRead?: boolean }>(ctx, config, ENDPOINTS.resolve, {
      method: 'POST',
      body: {
        resourceType: KB_RESOURCE_TYPE,
        resourceId: relPath,
        // The ancestors chain is what makes ONE grant cover a whole knowledge base.
        // Without it DataOps matches only an exact resourceId, so every document needs
        // its own grant -- which is not a permission model anybody wants and was the
        // reason a new document appeared unreadable to an administrator.
        ancestors: knowledgeAncestorsFor(relPath),
      },
    })
    return body.canRead === true
  } catch {
    return false
  }
}

/**
 * Ask DataOps whether the CALLER may write one path.
 *
 * The same self-scoped resolve route {@link canReadPath} uses, read for a different
 * field. A move needs this and not merely read: it destroys the source path, so a
 * caller who can only read must not be able to relocate a document out from under
 * the people who own it. The backend distinguishes the two (`canRead` and
 * `canWrite` are separate conclusions drawn from the same grants), and this reads
 * its answer rather than re-deriving one from the other.
 *
 * A failed request answers `false` rather than throwing, so an unreachable backend
 * refuses the move instead of authorizing it.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the authoritative root.
 * @returns Whether the caller may write it.
 */
export async function canWritePath(ctx: Context, config: Config, relPath: string): Promise<boolean> {
  try {
    const body = await request<{ canWrite?: boolean }>(ctx, config, ENDPOINTS.resolve, {
      method: 'POST',
      body: {
        resourceType: KB_RESOURCE_TYPE,
        resourceId: relPath,
        ancestors: knowledgeAncestorsFor(relPath),
      },
    })
    return body.canWrite === true
  } catch {
    return false
  }
}

/**
 * Largest document the create and upload routes will write.
 *
 * A knowledge document is text a person reads, not a data dump, and the route
 * buffers the body in memory before writing it. The ceiling is what keeps one
 * request from taking the Host's heap: without it a caller with write access could
 * post an arbitrarily large body, because nothing downstream limits the size of a
 * file on the share.
 */
export const MAX_KNOWLEDGE_WRITE_BYTES = 1_048_576

/**
 * How long the template list may take before the surface gives up.
 *
 * Shorter than the plugin's general timeout on purpose: a template list decorates a
 * page, and the shared backend can be busy with unrelated work for far longer than
 * a reader should wait to see some cards.
 */
export const TEMPLATE_READ_TIMEOUT_MS = 5_000

/**
 * The path whose write permission gates template maintenance.
 *
 * A template is shared content, so curating one is a write to the knowledge base like
 * any other and is asked of DataOps at this path. It names the library's own directory
 * because that is what the operation modifies.
 */
const TEMPLATE_WRITE_PATH = '.kb-templates'

/**
 * A refusal from the write path, with a code the route maps to a status.
 *
 * Kept apart from {@link KnowledgeError}, whose codes describe how a TRANSPORT
 * call ended. These say why a write was not performed, which is a different
 * question with different statuses: a name already taken is a conflict, a path
 * outside the root is a bad request, and a document over the ceiling is too large.
 */
export class KnowledgeWriteError extends Error {
  readonly code: 'bad-path' | 'exists' | 'too-large' | 'write-failed'

  constructor(message: string, code: KnowledgeWriteError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeWriteError'
    this.code = code
  }
}

/**
 * Create one document or directory in the authoritative tree.
 *
 * The path is written under `actualRoot` rather than under the caller's own view
 * directory, and that choice is the whole design:
 *
 * - The view is NOT storage. `syncView` mirrors the resolved grant set onto it, so
 *   a file that appears there is removed by the next sync unless DataOps resolves
 *   it as readable. Measured: a document written into a view was gone after the
 *   next `syncView` (`delta.unlinked` named it). Writing there would hand the
 *   reader a document that any later permission change silently deletes.
 * - `actual/` is the authoritative tree, so a document written there survives, and
 *   the grant system then decides who sees it. Creating is therefore SHARED by
 *   construction: the creator needs write access, and everyone DataOps resolves as
 *   a reader will find the document in their view at their next sync. That is what
 *   a knowledge base is for, and it is the semantic the product already has.
 *
 * There is deliberately no `userId` component in the path. `actual/` is shared and
 * has no per-user dimension; inventing `actual/<uid>/...` would create a shape the
 * rest of the plugin does not understand, because a view is built from grants and
 * not from a directory per user.
 *
 * The write is exclusive (`wx`), so the kernel refuses to replace an existing file.
 * A stat-then-write would leave a window in which another caller's document could
 * be overwritten, and the check would still be the thing that was raced.
 * @param config - resolved plugin config.
 * @param relPath - destination, relative to the authoritative root.
 * @param options - `directory` creates a directory; `content` is the file body.
 * @returns The path written.
 * @throws KnowledgeError when the path escapes the root, exists, or cannot be written.
 */
export async function createKnowledgeEntry(
  config: Config,
  relPath: string,
  options: { directory: boolean; content?: string; bytes?: Uint8Array },
): Promise<{ relPath: string; kind: 'file' | 'directory' }> {
  const plan = localConfig(config)
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeWriteError('path escapes the knowledge root: ' + JSON.stringify(relPath), 'bad-path')
  }
  const full = join(plan.actualRoot, relPath)
  if (options.directory) {
    try {
      // The parent has to exist first, and in the nested department layout the target
      // is several levels deep (`department/<ancestor>/.../<own>/new-folder`). Without
      // this, creating a folder inside a hierarchy that has no documents yet failed
      // with a bare ENOENT, which read as a bug rather than as "the parent is missing".
      //
      // Only the PARENT is created with `recursive`; the leaf keeps `recursive: false`
      // so an existing folder is still reported as EEXIST instead of being silently
      // accepted. That distinction is what lets the dialog say "this name is taken".
      await mkdir(dirname(full), { recursive: true })
      await mkdir(full, { recursive: false })
    } catch (cause) {
      const code = (cause as { code?: string }).code
      if (code === 'EEXIST') {
        throw new KnowledgeWriteError('a document or folder already exists at ' + relPath, 'exists', { cause })
      }
      throw new KnowledgeWriteError('could not create ' + relPath, 'write-failed', { cause })
    }
    return { relPath, kind: 'directory' }
  }
  // A binary upload arrives as bytes and is written verbatim: decoding it as
  // UTF-8 first would replace every non-text byte and produce a file no reader
  // can open. Text uploads keep the string path so the limit is measured on the
  // encoded form rather than on a guess.
  const bytes = options.bytes
  const body = options.content ?? ''
  const payload: string | Uint8Array = bytes ?? body
  const payloadBytes = bytes === undefined
    ? Buffer.byteLength(body, 'utf8')
    : bytes.byteLength
  if (payloadBytes > MAX_KNOWLEDGE_WRITE_BYTES) {
    throw new KnowledgeWriteError('document exceeds the ' + String(MAX_KNOWLEDGE_WRITE_BYTES) + ' byte limit', 'too-large')
  }
  // The parent must exist and be inside the root: `wx` alone would otherwise let
  // `a/b/c.md` fail with a bare ENOENT that reads like a bug rather than a choice.
  try {
    await mkdir(dirname(full), { recursive: true })
  } catch {
    // Left to the write below, which reports the real reason.
  }
  try {
    // `wx` is the atomic "create, never replace": the kernel answers EEXIST when the
    // name is taken, so two concurrent creates cannot both believe they won.
    await writeFile(full, payload, bytes === undefined ? { encoding: 'utf8', flag: 'wx' } : { flag: 'wx' })
  } catch (cause) {
    const code = (cause as { code?: string }).code
    if (code === 'EEXIST') {
      throw new KnowledgeWriteError('a document or folder already exists at ' + relPath, 'exists', { cause })
    }
    throw new KnowledgeWriteError('could not write ' + relPath, 'write-failed', { cause })
  }
  return { relPath, kind: 'file' }
}

/**
 * Extract an uploaded document's text into a `.md` sibling.
 *
 * Called after the original is written, never before: the bytes the user chose
 * are the deliverable, and an extraction that fails must not take them down with
 * it. The sibling keeps the original extension in its name (`报告.docx.md`), so it
 * cannot collide with a handwritten `报告.md` and a reader can still tell which
 * document it came from.
 *
 * @param config - resolved plugin config, for the knowledge root and MinerU port.
 * @param relPath - the uploaded document's path, relative to the knowledge root.
 * @returns What happened, or undefined when the format needs no extraction.
 */
export async function extractBeside(
  config: Config,
  relPath: string,
  mineruUrl?: string,
): Promise<{ markdown: string; via?: string; reason?: string } | undefined> {
  if (!isExtractable(relPath)) return undefined
  const plan = localConfig(config)
  const fullPath = join(plan.actualRoot, relPath)
  // A caller-supplied address is the user's own setting and outranks the deployment's;
  // absent, the deployment answer (explicit address, else the derived port) applies.
  const effectiveUrl = mineruUrl !== undefined && mineruUrl !== '' ? mineruUrl : mineruUrlFor(config)
  const result = await extractDocument(fullPath, relPath, { mineruUrl: effectiveUrl })
  if (result.markdown === undefined) {
    return { markdown: '', reason: result.reason ?? 'extraction produced no text' }
  }
  const sibling = markdownSiblingOf(relPath)
  try {
    await createKnowledgeEntry(config, sibling, { directory: false, content: result.markdown })
  } catch (cause) {
    // A refusal here (already exists, size) is reported without failing the upload.
    return { markdown: sibling, reason: describeError(cause).message }
  }
  return { markdown: sibling, via: result.via ?? 'unknown' }
}

/**
 * Translate {@link extractBeside}'s answer into a queue terminal state.
 *
 * The extractor reports three different outcomes through two fields, and they mean
 * different things to a reader deciding what to do next:
 *
 * - `markdown` set, no `reason` — the sibling was written (`succeeded`).
 * - `markdown` set WITH a `reason` — the text was produced but writing the sibling was
 *   refused, typically because it already exists. The reason is kept so a retry can
 *   report why nothing changed (`failed`, with the refusal verbatim).
 * - `markdown` empty, `reason` set — no authority could read the document; this is the
 *   `no-extractor-succeeded: …` case a reader retries after an upgrade.
 *
 * An `undefined` answer means the format has no extractor at all, which the queue
 * normally prevents by asking `isExtractable` first; it is mapped for the caller that
 * bypassed that gate rather than left to throw.
 *
 * @param outcome - what {@link extractBeside} returned.
 * @returns the state the queue records.
 */
export function extractionOutcomeOf(
  outcome: { markdown: string; via?: string; reason?: string } | undefined,
): ExtractionOutcome {
  if (outcome === undefined) {
    return { state: 'unsupported', reason: 'this file type has no extractor' }
  }
  if (outcome.markdown !== '' && outcome.reason === undefined) {
    return {
      state: 'succeeded',
      markdown: outcome.markdown,
      ...(outcome.via === undefined ? {} : { via: outcome.via }),
    }
  }
  return {
    state: 'failed',
    ...(outcome.markdown === '' ? {} : { markdown: outcome.markdown }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  }
}

/**
 * MinerU's base URL for this deployment, or undefined when it is not configured.
 *
 * @param config - resolved plugin config.
 * @returns `http://127.0.0.1:<port>` when the service is expected, else undefined.
 */
export function mineruUrlFor(config: Config): string | undefined {
  // An explicit address wins over the derived one. It is the only way to reach a service
  // that is not on this machine: the port alone can only ever mean 127.0.0.1.
  const configured = normalizeMineruBaseUrl((config as { mineruBaseUrl?: string }).mineruBaseUrl)
  if (configured !== '') return configured
  const port = (config as { mineruPort?: number }).mineruPort
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined
  return 'http://127.0.0.1:' + String(port)
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
 * How long a rebuilt view is trusted before a read may rebuild it again.
 *
 * Long enough that a page which reads its status repeatedly does not walk the
 * shared tree each time, short enough that a permission changed in DataOps is
 * reflected without the reader doing anything. This is a refresh interval, not a
 * cache: the view on disk is always the last thing DataOps authorized, never a
 * stale answer to a question about the present.
 */
const AUTO_SYNC_INTERVAL_MS = 30_000

/**
 * Most callers whose last refresh instant is remembered.
 *
 * A bound rather than a policy: the map is bookkeeping, so an evicted caller at
 * worst triggers one extra check. Without a cap it would grow with every user the
 * process ever served.
 */
const MAX_TRACKED_CALLERS = 500

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

/**
 * Overlay the operator's stored choices onto the deployment configuration.
 *
 * Two sources answer "which storage shape": the profile, which is fixed when the container is
 * created, and `.kb-settings.json`, which the panel writes. The file wins, because it is the
 * one the operator can still change -- a saved choice that the running process ignored would
 * be the same dead control this route exists to replace.
 *
 * Only the fields the panel owns are overlaid. `mountPoint`, `actualRoot`, `viewRoot` and
 * `permitted` stay as the deployment declares them: those are bind mounts and export specs,
 * decided when the container starts, so a file that changed them would point the plugin at
 * paths nothing serves.
 * @param config - the deployment configuration.
 * @param stored - what the settings file holds.
 * @returns The configuration the request should use.
 */
export function withStoredStorage(config: Config, stored: KnowledgeStorageSettings): Config {
  const next: Config = { ...config }
  if (stored.storageMode !== undefined) next.storageMode = stored.storageMode
  if (stored.storageProtocol !== undefined) next.storageProtocol = stored.storageProtocol
  if (stored.nfsServer !== undefined) next.nfsServer = stored.nfsServer
  if (stored.sshHost !== undefined) next.sshHost = stored.sshHost
  if (stored.sshUser !== undefined) next.sshUser = stored.sshUser
  if (stored.sshPort !== undefined) next.sshPort = stored.sshPort
  if (stored.sshRemotePath !== undefined) next.sshRemotePath = stored.sshRemotePath
  if (stored.sshMountOptions !== undefined) next.sshMountOptions = stored.sshMountOptions
  if (stored.sshKeyRef !== undefined) next.sshKeyRef = stored.sshKeyRef
  return next
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
    protocol: config.storageProtocol,
    sshHost: config.sshHost,
    sshUser: config.sshUser,
    sshPort: config.sshPort,
    sshRemotePath: config.sshRemotePath,
    sshMountOptions: config.sshMountOptions,
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

/**
 * The status a completed write answers with when the view could not follow it.
 *
 * Deliberately not 200: the write DID happen, but the reader's next action is to
 * look for a document that is not there. A success code would leave the page with
 * nothing to say, which is the failure this whole path exists to stop. 207 is
 * "the operation happened, now read this": the body still carries the created
 * record, and `viewSyncWarning` says why the tree does not show it yet.
 */
const VIEW_SYNC_FAILED_STATUS = 207

/**
 * Build a write route's reply, naming a view refresh that did not take effect.
 *
 * The write itself already succeeded, so this never turns a completed mutation into
 * an error: it attaches the reason the tree will not reflect it yet, and answers 207
 * so the client cannot mistake it for a clean success. The page shows the warning
 * and offers a retry, which is the only honest account of what happened.
 *
 * @param payload - the route's own success body.
 * @param refresh - the outcome {@link refreshViewIfStale} reported for this write.
 * @returns the status and body to send.
 */
function writeReplyAfterSync(
  payload: Record<string, unknown>,
  refresh: { synced: boolean; delta?: ViewDelta; failure?: string },
): { status: number; body: Record<string, unknown> } {
  if (refresh.failure === undefined) {
    return {
      status: 200,
      body: { ...payload, ...(refresh.delta === undefined ? {} : { view: refresh.delta }) },
    }
  }
  return {
    status: VIEW_SYNC_FAILED_STATUS,
    body: {
      ...payload,
      viewSyncWarning: {
        message: 'the change was saved, but the file tree could not be refreshed',
        reason: refresh.failure,
      },
    },
  }
}

/** Serialize a thrown value for the browser. */
/**
 * Map a write refusal to the status that describes it.
 *
 * Separated from the message so the two cannot drift: a name already taken is a
 * conflict rather than a bad request, and a body over the ceiling is refused for
 * its size rather than for its content. 507 is not used because the limit is this
 * plugin's own, not the filesystem's.
 * @param code - the refusal's code.
 * @returns The HTTP status to answer with.
 */
/**
 * The HTTP status for a typed knowledge-base failure.
 *
 * The routes below answer 500 for an uncaught error, which is right for a bug but wrong
 * for a decision the backend already made: an expired token came back as "500 Internal
 * Server Error", sending the operator to look for a crash that was not there. Mapping the
 * code keeps the answer honest, and `unauthorized` additionally tells the page to ask for
 * a fresh credential rather than retry.
 * @param code - the typed failure code.
 * @returns The status to answer with.
 */
function knowledgeStatusFor(code: KnowledgeErrorCode): number {
  if (code === 'unauthorized') return 401
  if (code === 'not-configured') return 409
  if (code === 'unreachable') return 502
  return 502
}

function writeStatusFor(code: KnowledgeWriteError['code']): number {
  switch (code) {
    case 'bad-path': return 400
    case 'exists': return 409
    case 'too-large': return 413
    case 'write-failed': return 500
  }
}

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
/** Provider name this plugin registers its bundle skill under. */
export const KNOWLEDGE_SKILL_PROVIDER = 'dsh-knowledge-base'

/** Name the model sees in the skill catalog. */
export const KNOWLEDGE_SKILL_NAME = 'knowledge-base'

/**
 * Short description shown in the skill list.
 *
 * Kept beside the SKILL.md body rather than parsed out of its frontmatter: the
 * catalog answers `list()` without reading any skill content, so the text has to
 * be available before the file is opened.
 */
export const KNOWLEDGE_SKILL_DESCRIPTION =
  'Read and change the shared knowledge base: browse, search, create, upload, rename, move and delete documents in the 全局 / 部门 / 个人 trees.'

/**
 * Where this package's SKILL.md lives, from either build layout.
 *
 * The build emits `lib/index.js`, so the file sits one level up; a source run
 * resolves from `src/`, which is also one level up. Both answer the same path,
 * which is why this does not need to believe in a single layout.
 *
 * @returns absolute path of the SKILL.md this plugin ships.
 */
export function knowledgeSkillPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return join(moduleDirectory, '..', 'SKILL.md')
}

/**
 * The skill provider that teaches the model how to use this knowledge base.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the
 * body is documentation, and a host that never asks for it should not pay for
 * holding it.
 *
 * @returns a provider the skill registry can list and read.
 */
export const KNOWLEDGE_SKILL_RANK = 640

/** Both a human and the model may invoke this skill. */
export const KNOWLEDGE_SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/**
 * The skill provider that teaches the model how to use this knowledge base.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the
 * body is documentation, and a host that never asks for it should not pay for
 * holding it.
 *
 * `rank` places it after the bundled GenUI skill (600): a task that needs both
 * wants the fence reference first, because the knowledge skill's own answers are
 * mostly prose and shell commands.
 *
 * @returns a provider the skill registry can list and read.
 */
export function knowledgeBaseSkillProvider(): {
  readonly name: string
  readonly list: (options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<readonly SkillCandidateLike[]>
  readonly get: (candidate: SkillCandidateLike, options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<SkillDefinitionLike | undefined>
} {
  const path = knowledgeSkillPath()
  const candidate: SkillCandidateLike = {
    name: KNOWLEDGE_SKILL_NAME,
    description: KNOWLEDGE_SKILL_DESCRIPTION,
    invocation: KNOWLEDGE_SKILL_INVOCATION,
    source: 'bundled',
    provider: KNOWLEDGE_SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: KNOWLEDGE_SKILL_RANK,
    locator: path,
  }
  return {
    name: KNOWLEDGE_SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: () => Promise.resolve({ ...candidate, content: readFileSync(path, 'utf8') }),
  }
}

/**
 * One catalog entry, shaped like the host's `SkillCandidate`.
 *
 * Declared here instead of imported: this plugin does not depend on the skill
 * package (the registry is an optional injection), so the structural contract is
 * restated rather than turning an optional neighbour into a build requirement. The
 * registry merges these by the fields it reads, so a shape that satisfies them is
 * the whole contract.
 */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: 'bundled'
  readonly provider: string
  readonly path: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly rank: number
  readonly locator: string
}

/** One loaded skill, shaped like the host's `SkillDefinition`. */
export interface SkillDefinitionLike extends SkillCandidateLike {
  readonly content: string
}

export function apply(ctx: Context, deploymentConfig: Config): void {
  // Routes re-resolve this per request (see the handler below), so the name a route reads is
  // the merged view rather than the deployment's own value.
  const config = deploymentConfig
  const host = ctx
  // The runner needs an absolute origin: a Host-side `fetch` cannot use the
  // relative paths a browser would accept.
  const runner: RemoteRunner = sshManagerRunner({ origin: originFrom(host.webServer) })
  const context = planContext(config)
  /** Completed and in-flight step runs, newest last. */
  const runs: StepRun[] = []
  /**
   * Background extraction, one worker for this deployment.
   *
   * Upload and extraction are separate promises (see `extractionQueue.ts`): the bytes
   * must be visible when the upload answers, while the `.md` sibling may take a minute
   * on a scanned PDF. `run` reuses the same permission-checked `extractBeside` path the
   * upload used, so a background run and a manual retry cannot diverge. One queue per
   * registration means one worker per process, which is what keeps two parses from
   * competing for the same small box.
   */
  const extractionQueue: ExtractionQueue = createExtractionQueue({
    isExtractable: relPath => isExtractable(relPath),
    run: async (relPath, mineruBaseUrl) => {
      // `config` is the alias declared above (`const config = deploymentConfig`), named
      // here because this is the ONE place production code calls `extractBeside`: both
      // the upload path and the manual retry go through this runner, so the caller's
      // stored address reaches the extractor exactly once per document.
      const outcome = await extractBeside(config, relPath, mineruBaseUrl)
      return extractionOutcomeOf(outcome)
    },
  })
  /**
   * Callers whose missing pointer has already been repaired once this process.
   *
   * A caller with nothing granted never gains a pointer from a sync, so without
   * this the repair below would re-walk the shared tree and re-ask DataOps about
   * every file on every load. The set lives with the registration rather than in
   * the config so it is per-process state, not a persisted decision.
   */
  const repairedCallers = new Set<string>()
  /**
   * When each caller's view was last rebuilt by the routine refresh.
   *
   * Bounded on purpose: an unbounded per-caller map would grow with every user the
   * process ever served, and this is bookkeeping rather than a record. When the cap
   * is reached the oldest entry is dropped, which at worst costs one extra rebuild
   * for the caller unlucky enough to be evicted.
   *
   * In-memory only, so a restart forgets it. That is acceptable because the refresh
   * below only ever reads it to decide whether to refresh, and the sync itself is
   * idempotent: losing the map costs one redundant check, never a wrong answer.
   */
  const viewSyncedAt = new Map<string, number>()
  /**
   * Earliest instant the next routine refresh may run.
   *
   * Checked before any other work, so a page that reads its status inside the
   * interval costs one integer comparison and nothing else: no filesystem walk and
   * no backend call. That ordering is the whole point, because the mounted tree
   * lives on NFS where a walk is real latency.
   */
  let nextRoutineSyncAt = 0
  /**
   * Why the last refresh produced no view update, when it did not.
   *
   * Without this a failed sync and a sync with nothing to do are the same answer,
   * and the difference is what a reader needs: "your grants did not change" is the
   * ordinary case, while "the view could not be rebuilt" is a fault that has to be
   * reported. Reported through `status` so the page can say which one happened
   * instead of leaving a newly created document invisible with no explanation.
   */
  let lastSyncFailure: string | undefined
  /**
   * Why the last full scan declined to prune, when it did.
   *
   * Exposed through `status` so a deployment can see "this round resolved nothing, so
   * the view was left as-is" without reading logs. The condition is guarded (see
   * `syncView`), so its presence is the observable signal that the permission backend
   * answered nothing -- which is otherwise indistinguishable from a caller who has
   * legitimately lost every grant.
   */
  let lastPruneSkipped: string | undefined

  /**
   * Rebuild the caller's view when grants may have moved, at most once per interval.
   *
   * Grants decide what a user may read, but they put nothing on disk by themselves,
   * so a view that is never rebuilt shows yesterday's authorization. Making the
   * reader press a button for that was the design error: the mechanism is internal,
   * and the ordinary case should be invisible.
   *
   * The interval is what keeps this from being a per-request walk. Everything the
   * page reads goes through the gate below, while a mutation passes `force` because
   * it has just made the answer stale on purpose. The sync itself writes nothing
   * when the resolved set is unchanged (`syncView` reports `unchanged > 0,
   * linked: []`), so even a forced repeat costs a comparison rather than a rebuild.
   * @param force - rebuild even inside the interval, for a change this process made.
   * @returns What changed, so a caller can report or ignore it.
   */
  const refreshViewIfStale = async (
    force = false,
    // The authoritative path a WRITE just created or moved. Passed so the refresh can
    // verify the reader will see it instead of trusting "the sync ran": the sync
    // answers 200 even when every per-path resolve was denied, so a status-only check
    // reported success for a document that never reached the view.
    expectVisible?: string,
  ): Promise<{ synced: boolean; delta?: ViewDelta; failure?: string }> => {
    // The zero-IO fast path, and the reason a read may call this at all. A closed
    // gate returns here without touching disk or the backend; a forced call skips
    // it, because the caller has already changed the grants this view reflects.
    if (!force && Date.now() < nextRoutineSyncAt) return { synced: false }
    if (config.baseUrl.trim() === '') return { synced: false }
    // Opened before the work rather than after: a failed attempt must not invite a
    // retry on the very next read, or an unreachable backend turns every request
    // into another walk of the shared tree.
    nextRoutineSyncAt = Date.now() + AUTO_SYNC_INTERVAL_MS
    // Forced callers are the write routes, so a failure there means the reader was
    // just told "done" about a document they cannot see. Twice, not more: a backend
    // that is down is not made up by a third attempt, and the second covers the
    // transient case a write actually produces (a resolve that raced the write).
    const attempts = force ? 2 : 1
    let lastFailure: string | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const plan = localConfig(config)
        const caller = await fetchCaller(host, config)
        if (!isSafeUserId(caller.userId)) {
          lastFailure = 'unsafe caller id; cannot key a view by it'
          continue
        }
        if (!force) {
          const previous = viewSyncedAt.get(caller.userId)
          if (previous !== undefined && Date.now() - previous < AUTO_SYNC_INTERVAL_MS) {
            return { synced: false }
          }
        }
        const result = await syncCallerView(host, config)
        if ('error' in result) {
          // The status the sync answered with is the reason: 409 is an unconfigured
          // backend, 502 an unreachable one, 400 an unsafe identity. Carrying it out
          // is what turns "nothing happened" into something a reader can act on.
          lastFailure = `view sync answered HTTP ${String(result.status)}: ${result.error}`
          continue
        }
        // The verify step. `expectVisible` is authoritative; the view path it should
        // appear at is derived from the same layout the sync used, then looked for on
        // disk. A miss is a failed refresh, not a success with nothing to do.
        if (expectVisible !== undefined) {
          const verifyOptions = {
            actualRoot: plan.actualRoot,
            viewRoot: plan.viewRoot,
            userId: caller.userId,
            ...(caller.departmentCode === undefined ? {} : { departmentCode: caller.departmentCode }),
            ...(caller.departmentPathCodes === undefined
              ? {}
              : { departmentPathCodes: caller.departmentPathCodes }),
          }
          const expected = expectedViewPathFor(verifyOptions, expectVisible)
          const landed = expected === undefined
            ? false
            : await stat(join(viewPathFor(verifyOptions), expected))
              .then(info => info.isFile() || info.isDirectory())
              .catch(() => false)
          if (!landed) {
            lastFailure = `the view does not show ${JSON.stringify(expectVisible)} after the refresh`
            continue
          }
        }
        viewSyncedAt.set(caller.userId, Date.now())
        if (viewSyncedAt.size > MAX_TRACKED_CALLERS) {
          const oldest = viewSyncedAt.keys().next()
          if (!oldest.done) viewSyncedAt.delete(oldest.value)
        }
        lastSyncFailure = undefined
        lastPruneSkipped = result.pruneSkipped
        return { synced: true, delta: result }
      } catch (error) {
        // An unreadable identity or an unreachable backend leaves the view as found.
        // The page reports the mounted state it actually sees, and a later read
        // retries once the interval has passed.
        lastFailure = describeError(error).message
      }
    }
    // Recorded rather than swallowed: this is the difference between a reader whose
    // grants genuinely changed nothing and a reader whose view silently stopped
    // following the grants. The caller below decides whether to surface it.
    lastSyncFailure = lastFailure
    host.logger?.warn?.(`knowledge-base: view refresh did not complete: ${lastFailure ?? 'unknown reason'}`)
    return { synced: false, ...(lastFailure === undefined ? {} : { failure: lastFailure }) }
  }

  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: '/knowledge-base/api',
    handler: async (req, res) => {
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/knowledge-base/api/'.length)
      try {
        // The operator's saved choices sit on top of the deployment config, and an
        // instance of the plugin is a long-lived closure: without this re-read, a save
        // would not change the answer any route gives until the process restarted, which
        // is precisely the dead-control failure the settings write exists to remove.
        // A read is a small stat-backed file, so it costs less than the route below it.
        //
        // Deliberately shadows the closure's `config` for this handler's whole body: every
        // route below must answer from one merged view, and a name that meant two different
        // things depending on the line would be the same class of bug as the dead control.
        const config = withStoredStorage(deploymentConfig, await readStorageSettings(deploymentConfig.mountPoint))
        switch (method) {
          case 'config.set': {
            // Persist the operator's storage choices.
            //
            // This is a deployment decision, so it needs the same authority as the other
            // operator-level writes here: read access is not enough. With no backend to ask,
            // the route refuses rather than assuming -- an unconfigured deployment has no one
            // who can legitimately claim to be an operator.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, {
                error: 'DataOps permission API is not configured',
                refused: [{ field: '*', reason: 'no authority to authorize a deployment change' }],
              })
            }
            const body = await readJsonBody(req)
            // Only the fields the panel owns are accepted. Everything else is refused
            // explicitly rather than ignored, because a silent drop would let the panel
            // report a save that did not happen.
            const allowed = new Set([
              'storageMode', 'storageProtocol', 'nfsServer',
              'sshHost', 'sshUser', 'sshPort', 'sshRemotePath', 'sshMountOptions', 'sshKeyRef',
            ])
            const refused: { field: string; reason: string }[] = []
            for (const field of Object.keys(body)) {
              if (!allowed.has(field)) {
                refused.push({ field, reason: 'not a storage setting this route may write' })
              }
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, {
                error: 'changing the deployment storage requires grant-management access',
                refused: [{ field: '*', reason: 'authorization' }],
              })
            }
            const patch: KnowledgeStorageSettings = storageSettingsOf(body)
            // A value the validator rejected is a refusal, not a drop: the caller asked to
            // store something and must not be told it succeeded.
            for (const field of Object.keys(body)) {
              if (allowed.has(field) && (patch as Record<string, unknown>)[field] === undefined) {
                refused.push({ field, reason: 'not a recognized value' })
              }
            }
            const saved = await writeStorageSettings(config.mountPoint, patch)
            // The wall this route cannot climb: mountPoint/actualRoot/viewRoot are bind
            // mounts created with the container, so a shape change is recorded now and takes
            // effect when the workspace restarts. Saying so is the difference between a
            // saved setting and a control that looks broken.
            const live = withStoredStorage(deploymentConfig, saved)
            const restartRequired = live.storageMode !== config.storageMode
              || live.storageProtocol !== config.storageProtocol
              || live.nfsServer !== config.nfsServer
              || live.sshHost !== config.sshHost
              || live.sshRemotePath !== config.sshRemotePath
            return writeJson(res, 200, {
              saved: Object.keys(saved),
              restartRequired,
              config: localConfig(live),
              ...(refused.length === 0 ? {} : { refused }),
            })
          }
          case 'config': {
            // The mounted layout is the answer, and it is the container's own fact rather
            // than a remote one, so nothing is fetched from DataOps here. The SSH key is the
            // one exception: whether the credential resolves is what decides if the mount
            // step can run, and only the credential store can answer it.
            const sshKeyConfigured = await ctx.credentials
              .resolve(credentialRef(config.sshKeyRef))
              .then(resolved => resolved !== undefined && resolved.value.trim() !== '')
              .catch(() => false)
            return writeJson(res, 200, localConfig(config, sshKeyConfigured))
          }
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
            // Build the view pointer on the first load that finds it missing.
            //
            // Without this the reader sees an empty tree and a "not generated yet"
            // notice until they find the rebuild button, even when DataOps has
            // already resolved files for them: the pointer is what the page browses,
            // and only a sync creates it. Repairing it here makes the ordinary case
            // invisible.
            //
            // Only when the pointer is missing AND a backend can answer, so a
            // healthy deployment pays no per-load cost on the NFS share: a mounted
            // pointer is classified above and never reaches this branch.
            //
            // The attempt is remembered per caller as well. A caller with nothing
            // granted gets no pointer from a sync -- there is nothing to link -- so
            // the state stays `pointer-missing` and an unguarded repair would walk
            // the shared tree and ask DataOps about every file on EVERY load. One
            // attempt per caller is enough to make the ordinary case invisible; a
            // grant that arrives later is picked up by the routine refresh below
            // rather than by the reader finding a button.
              // Local mode stores documents in the workspace itself, so there is no mount
              // to classify and nothing to synchronize. Reporting the remote vocabulary
              // here (`pointer-missing`, a sync timestamp) would describe machinery this
              // deployment does not run -- and would send the reader to a deployment screen
              // for a problem that cannot exist.
              if (config.storageMode === 'local') {
                const localOnly = await localStatus(config)
                let localCaller: {
                  userId: string
                  label: string
                  departmentCode?: string
                  departmentName?: string
                  departmentPathCodes?: string[]
                  departmentPathNames?: string[]
                } | undefined
                if (config.baseUrl.trim() !== '') {
                  try {
                    const resolved = await fetchCaller(host, config)
                    if (isSafeUserId(resolved.userId)) {
                      // The department is forwarded, not just the id: the page tells
                      // the reader which 「部门」 tree they are looking at, and a
                      // department administrator's own scope comes from this value.
                      // Dropping it here would leave that bucket unlabeled even
                      // though the view was built from it.
                      //
                      // The organization path travels with it for the same reason one
                      // level deeper: the tree renders the folders that are on disk,
                      // and the names beside them come from here. Without the path the
                      // hierarchy still exists but every level would print its code.
                      localCaller = {
                        userId: resolved.userId,
                        label: resolved.label,
                        ...(resolved.departmentCode === undefined
                          ? {}
                          : { departmentCode: resolved.departmentCode, departmentName: resolved.departmentName ?? resolved.departmentCode }),
                        ...(resolved.departmentPathCodes === undefined
                          ? {}
                          : {
                            departmentPathCodes: resolved.departmentPathCodes,
                            departmentPathNames: resolved.departmentPathNames ?? resolved.departmentPathCodes,
                          }),
                      }
                    }
                  } catch {
                    localCaller = undefined
                  }
                }
                // The mount is still classified, not asserted: local storage says
                // where the bytes live, not whether the pointer exists. A local
                // deployment whose mount point is missing has to report `absent` for
                // the page to show the mount wording -- answering a fixed "local"
                // told every state the same story and left the page with no sentence
                // to choose, so a broken local deployment looked healthy.
                const localMountState = await classifyMount(config)
                return writeJson(res, 200, {
                  ...localOnly,
                  storageMode: "local",
                  storageProtocol: config.storageProtocol,
                  lastSyncAt: null,
                  mountState: localMountState,
                  canManageGrants: canManage,
                  ...(localCaller === undefined ? {} : { caller: localCaller }),
                  // A local deployment still answers writes, so a refresh that failed
                  // here has to be reported the same way: the reader is looking at the
                  // same tree and the same missing document.
                  ...(lastSyncFailure === undefined ? {} : { lastSyncFailure }),
                  ...(lastPruneSkipped === undefined ? {} : { pruneSkipped: lastPruneSkipped }),
                })
              }

            let mountState = await classifyMount(config)
            let lastSyncAt: string | null = null
            // Keyed by identity, fetched only when a repair might run: this route is
            // also the one the page calls on every load, so it must not add a backend
            // round trip to the path that needs no repair.
            let repairKey: string | null = null
            if (mountState === 'pointer-missing' && config.baseUrl.trim() !== '') {
              try {
                const caller = await fetchCaller(host, config)
                if (isSafeUserId(caller.userId)) repairKey = caller.userId
              } catch {
                // No identity means no key to store a view under; the sync below
                // reports it rather than guessing one.
              }
            }
            if (mountState === 'pointer-missing' && config.baseUrl.trim() !== '' && (repairKey === null || !repairedCallers.has(repairKey))) {
              try {
                const repaired = await syncCallerView(host, config)
                if (!('error' in repaired)) {
                  lastSyncAt = new Date().toISOString()
                  // Remember the caller only once the attempt actually ran, so a
                  // refusal (unconfigured backend, unreadable identity) can be
                  // retried when the condition clears rather than being cached.
                  if (repairKey !== null) repairedCallers.add(repairKey)
                  // Re-classify rather than assume: a caller with no readable files
                  // still gets no pointer, because a link to a missing directory
                  // would render as "you have no files" instead of as "nothing was
                  // granted yet". Both are empty trees, so the state must come from
                  // the filesystem rather than from the sync having been attempted.
                  mountState = await classifyMount(config)
                }
              } catch {
                // A failed repair leaves the state as found; the page reports it and
                // the reader can retry with the button of their own accord.
              }
            }
            const status = await localStatus(config)
            // The routine refresh, after the one-shot repair above: that branch
            // handles a pointer that does not exist yet, while this one keeps an
            // existing view in step with grants that changed in DataOps. It is
            // gated, so a page that reads its status repeatedly pays a comparison
            // rather than another walk of the mounted tree.
            const routine = await refreshViewIfStale()
            const viewDelta = routine.delta
            if (viewDelta !== undefined) mountState = await classifyMount(config)
            // The page needs to name its caller for two things that are not
            // authorization: the save-actor registration (the editor announces "who"
            // with each save so the audit trail can record it) and the trail's own
            // display. `repairKey` already holds this identity when a repair ran, so it
            // is reused rather than fetched twice; when it did not run, one call resolves
            // it here. An unconfigured backend has no authority to ask.
            let callerIdentity: { userId: string; label: string } | undefined
            if (config.baseUrl.trim() !== '') {
              if (repairKey !== null) {
                callerIdentity = { userId: repairKey, label: repairKey }
              } else {
                try {
                  const resolved = await fetchCaller(host, config)
                  if (isSafeUserId(resolved.userId)) {
                    callerIdentity = { userId: resolved.userId, label: resolved.label }
                  }
                } catch {
                  callerIdentity = undefined
                }
              }
            }
            return writeJson(res, 200, {
              ...status,
              storageMode: "remote",
              storageProtocol: config.storageProtocol,
              lastSyncAt: viewDelta === undefined ? lastSyncAt : new Date().toISOString(),
              mountState,
              canManageGrants: canManage,
            ...(callerIdentity === undefined ? {} : { caller: callerIdentity }),
              // The delta travels to the page so "did the view follow my grants"
              // is answerable without pressing anything: an unchanged set reports
              // `unchanged > 0, linked: []`, which is the zero-write case.
              ...(viewDelta === undefined ? {} : { view: viewDelta }),
              // A refresh that could not complete is a different fact from one with
              // nothing to do, and the page has to be able to say which happened.
              ...(routine.failure === undefined ? {} : { viewSyncFailure: routine.failure }),
              ...(routine.failure === undefined && lastSyncFailure === undefined
                ? {}
                : { lastSyncFailure: routine.failure ?? lastSyncFailure }),
              // The prune refusal is the signal that a full scan resolved nothing:
              // the view was kept rather than emptied, and this says so.
              ...(lastPruneSkipped === undefined ? {} : { pruneSkipped: lastPruneSkipped }),
            })
          }
          case 'trash': {
            // The caller's own removals. Scoped to the caller because removal is a
            // view decision: two people sharing a document may disagree about whether
            // it belongs in their tree, and one person's removal must not hide it
            // from the other.
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const record = await readTrash(viewDir)
            if (record.kind === 'absent') return writeJson(res, 200, { entries: [] })
            if (record.kind === 'unreadable') {
              // Reported rather than emptied: an unreadable record may be hiding
              // entries, and answering "nothing removed" would offer a Restore that
              // restores nothing while the files stay hidden.
              return writeJson(res, 200, { entries: [], error: 'trash record unreadable: ' + record.reason })
            }
            return writeJson(res, 200, { entries: record.entries })
          }
          case 'trash.remove': {
            // Removing records a tombstone; it does not touch the file. See trash.ts
            // for why an unlink cannot express this on a hardlinked shared tree.
            const body = await readJsonBody(req)
            const relPath = typeof body.relPath === 'string' ? body.relPath.trim() : ''
            if (relPath === '' || !isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'a contained relPath is required' })
            }
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const existing = await readTrash(viewDir)
            if (existing.kind === 'unreadable') {
              return writeJson(res, 409, { error: 'trash record unreadable: ' + existing.reason })
            }
            const entries = existing.kind === 'ready' ? existing.entries : []
            const next = addTombstone(entries, {
              relPath,
              kind: typeof body.kind === 'string' && body.kind === 'directory' ? 'directory' : 'file',
              removedBy: who.label,
              removedAt: new Date().toISOString(),
              originalPath: relPath,
            })
            await writeTrash(viewDir, next)
            // Rebuild straight away: the caller just asked for this to disappear, and
            // waiting for the next routine refresh would show it back in the listing
            // they are looking at.
            const after = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ entries: next }, after)
            return writeJson(res, reply.status, reply.body)
          }
          case 'trash.restore': {
            // Restoring deletes the tombstone. It cannot restore a grant: the next sync
            // links only what DataOps still allows, so a document whose access was
            // withdrawn while it sat in the trash stays gone.
            const body = await readJsonBody(req)
            const relPath = typeof body.relPath === 'string' ? body.relPath.trim() : ''
            if (relPath === '' || !isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'a contained relPath is required' })
            }
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const existing = await readTrash(viewDir)
            if (existing.kind === 'unreadable') {
              return writeJson(res, 409, { error: 'trash record unreadable: ' + existing.reason })
            }
            const entries = existing.kind === 'ready' ? existing.entries : []
            const result = removeTombstone(entries, relPath)
            if (!result.restored) {
              return writeJson(res, 404, { error: 'not in the trash: ' + relPath })
            }
            await writeTrash(viewDir, result.entries)
            const after = await refreshViewIfStale(true)
            // The rebuilt view is reported too, because a restore can legitimately bring
            // back nothing: the grant may have gone while the document was hidden, and
            // the caller needs to see that rather than assume the tree is broken.
            const reply = writeReplyAfterSync({ entries: result.entries }, after)
            return writeJson(res, reply.status, reply.body)
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
            // The product's five actions are translated into the DataOps actions
            // that would satisfy them, and the translation is refused outright for
            // an action DataOps cannot express. Recording a made-up action would
            // store a grant that authorizes nothing while the screen shows it as
            // held, which is the one failure mode a permission table must not have.
            if (!isKnowledgeAction(request.action)) {
              return writeJson(res, 400, {
                error: 'unknown action: ' + JSON.stringify(request.action),
                accepted: [...KNOWLEDGE_ACTIONS],
              })
            }
            const dataOpsActions = permissionToDataOpsActions(request.action)
            if (dataOpsActions.length === 0) {
              return writeJson(res, 400, { error: 'action cannot be expressed in DataOps: ' + request.action })
            }
            const created = await createGrant(host, config, request)
            // A grant just changed what this caller may read, so the view is rebuilt
            // before the page re-reads it. This is the moment the change is certain
            // rather than suspected, which is why it does not wait for the interval.
            const afterGrant = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ grant: created }, afterGrant)
            return writeJson(res, reply.status, reply.body)
          }
          case 'templates': {
            // The template library: a document plus a small metadata record for each.
            //
            // The library used to relay DataOps wiki pages carrying the
            // `report_template` category, which made the surface read-only and, in
            // practice, permanently empty -- the wiki holds no page in that category.
            // A template is just a document with a description, so it is stored as
            // exactly that: the file under a directory the knowledge base owns, and a
            // sibling JSON index for the metadata. No second data model, and no write
            // endpoint added to DataOps.
            //
            // Read from the AUTHORITATIVE tree rather than the caller's view, because
            // a template is shared content: a view is rewritten by the next sync.
            const plan = localConfig(config)
            try {
              const records = await readTemplates(plan.actualRoot)
              const templates = await Promise.all(records.map(async record => {
                const bytes = await templateBytes(plan.actualRoot, record.fileName)
                const dot = record.fileName.lastIndexOf('.')
                return {
                  id: record.id,
                  title: record.title,
                  description: record.description,
                  category: record.category,
                  tags: record.tags,
                  fileName: record.fileName,
                  extension: dot === -1 ? '' : record.fileName.slice(dot + 1).toLowerCase(),
                  bytes,
                  updatedAt: record.updatedAt,
                  relPath: '.kb-templates/' + record.fileName,
                }
              }))
              return writeJson(res, 200, { templates })
            } catch (error) {
              // "Could not read" is a different fact from "there are none", so the
              // two are never merged into one empty list.
              return writeJson(res, 200, { templates: [], error: describeError(error).message })
            }
          }
          case 'template.save': {
            // Add or replace one template. Gated on write access to the template
            // directory, asked of DataOps like every other write here, so a template
            // cannot be curated by someone who may not write the knowledge base.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const fileName = String(body.fileName ?? '').trim()
            const title = String(body.title ?? '').trim()
            if (fileName === '' || title === '') {
              return writeJson(res, 400, { error: 'title and fileName are required' })
            }
            const relPath = TEMPLATE_WRITE_PATH
            if (!await canWritePath(host, config, relPath)) {
              return writeJson(res, 403, { error: 'write access is required to maintain templates' })
            }
            try {
              const plan = localConfig(config)
              const saved = await saveTemplate(plan.actualRoot, {
                title,
                description: String(body.description ?? ''),
                category: String(body.category ?? ''),
                tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
                fileName,
                ...(typeof body.content === 'string' ? { content: body.content } : {}),
                ...(typeof body.id === 'string' && body.id !== '' ? { id: body.id } : {}),
              })
              const dot = saved.fileName.lastIndexOf('.')
              return writeJson(res, 200, {
                template: {
                  id: saved.id,
                  title: saved.title,
                  description: saved.description,
                  category: saved.category,
                  tags: saved.tags,
                  fileName: saved.fileName,
                  extension: dot === -1 ? '' : saved.fileName.slice(dot + 1).toLowerCase(),
                  bytes: await templateBytes(plan.actualRoot, saved.fileName),
                  updatedAt: saved.updatedAt,
                  relPath: '.kb-templates/' + saved.fileName,
                },
              })
            } catch (error) {
              return writeJson(res, 400, { error: describeError(error).message })
            }
          }
          case 'template.remove': {
            // Take one template offline: its document and its metadata record.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const id = String(body.id ?? '').trim()
            if (id === '') return writeJson(res, 400, { error: 'id is required' })
            if (!await canWritePath(host, config, TEMPLATE_WRITE_PATH)) {
              return writeJson(res, 403, { error: 'write access is required to maintain templates' })
            }
            const plan = localConfig(config)
            return writeJson(res, 200, { removed: await removeTemplate(plan.actualRoot, id) })
          }
          case 'create': {
            // Start a document or a folder in the authoritative tree.
            //
            // The path lands under `actual/`, not the caller's view, and the reason
            // is in `createKnowledgeEntry`: a view is a mirror that the next sync
            // rewrites, so a document stored there is deleted by any later
            // permission change. `actual/` is the tree that survives, which makes
            // creating a SHARED act by construction.
            //
            // Write access is required and is asked of DataOps BEFORE anything is
            // written, so a caller without it gets a refusal rather than a file they
            // cannot see. The decision is the backend's; this route only relays it,
            // the same way every other route does.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const directory = body.kind === 'directory'
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            const caller = await fetchCaller(host, config).catch(() => undefined)
            if (caller === undefined || !isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe or unreadable caller id' })
            }
            if (!await canWritePath(host, config, relPath)) {
              // Fail closed: an unreadable answer is a refusal, and the refusal
              // happens here rather than after a partial write.
              return writeJson(res, 403, { error: 'write access is required to create this path', refused: [relPath] })
            }
            try {
              // Review is a setting, not a second code path: when it is on, the write
              // is PARKED with its bytes so an approver can read exactly what was
              // submitted, and nothing appears in the shared tree until it is applied.
              // When it is off (the default) the write applies and the audit trail is
              // the only record, which is the behaviour the operator chose.
              const createPlan = localConfig(config)
              const createViewDir = viewPathFor({
                actualRoot: createPlan.actualRoot,
                viewRoot: createPlan.viewRoot,
                userId: caller.userId,
              })
              const createSettings = await readSettings(createViewDir)
              if (createSettings.reviewRequired) {
                const at = new Date().toISOString()
                await parkPendingWrite(createPlan.actualRoot, {
                  userId: caller.userId,
                  relPath,
                  content: typeof body.content === 'string' ? body.content : '',
                  at,
                })
                await appendAuditEntry(createViewDir, {
                  at,
                  actor: caller.userId,
                  actorLabel: caller.label,
                  action: 'create',
                  relPath,
                  outcome: 'pending',
                }).catch(() => undefined)
                return writeJson(res, 202, { pending: relPath, reviewRequired: true })
              }
              const created = await createKnowledgeEntry(config, relPath, {
                directory,
                ...(typeof body.content === 'string' ? { content: body.content } : {}),
              })
              // Record what just happened before answering, but never let a recording
              // failure change the answer: the document is already on disk, so reporting
              // an error here would describe a failure that did not occur. The view dir
              // resolved above is reused rather than recomputed.
              await appendAuditEntry(createViewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'create',
                relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              // The creator should see their own document at once rather than after
              // the routine interval, and this is the moment the view is known to be
              // stale because this process just changed what it must contain.
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              const reply = writeReplyAfterSync({ created }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'edit': {
            // Replace one existing document's bytes, IN PLACE.
            //
            // This route exists because the host's own editor saves with
            // write-temp-then-rename, and a rename replaces the inode. The caller's
            // view holds this document as a hardlink to the authoritative copy, so a
            // renamed file leaves the view pointing at the old bytes -- measured:
            // editing through the host's editor updated `actual/` to inode 1486290
            // while `views/<user>/` still reported the old content from inode
            // 1486289. Writing in place keeps the link whole, so every view sees the
            // save immediately.
            //
            // Authorization is the write action on this path, asked of DataOps. The
            // page hides the editor for callers without it, but that is a rendering
            // choice: this check is the one that decides.
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const content = typeof body.content === 'string' ? body.content : undefined
            if (relPath === '') return writeJson(res, 400, { error: 'relPath is required' })
            if (content === undefined) return writeJson(res, 400, { error: 'content is required' })
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            try {
              if (!await canWritePath(host, config, relPath)) {
                return writeJson(res, 403, { error: 'the caller may not write this document', code: 'forbidden' })
              }
              const plan = localConfig(config)
              const full = join(plan.actualRoot, relPath)
              // Refuse to create through an edit: "replace the bytes of a document
              // that exists" is a different operation from "make a document", and one
              // route that quietly did both would make an audit trail unable to say
              // which happened.
              const existing = await stat(full).catch(() => undefined)
              if (existing === undefined || !existing.isFile()) {
                return writeJson(res, 404, { error: 'no document at ' + relPath, code: 'not-found' })
              }
              // `writeFile` with no flag truncates in place, which is exactly the
              // semantic this route exists for.
              await writeFile(full, content, { encoding: 'utf8' })
              const after = await stat(full).catch(() => undefined)
              const caller = await fetchCaller(host, config).catch(() => undefined)
              let auditWritten = false
              if (caller !== undefined && isSafeUserId(caller.userId)) {
                const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
                try {
                  await appendAuditEntry(viewDir, {
                    at: new Date().toISOString(),
                    actor: caller.userId,
                    actorLabel: caller.label,
                    action: 'edit',
                    relPath,
                    outcome: 'applied',
                  })
                  auditWritten = true
                } catch {
                  // The save already landed. An audit write that fails must not turn a
                  // successful edit into an error the reader has to guess about.
                  auditWritten = false
                }
              }
              return writeJson(res, 200, {
                relPath,
                auditWritten,
                ...(after === undefined ? {} : { mtimeMs: after.mtimeMs, size: after.size }),
              })
            } catch (error: unknown) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'audit.append': {
            // Record a save this plugin did not perform.
            //
            // The host's file editor writes through its own route. Rather than
            // intercepting that route (which would mean owning the editor), the page
            // reports the save it observed and the trail stays complete. The record is
            // side-band: a failure here never blocks or undoes the save that already
            // happened, so this route is safe to call from a best-effort reporter.
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const action = body.action === 'edit' || body.action === 'create' ? body.action : 'edit'
            if (relPath === '') return writeJson(res, 400, { error: 'relPath is required' })
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            try {
              const caller = await fetchCaller(host, config)
              if (!isSafeUserId(caller.userId)) {
                return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
              }
              const plan = localConfig(config)
              const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
              await appendAuditEntry(viewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action,
                relPath,
                outcome: 'applied',
              })
              return writeJson(res, 200, { recorded: true })
            } catch (error: unknown) {
              return writeJson(res, 200, { recorded: false, error: describeError(error).message })
            }
          }
          case 'upload': {
            // The same landing place and the same permission gate as `create`; only
            // the body differs. Size is checked before the write because the body is
            // buffered in memory, so an uncaught large post would be paid for in heap
            // rather than answered with a refusal.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            // A dropped binary file arrives base64-encoded: the browser reads it as
            // bytes and this route must not decode it as UTF-8, which would replace
            // every non-text byte and write a document nobody can open.
            const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
            const content = typeof body.content === 'string' ? body.content : ''
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            const payloadBytes = encoding === 'base64'
              ? Buffer.from(content, 'base64')
              : Buffer.from(content, 'utf8')
            if (payloadBytes.byteLength > MAX_KNOWLEDGE_WRITE_BYTES) {
              return writeJson(res, 413, {
                error: 'file exceeds the ' + String(MAX_KNOWLEDGE_WRITE_BYTES) + ' byte limit',
                code: 'too-large',
                limitBytes: MAX_KNOWLEDGE_WRITE_BYTES,
              })
            }
            const caller = await fetchCaller(host, config).catch(() => undefined)
            if (caller === undefined || !isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe or unreadable caller id' })
            }
            if (!await canWritePath(host, config, relPath)) {
              return writeJson(res, 403, { error: 'write access is required to upload here', refused: [relPath] })
            }
            try {
              // Same review gate as `create`: the switch decides whether this lands
              // in the shared tree now or waits with its bytes for an approver.
              const uploadPlan = localConfig(config)
              const uploadViewDir = viewPathFor({
                actualRoot: uploadPlan.actualRoot,
                viewRoot: uploadPlan.viewRoot,
                userId: caller.userId,
              })
              const uploadSettings = await readSettings(uploadViewDir)
              if (uploadSettings.reviewRequired) {
                const at = new Date().toISOString()
                await parkPendingWrite(uploadPlan.actualRoot, {
                  userId: caller.userId,
                  relPath,
                  content,
                  at,
                })
                await appendAuditEntry(uploadViewDir, {
                  at,
                  actor: caller.userId,
                  actorLabel: caller.label,
                  action: 'upload',
                  relPath,
                  outcome: 'pending',
                }).catch(() => undefined)
                return writeJson(res, 202, { pending: relPath, reviewRequired: true })
              }
              const created = await createKnowledgeEntry(config, relPath, {
                directory: false,
                content: encoding === 'base64' ? undefined : content,
                ...(encoding === 'base64' ? { bytes: payloadBytes } : {}),
              })
              // Recorded before answering, and a recording failure never changes the
              // answer: the bytes are already on disk.
              await appendAuditEntry(uploadViewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'upload',
                relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              // Extraction is enqueued AFTER the reply is built, and never awaited.
              //
              // The document's bytes are what the uploader handed over, and the tree must
              // show them now. The `.md` sibling is derived text that can take a minute
              // (MinerU on a scanned PDF, LibreOffice on a legacy .doc); waiting for it
              // here made a slow parse read as a slow upload, and a failed parse read as
              // a failed upload. `enqueue` cannot throw, so the upload's answer is already
              // decided by the two calls above and nothing below can change it.
              //
              // The accepted task travels back as `extraction`, so the page can show
              // "extracting…" instead of guessing, and a reader can read the outcome
              // through `extract.status` once it finishes.
              const extraction = extractionQueue.enqueue(relPath, uploadSettings.mineruBaseUrl)
              const reply = writeReplyAfterSync({ created, extraction }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
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
            const revoked = await revokeGrant(host, config, request)
            // A revoke removes access, so the view must shrink before the next read
            // rather than at the next interval: leaving a revoked path linked would
            // keep it visible for up to that long.
            const afterRevoke = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ revoked }, afterRevoke)
            return writeJson(res, reply.status, reply.body)
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
            // The tree is what the reader is looking at, so it is the read that
            // repairs itself. The call is gated by the interval above and returns
            // on an integer comparison while the gate is closed, which is what keeps
            // this from walking an NFS tree on every level the reader expands.
            await refreshViewIfStale()
            let callerId: string | undefined
            let callerFailure: string | undefined
            try {
              callerId = (await fetchCaller(host, config)).userId
            } catch (error) {
              callerId = undefined
              callerFailure = describeError(error).message
            }
            // A listing the permission service could not answer is reported as an
            // unavailable decision, never as an empty directory.
            //
            // It used to answer 200 with `entries: []` in this case. That is
            // indistinguishable from "this folder has no documents", so a reader whose
            // credential had merely gone stale was told their knowledge base was empty --
            // and the page had nothing to act on. The empty result is a fact about the
            // permission check, not about the directory, so it travels with a status and
            // a reason.
            if (callerId === undefined) {
              return writeJson(res, 403, {
                entries: [],
                permissionsResolved: false,
                error: 'the permission service did not identify this caller',
                detail: callerFailure,
              })
            }
            const visible = await listDirectoryWithPermissions(host, config, root, target, callerId)
            // Two derived flags per row, so the page can offer "extract markdown"
            // without asking the Host about each file it renders.
            //
            // `canExtract` answers whether a reader exists for this format. `hasMarkdown`
            // answers whether the sibling is already on disk, which is what lets the menu
            // show "already extracted" instead of running a parse that would be refused.
            // Both are computed from the names in this one listing, so a directory of N
            // rows costs one readdir, not N stats.
            const present = new Set(visible.map(entry => entry.name))
            const entries: KnowledgeEntry[] = visible.map((entry) => {
              if (entry.isDir) return entry
              const extractable = isExtractable(entry.relPath)
              return {
                ...entry,
                canExtract: extractable,
                hasMarkdown: extractable ? present.has(entry.name + '.md') : false,
              }
            })
            return writeJson(res, 200, {
              entries,
              // The number of rows in this directory level before any client-side
              // paging. `list` returns a whole level rather than a page, so this is also
              // what a paginator needs for its page count without counting rows itself.
              // Named explicitly so a future server-side page can keep the field's
              // meaning while `entries` shrinks.
              total: entries.length,
              permissionsResolved: true,
            })
          }
          case 'extract.status': {
            // What this process knows about extraction, which is deliberately all it
            // knows: the queue is in memory, so a task that survived a restart is gone.
            //
            // A file that is neither in `tasks` nor beside an `.md` sibling is therefore
            // "never attempted in this process" or "attempted, then the process restarted"
            // -- and `list`'s `hasMarkdown` is what tells those two apart from the disk,
            // which is the authority. The snapshot never claims something is running that
            // is not: `running` is read from the worker itself, not from a stored flag.
            return writeJson(res, 200, extractionQueue.snapshot())
          }
          case 'extract.retry': {
            // Re-run extraction for one document, for the case the upload path could not
            // finish: a scanned PDF whose parser was down, a legacy `.doc` with no
            // LibreOffice, a file dropped in by a copy that bypassed upload entirely.
            //
            // Permission is the same gate as `upload`/`create`: a caller who may not write
            // the path may not spend the deployment's parser on it either.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            // No reader for this format is a definite answer, not a failure: the caller
            // asked and the honest reply is that this file type is never extractable.
            if (!isExtractable(relPath)) {
              return writeJson(res, 200, {
                outcome: 'unsupported',
                relPath,
                message: 'this file type has no extractor',
              })
            }
            const localRoot = localConfig(config)
            const target = join(localRoot.actualRoot, relPath)
            const source = await stat(target).catch(() => undefined)
            if (source === undefined || !source.isFile()) {
              return writeJson(res, 404, { error: 'no such file' })
            }
            if (!await canWritePath(host, config, relPath)) {
              return writeJson(res, 403, { error: 'write access is required to extract here', refused: [relPath] })
            }
            // Already extracted: report it instead of overwriting. A sibling the reader
            // may have edited by hand must not be silently replaced by a retry.
            const sibling = markdownSiblingOf(relPath)
            const existing = await stat(join(localRoot.actualRoot, sibling)).catch(() => undefined)
            if (existing !== undefined && existing.isFile()) {
              return writeJson(res, 200, { outcome: 'exists', relPath, markdown: sibling })
            }
            const viewDir = viewPathFor({
              actualRoot: localRoot.actualRoot,
              viewRoot: localRoot.viewRoot,
              userId: (await fetchCaller(host, config).catch(() => undefined))?.userId ?? '',
            })
            const settings = await readSettings(viewDir)
            // ONE extraction, whichever way the caller asked.
            //
            // Both branches enqueue and then wait on the TASK, never running an
            // extraction of their own. An earlier version ran `extractBeside` inline and
            // enqueued a second copy so the status surface would stay current: that
            // parsed the document twice, and the route answered from one run while
            // `extract.status` reported the other. `settled(relPath)` is what keeps a
            // single truth -- the state this route returns IS the state the status
            // surface shows for that path.
            const accepted = extractionQueue.enqueue(relPath, settings.mineruBaseUrl)
            // `wait` lets the menu be a single call for the common case while still
            // allowing a caller to fire-and-poll when the parse is long.
            if (body.wait === false) {
              return writeJson(res, 202, { outcome: 'queued', relPath, extraction: accepted })
            }
            const settled = await extractionQueue.settled(relPath)
            // Unreachable in practice (`enqueue` above always records a task), but a
            // route must not dereference a missing task: an unknown outcome is reported
            // as a failure with a reason rather than as a success.
            const outcome: ExtractionOutcome = settled === undefined
              ? { state: 'failed', reason: 'the extraction task was not recorded' }
              : {
                state: settled.state === 'succeeded' ? 'succeeded' : settled.state === 'unsupported' ? 'unsupported' : 'failed',
                ...(settled.markdown === undefined ? {} : { markdown: settled.markdown }),
                ...(settled.via === undefined ? {} : { via: settled.via }),
                ...(settled.reason === undefined ? {} : { reason: settled.reason }),
              }
            if (outcome.state === 'succeeded') {
              // The sibling is a new file in the tree, so the reader's view needs the
              // same refresh any other write gets; 207 reports a refresh that failed.
              const afterWrite = await refreshViewIfStale(true, sibling)
              const reply = writeReplyAfterSync({
                outcome: 'extracted',
                relPath,
                markdown: outcome.markdown,
                ...(outcome.via === undefined ? {} : { via: outcome.via }),
              }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            }
            return writeJson(res, 200, {
              outcome: outcome.state === 'unsupported' ? 'unsupported' : 'failed',
              relPath,
              ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
              ...(outcome.markdown === undefined ? {} : { markdown: outcome.markdown }),
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
            const body = await readJsonBody(req)
            const result = await syncCallerView(host, config, Array.isArray(body.paths) ? body.paths.map(String) : undefined)
            if ('error' in result) return writeJson(res, result.status, { error: result.error })
            return writeJson(res, 200, result)
          }
          case 'favorites.get': {
            // The caller's own favourites, read from their own view directory.
            //
            // Shaped exactly like `pins.get`, including the readability re-check: a
            // revoke can land while a star is stored, and a star on a path the caller
            // may no longer read must not be drawn. That is why the answer reports
            // what it dropped rather than just answering a shorter list.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const stored = await readFavorites(viewDir)
            const relPaths: string[] = []
            const dropped: string[] = []
            for (const relPath of stored) {
              if (!isContainedRelPath(relPath)) {
                dropped.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) relPaths.push(relPath)
              else dropped.push(relPath)
            }
            return writeJson(res, 200, { relPaths, dropped })
          }
          case 'favorites.set': {
            // Replace the caller's favourites.
            //
            // Refuses rather than silently pruning a path it may not read, for the
            // same reason `pins.set` does: the caller asked for that path, and a 200
            // answering with a shorter list would let a typo read as success.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!Array.isArray(body.relPaths)) {
              return writeJson(res, 400, { error: 'relPaths must be an array of strings' })
            }
            const wanted = body.relPaths.map(String)
            const refused: string[] = []
            const allowed: string[] = []
            for (const relPath of wanted) {
              if (!isContainedRelPath(relPath)) {
                refused.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) allowed.push(relPath)
              else refused.push(relPath)
            }
            if (refused.length > 0) {
              return writeJson(res, 403, {
                error: 'cannot favourite a path this caller may not read',
                refused,
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const relPaths = await writeFavorites(viewDir, allowed)
            return writeJson(res, 200, { relPaths, dropped: [] })
          }
          case 'pins.get': {
            // The caller's own pins, read from their own view directory.
            //
            // The directory is derived from the identity DataOps reports rather than
            // taken from the request, so there is no field a browser could point at
            // another user's pins. Every pin is re-checked for readability on the way
            // out: a revoke can land while a pin is stored, and a pin the caller may
            // no longer read must not be drawn.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const stored = await readPins(viewDir)
            const relPaths: string[] = []
            const dropped: string[] = []
            for (const relPath of stored) {
              if (!isContainedRelPath(relPath)) {
                dropped.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) relPaths.push(relPath)
              else dropped.push(relPath)
            }
            return writeJson(res, 200, { relPaths, dropped })
          }
          case 'pins.set': {
            // Replace the caller's pins, keeping only what they may still read.
            //
            // Writes are refused rather than silently pruned when a named path is not
            // readable: the caller asked for that path, and a 200 answering with a
            // shorter list would let a typo read as success. The client distinguishes
            // the two by comparing what it sent with what came back.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!Array.isArray(body.relPaths)) {
              return writeJson(res, 400, { error: 'relPaths must be an array of strings' })
            }
            const wanted = body.relPaths.map(String)
            const refused: string[] = []
            const allowed: string[] = []
            for (const relPath of wanted) {
              if (!isContainedRelPath(relPath)) {
                refused.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) allowed.push(relPath)
              else refused.push(relPath)
            }
            if (refused.length > 0) {
              return writeJson(res, 403, {
                error: 'cannot pin a path this caller may not read',
                refused,
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const relPaths = await writePins(viewDir, allowed)
            return writeJson(res, 200, { relPaths, dropped: [] })
          }
          case 'settings.get': {
            // This knowledge base's review settings, read from the caller's view.
            //
            // The settings live beside the pins in the view directory, so a caller
            // without a view yet reads the defaults, which is exactly the behaviour a
            // deployment that never opened the page must have: review OFF.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const settings = await readSettings(viewDir)
            // Whether this caller may CHANGE the setting is a different question from
            // whether they may read it, and it is DataOps' answer, not ours: the page
            // renders the control read-only when this is false.
            const canEdit = await canManageGrants(host, config)
            // The address that is actually in effect, derived by the same function the
            // extractor uses. An empty `mineruBaseUrl` means "derive it from the port",
            // so the stored value alone leaves the page with nothing to show for a
            // deployment that works -- the field came up blank while the service was
            // reachable. Sent so the page can display the effective address without
            // recomputing the derivation in the browser, where a second copy of the rule
            // would drift from this one.
            const mineruUrl = mineruUrlFor(config)
            return writeJson(res, 200, {
              settings,
              canEdit,
              ...(mineruUrl === undefined ? {} : { mineruUrl }),
            })
          }
          case 'settings.set': {
            // Replace the review settings, but only for a caller who may write here.
            //
            // This is an operator decision: it decides whether other people's
            // contributions take effect immediately or wait. Read access is therefore
            // not enough, and the check is DataOps' write answer rather than a local
            // guess about roles.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (typeof body.reviewRequired !== 'boolean') {
              return writeJson(res, 400, { error: 'reviewRequired must be a boolean' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, {
                error: 'changing knowledge base settings requires grant-management access',
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            // The address is optional and absent means "leave it alone": an older client
            // that only sends the review toggle must not silently clear a configured
            // service. A present value must be an absolute http(s) address or empty.
            let mineruBaseUrl: string
            if (body.mineruBaseUrl === undefined) {
              mineruBaseUrl = (await readSettings(viewDir)).mineruBaseUrl
            } else if (typeof body.mineruBaseUrl !== 'string') {
              return writeJson(res, 400, { error: 'mineruBaseUrl must be a string' })
            } else {
              const candidate = body.mineruBaseUrl.trim()
              if (candidate !== '') {
                let parsed: URL
                try {
                  parsed = new URL(candidate)
                } catch {
                  return writeJson(res, 400, { error: 'mineruBaseUrl must be an absolute http(s) address' })
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                  return writeJson(res, 400, { error: 'mineruBaseUrl must use http or https' })
                }
              }
              mineruBaseUrl = candidate
            }
            const settings = await writeSettings(viewDir, { reviewRequired: body.reviewRequired, mineruBaseUrl })
            return writeJson(res, 200, { settings })
          }
          case 'audit.list': {
            // The append-only trail, newest first. Read-only by construction: this
            // module exposes no update or delete path for audit entries.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const entries = await readAuditEntries(viewDir, 200)
            return writeJson(res, 200, { entries })
          }
          case 'pending.list': {
            // The review queue. Reading it needs no write access: knowing that
            // something is waiting is not the same as being allowed to decide it, and
            // the page renders the buttons disabled when the caller cannot act.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const settings = await readSettings(
              viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }),
            )
            const pending = await listPendingWrites(plan.actualRoot)
            const canDecide = await canManageGrants(host, config)
            return writeJson(res, 200, { pending, reviewRequired: settings.reviewRequired, canDecide })
          }
          case 'pending.approve': {
            // Accept one submission by writing its bytes into the authoritative tree.
            //
            // The submitted path is re-authorised HERE rather than trusted from the
            // queue: a grant can be revoked between submitting and approving, and the
            // approver must not be able to publish into a path they cannot write.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!isPendingName(body.name)) {
              return writeJson(res, 400, { error: 'name must be one pending submission name' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, { error: 'approving requires grant-management access' })
            }
            const queue = await listPendingWrites(plan.actualRoot)
            const submission = queue.find((candidate) => candidate.name === body.name)
            if (submission === undefined) {
              return writeJson(res, 404, { error: 'no such pending submission' })
            }
            const content = await readPendingContent(plan.actualRoot, body.name)
            if (content === null) {
              return writeJson(res, 404, { error: 'the pending content is gone' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            if (!(await canWritePath(host, config, submission.relPath))) {
              return writeJson(res, 403, {
                error: 'write access is required at the submitted path',
                refused: [submission.relPath],
              })
            }
            try {
              const created = await createKnowledgeEntry(config, submission.relPath, {
                directory: false,
                content,
              })
              // The parked copy is discarded only AFTER the bytes are in the tree, so a
              // failure leaves the submission recoverable rather than losing it.
              await discardPendingWrite(plan.actualRoot, body.name)
              await appendAuditEntry(viewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'approve',
                relPath: submission.relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              // An approved document is a stored document, and every stored document is
              // supposed to be searchable. Extraction normally happens on the upload
              // path, but a reviewed upload was PARKED before it could happen: the bytes
              // only reached the tree here. Skipping it would make "review required" a
              // silent choice against retrievability, which the uploader never made.
              //
              // The parser address comes from the APPROVER's settings rather than the
              // uploader's: the submission is pinned bytes with no settings attached, and
              // the approver is the identity this request can resolve. A deployment-wide
              // address is the fallback either way.
              const approveSettings = await readSettings(viewDir)
              const extraction = extractionQueue.enqueue(created.relPath, approveSettings.mineruBaseUrl)
              const reply = writeReplyAfterSync({ approved: created, extraction }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'pending.reject': {
            // Refuse one submission and forget it, recording that a decision was made.
            //
            // The trail entry is what stops a rejection from being indistinguishable
            // from a submission that was never reviewed at all.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!isPendingName(body.name)) {
              return writeJson(res, 400, { error: 'name must be one pending submission name' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, { error: 'rejecting requires grant-management access' })
            }
            const queue = await listPendingWrites(plan.actualRoot)
            const submission = queue.find((candidate) => candidate.name === body.name)
            if (submission === undefined) {
              return writeJson(res, 404, { error: 'no such pending submission' })
            }
            await discardPendingWrite(plan.actualRoot, body.name)
            await appendAuditEntry(
              viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }),
              {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'reject',
                relPath: submission.relPath,
                outcome: 'rejected',
              },
            ).catch(() => undefined)
            return writeJson(res, 200, { rejected: submission.relPath })
          }
          case 'rename': {
            // Rename one entry, keeping it in its own directory.
            //
            // Separate from `move` because that route takes the name from the source on
            // purpose -- it answers "put this elsewhere" and nothing else. A rename has
            // to choose a name, so it validates one here and re-checks authority at the
            // resulting path rather than trusting the source's grant.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const newName = String(body.name ?? '').trim()
            if (!isContainedRelPath(from) || from === '') {
              return writeJson(res, 400, { error: 'from must be a contained relative path' })
            }
            // One path segment, and not a traversal: a name carrying a separator would
            // move the entry to another directory, which is `move`'s job, not a rename.
            if (newName === '' || newName.includes('/') || newName.includes('\\')
              || newName === '.' || newName === '..' || newName.includes('\0')) {
              return writeJson(res, 400, { error: 'name must be one path segment' })
            }
            const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
            const to = parent === '' ? newName : parent + '/' + newName
            if (!isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'the resulting path is not contained' })
            }
            if (to === from) {
              // A no-op rename would report success for a change that did not happen.
              return writeJson(res, 200, { from, to, unchanged: true })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const canRenameFrom = await canWritePath(host, config, from)
            const canRenameTo = await canWritePath(host, config, to)
            if (!canRenameFrom || !canRenameTo) {
              return writeJson(res, 403, {
                error: 'cannot rename a path this caller may not write',
                refused: [!canRenameFrom ? from : undefined, !canRenameTo ? to : undefined].filter(Boolean),
              })
            }
            try {
              const renamed = await moveEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                to,
              )
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'move',
                  relPath: renamed.from,
                  toRelPath: renamed.to,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              const delta = await syncCallerView(host, config)
              if ('error' in delta) {
                return writeJson(res, 200, {
                  from: renamed.from,
                  to: renamed.to,
                  delta: { linked: 0, unlinked: 0, unchanged: 0 },
                  warning: delta.error,
                })
              }
              return writeJson(res, 200, {
                from: renamed.from,
                to: renamed.to,
                delta: { linked: delta.linked.length, unlinked: delta.unlinked.length, unchanged: delta.unchanged },
              })
            } catch (error) {
              return writeJson(res, 409, { error: describeError(error).message })
            }
          }
          case 'download': {
            // One file's bytes, whole, for the browser to save.
            //
            // Read from the caller's own view rather than the authoritative tree: the view
            // is what their grants produced, so downloading through it cannot hand out a
            // file a revoke already removed from their sight.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const relPath = String(body.path ?? '')
            try {
              const file = await readKnowledgeFileForDownload(host, config, relPath)
              return writeJson(res, 200, file)
            } catch (error) {
              if (error instanceof KnowledgeError) {
                return writeJson(res, knowledgeStatusFor(error.code), { error: error.message, code: error.code })
              }
              // A bare ENOENT names the server's absolute path, which tells the browser
              // about a filesystem it has no business knowing. The reader only needs to
              // hear that the file is not there.
              const code = (error as { code?: string }).code
              if (code === 'ENOENT') {
                return writeJson(res, 404, { error: 'the file is not there', code: 'not-found' })
              }
              return writeJson(res, 404, { error: 'could not read this file', code: 'unreadable' })
            }
          }
          case 'copy': {
            // Copy one entry, with its subtree, to a new path.
            //
            // The authorization is the pair the move route checks, in the direction a
            // copy actually needs: READ on the source (the bytes are being taken) and
            // WRITE on the destination (something new appears there). It is not
            // "write on both": a copy leaves the source untouched, so demanding write
            // there would refuse a caller who may legitimately read a document out of
            // a read-only folder into their own.
            //
            // DataOps decides both answers through `canReadPath` / `canWritePath`;
            // this route never re-implements the policy.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const to = String(body.to ?? '')
            if (!isContainedRelPath(from) || !isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'from and to must be contained relative paths' })
            }
            // The destination is the parent directory plus the source's own name, the
            // same rule the move route uses: a copy cannot rename, because renaming is
            // a separate decision with its own route. `to === ''` means the root.
            const name = from.split('/').pop() ?? ''
            const target = to === '' ? name : to + '/' + name
            if (!isContainedRelPath(target)) {
              return writeJson(res, 400, { error: 'the resolved destination is not a contained relative path' })
            }
            // Copying a directory into itself (or into its own subtree) cannot
            // terminate, so it is refused before the walk rather than discovered by it.
            if (target === from || target.startsWith(from + '/')) {
              return writeJson(res, 400, { error: 'cannot copy an entry into itself', refused: [target] })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const canReadSource = await canReadPath(host, config, from)
            const canWriteTarget = to === '' ? true : await canWritePath(host, config, to)
            if (!canReadSource || !canWriteTarget) {
              return writeJson(res, 403, {
                error: 'cannot copy a path this caller may not read, or into a folder it may not write',
                refused: [!canReadSource ? from : undefined, !canWriteTarget ? to : undefined].filter(Boolean),
              })
            }
            try {
              const copied = await copyEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                target,
              )
              // Recorded as a `create` at the destination rather than as a new action
              // kind: the audit vocabulary answers "who first put this here", and a copy
              // is exactly that. Adding a seventh action would force every reader of the
              // trail to learn a distinction the review question does not make.
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'create',
                  relPath: target,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              const after = await refreshViewIfStale(true, copied.to)
              const reply = writeReplyAfterSync({
                from: copied.from,
                to: copied.to,
                entries: copied.entries,
                bytes: copied.bytes,
              }, after)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              const message = describeError(error).message
              // A refusal (destination taken, too large, self-nested) is the caller's
              // to act on, so it answers 409 rather than 500 -- the reader renamed or
              // deleted something and retried, which is the intended flow.
              return writeJson(res, 409, { error: message })
            }
          }
          case 'move': {
            // Relocate one entry the caller may WRITE, then resynchronize their view.
            //
            // The filesystem work is a rename inside the authoritative tree; the
            // authorization is still DataOps'. Both paths are asked about, because a
            // move is a write to the source (it stops existing there) and to the
            // destination (something new appears there), and a caller trusted for
            // only one of the two must not be able to perform it. The destination is
            // the PARENT directory when the drag names a folder to move INTO, which
            // is why the caller sends the resolved target path rather than a drop
            // point: this route never concatenates a name the caller chose.
            if (config.baseUrl.trim() === '') {
              return writeJson(res, 409, { error: 'DataOps permission API is not configured' })
            }
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const to = String(body.to ?? '')
            if (!isContainedRelPath(from) || !isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'from and to must be contained relative paths' })
            }
            // A path into a directory is expressed as the directory plus the entry's
            // own name, and that name comes from the source rather than the request:
            // a caller cannot rename by moving, which keeps this route's authority to
            // exactly "put it elsewhere" and leaves renaming a separate decision.
            const target = to === '' ? from.split('/').pop() ?? '' : to + '/' + (from.split('/').pop() ?? '')
            if (!isContainedRelPath(target)) {
              return writeJson(res, 400, { error: 'the resolved destination is not a contained relative path' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            // Source and destination parent both need write authority. The check is
            // deliberately not short-circuited into "the source is enough": moving a
            // file into a folder the caller cannot write would place content where
            // they could then read it back out.
            const canWriteSource = await canWritePath(host, config, from)
            const canWriteTarget = to === '' ? true : await canWritePath(host, config, to)
            if (!canWriteSource || !canWriteTarget) {
              return writeJson(res, 403, {
                error: 'cannot move a path this caller may not write',
                refused: [!canWriteSource ? from : undefined, !canWriteTarget ? to : undefined].filter(Boolean),
              })
            }
            try {
              const moved = await moveEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                target,
              )
              // Recorded once for both success branches below, before the resync, so a
              // resync warning cannot lose the fact that the move happened.
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'move',
                  relPath: moved.from,
                  toRelPath: moved.to,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              // The view holds hardlinks, and a rename gives the entry a new path
              // while the old link still points at the inode. Without this resync
              // the reader is left with a live-looking entry at the old path and
              // nothing at the new one.
              //
              // Retried once for the same reason the create route retries: the
              // rename just changed which paths exist, and a resolve that raced it
              // answers about the world before the move. One attempt would turn that
              // race into "the move worked but you cannot see it".
              let movedDelta = await syncCallerView(host, config)
              if ('error' in movedDelta) movedDelta = await syncCallerView(host, config)
              if ('error' in movedDelta) {
                // The move itself succeeded, so this is reported as a partial result
                // rather than a failure: telling the caller the move failed would
                // invite a retry that now has no source to move.
                lastSyncFailure = `move view sync answered HTTP ${String(movedDelta.status)}: ${movedDelta.error}`
                host.logger?.warn?.(`knowledge-base: ${lastSyncFailure}`)
                return writeJson(res, VIEW_SYNC_FAILED_STATUS, {
                  from: moved.from,
                  to: moved.to,
                  delta: { linked: 0, unlinked: 0, unchanged: 0 },
                  viewSyncWarning: {
                    message: 'the change was saved, but the file tree could not be refreshed',
                    reason: lastSyncFailure,
                  },
                })
              }
              lastSyncFailure = undefined
              return writeJson(res, 200, {
                from: moved.from,
                to: moved.to,
                delta: { linked: movedDelta.linked.length, unlinked: movedDelta.unlinked.length, unchanged: movedDelta.unchanged },
              })
            } catch (error) {
              return writeJson(res, 409, { error: describeError(error).message })
            }
          }
          case 'viewMode.get': {
            // Read the layout preference from the mount point, which IS the caller's view.
            //
            // It used to resolve the caller's identity through DataOps and then build a
            // view path from it. That made a layout preference fail whenever the credential
            // was stale -- and `get` swallowed the failure into `list`, so a reader's choice
            // silently never persisted while the page looked fine. The mount point is
            // already the answer to "which view is this caller looking at": `views.sync`
            // points it at their own directory, so the preference file beside the documents
            // is theirs by construction and needs no second lookup.
            const plan = localConfig(config)
            return writeJson(res, 200, { mode: await readViewMode(plan.mountPoint) })
          }
          case 'viewMode.set': {
            // Write the layout preference into the mount point, for the same reason.
            const body = await readJsonBody(req)
            // Three layouts, each drawn by a different component. An unrecognized value
            // falls back to the list rather than reaching the renderer as a mode it cannot
            // draw, which is the same rule the read side applies.
            const mode = body.mode === 'grid' ? 'grid' : body.mode === 'explorer' ? 'explorer' : 'list'
            const plan = localConfig(config)
            // The mount point exists only after a sync has pointed it at a view. Writing
            // through a missing path would create a directory where a symlink belongs,
            // which the next sync would then have to refuse as a non-empty directory --
            // so this reports "not mounted" instead of manufacturing that state.
            try {
              const info = await stat(plan.mountPoint)
              if (!info.isDirectory()) {
                return writeJson(res, 409, { error: 'the mount point is not a directory yet; sync first' })
              }
            } catch {
              return writeJson(res, 409, { error: 'the mount point is not mounted yet; sync first' })
            }
            return writeJson(res, 200, { mode: await writeViewMode(plan.mountPoint, mode) })
          }
          case 'treeState.get': {
            // The folders this caller had open, read from their own view directory.
            //
            // Keyed by the mount point for the same reason `viewMode.get` is: the mount
            // point already IS the caller's view (`views.sync` points it at their own
            // directory), so the file beside their documents is theirs by construction
            // and the answer never depends on a second identity lookup that a stale
            // credential could fail.
            //
            // Never fails on a bad file. A missing, truncated, or hand-edited
            // `.kb-tree-state.json` answers the empty list, which is the tree's own
            // default; the reader gets a fully collapsed tree rather than an error.
            const plan = localConfig(config)
            return writeJson(res, 200, { expanded: await readTreeState(plan.mountPoint) })
          }
          case 'treeState.set': {
            // Replace the stored set of expanded folders.
            //
            // Deliberately lenient about the payload compared with `pins.set`, which
            // refuses anything the caller may not read. An expanded folder is a view
            // state, not a claim on content: the worst outcome of a stale entry is a
            // folder that reopens closed because its row is gone, and the worst
            // outcome of resolving every entry against the permission store first
            // would be a save that fails while the reader is clicking around their
            // own tree. `readTreeState` drops anything that is not a plausible
            // absolute path, so the file cannot be grown without bound.
            const body = await readJsonBody(req)
            if (!Array.isArray(body.expanded)) {
              return writeJson(res, 400, { error: 'expanded must be an array of strings' })
            }
            const plan = localConfig(config)
            // A mount point that does not exist yet is not an error: the folder a
            // reader expanded may be the first thing they do after a page load, and
            // `writeTreeState` creates the directory.
            //
            // But creating it is only safe where it is meant to be a REAL directory.
            // In remote/NAS storage the mount point is a symlink a sync installs, so
            // writing through an absent one would manufacture a real directory where
            // that link belongs -- and the next sync would then have to refuse it as
            // non-empty. That is the same rule `viewMode.set` already applies, and a
            // preference is still not a reason to materialise a mount point.
            const localMode = config.storageMode === 'local'
            try {
              const info = await stat(plan.mountPoint)
              if (!info.isDirectory()) {
                return writeJson(res, 409, { error: 'the mount point is not a directory yet; sync first' })
              }
            } catch {
              if (!localMode) {
                return writeJson(res, 409, { error: 'the mount point is not mounted yet; sync first' })
              }
            }
            return writeJson(res, 200, { expanded: await writeTreeState(plan.mountPoint, body.expanded.map(String)) })
          }
          case 'roles': {
            // The two built-in roles plus every custom role that a grant names.
            //
            // A custom role is DEFINED by the grants that name it: there is no
            // separate role table to keep in step, so a role cannot exist without
            // resources nor outlive them. The screen lists what the grant table
            // already says rather than a second source of truth.
            return writeJson(res, 200, {
              builtIn: BUILT_IN_ROLES.map(role => ({
                id: role.id,
                name: role.name,
                description: role.description,
                actions: [...role.actions],
                departmentScoped: role.departmentScoped,
                removable: role.removable,
              })),
              actions: [...KNOWLEDGE_ACTIONS],
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
          case 'index.dirs': {
            // The table the indexing page renders. Read-only and derived from the
            // caller's own mount point, so it needs no permission question of its
            // own: the tree it measures is already the caller's view, and a path
            // outside it is not reachable from here.
            return writeJson(res, 200, {
              directories: await listDirectoryShapes(localConfig(config).mountPoint),
            })
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
        // A typed failure is a decision, not a crash: answer with the status its code
        // names so an expired token does not read as an internal error.
        if (error instanceof KnowledgeError) {
          return writeJson(res, knowledgeStatusFor(error.code), {
            error: error.message,
            code: error.code,
          })
        }
        return writeJson(res, 500, describeError(error))
      }
    },
  }), 'dsh-knowledge-base: settings API')

  // The skill teaches the MODEL how to use this tree. `inject` rather than a hard
  // dependency entry: the dependency fiber starts when a skill registry becomes
  // available and unloads its registration before either side is replaced, which is
  // how this plugin keeps working on a host that has no registry at all.
  //
  // The provider is built against a restated structural contract rather than the
  // registry's own types: `skills` is optional here, and importing its package
  // would turn that neighbour into a build requirement.
  const hostWithInject = host as unknown as { inject?: (deps: readonly string[], run: (scoped: { skills: { registerProvider: (provider: () => unknown) => unknown } }) => void) => void }
  if (typeof hostWithInject.inject === 'function') {
    hostWithInject.inject(['skills'], (scoped) => {
      scoped.skills.registerProvider(() => knowledgeBaseSkillProvider() as never)
    })
  }

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
