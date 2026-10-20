/**
 * The same-origin API surface shared by this package's two halves.
 *
 * The Host registers one prefix and dispatches on the trailing method name; the
 * browser calls the same strings. Keeping them in one module is what stops the
 * two halves drifting apart, which is exactly the failure this file was written
 * to fix: the panel once called `/knowledge-base/config` while the Host served
 * `/knowledge-base/api/config`.
 *
 * This module must stay dependency-free so both bundles can import it: the
 * Client bundle rejects Node builtins and non-platform packages.
 *
 * @module @sparkelf/dsh-knowledge-base/api
 */

/** Prefix the Host registers and the browser calls. */
export const KB_API_PREFIX = '/knowledge-base/api'

/** Method names the Host dispatches on. */
export const KB_API = {
  /** Resolved layout plus whether the DataOps backend is wired. */
  config: 'config',
  /** Aggregated view and index status. */
  status: 'status',
  /** Authorized paths for the calling user. */
  grants: 'grants',
  /** Grant one principal access to one path. */
  grant: 'grant',
  /** Revoke one previously granted path. */
  revoke: 'revoke',
  /** List the principals that can be granted, so the surface can offer a picker. */
  principals: 'principals',
  /** Search the mounted tree by file name and text. */
  search: 'search',
  /** List one directory level, with each entry's modification time. */
  list: 'list',
  /** Read one file for the preview, without needing a conversation session. */
  read: 'read',
  /** Rebuild the caller's visible tree from what DataOps resolves for them. */
  viewsSync: 'views.sync',
  /** Rescan the mounted tree and report its shape. */
  index: 'index',
  /** The ordered deployment steps and their recent runs. */
  deploySteps: 'deploy.steps',
  /** SSH hosts available as deployment targets. */
  deployHosts: 'deploy.hosts',
  /** Run one deployment step against one host. */
  deployRun: 'deploy.run',
} as const

/** One method name. */
export type KbApiMethod = (typeof KB_API)[keyof typeof KB_API]

/** Absolute URL for one API method. */
export function kbApiPath(method: KbApiMethod): string {
  return `${KB_API_PREFIX}/${method}`
}

/** Resolved layout as the panel renders it. */
export interface KnowledgeConfigView {
  /** Human-facing identifier of the storage host, empty when unconfigured. */
  host: string
  /** Absolute path of the authoritative tree on the storage host. */
  actualRoot: string
  /** Absolute path of the caller's view tree on the storage host. */
  viewRoot: string
  /** Path where the view tree is mounted inside the container. */
  mountPoint: string
  /** Whether a DataOps knowledge API base URL is configured. */
  backendConfigured: boolean
  /** Why the backend probe failed, when it did. */
  backendError?: { message: string; code?: string }
}

/** Aggregated view and index status as the panel renders it. */
export interface KnowledgeStatusView {
  /** Visible file count, or null when the backend is not configured. */
  visibleFiles: number | null
  /** ISO-8601 time of the last successful synchronization. */
  lastSyncAt: string | null
  /** In-flight index state. */
  indexing: { running: boolean; jobId?: string; progress?: number }
  /**
   * Whether the Host verified that this caller may manage grants.
   *
   * Decided on the Host by asking DataOps, and deliberately not derived here: a
   * client-side decision would duplicate the policy in a process the user controls,
   * where it governs rendering rather than access. Absent or false both mean "do not
   * offer the surface", so a response from an older Host hides it rather than
   * showing a menu whose writes the backend would reject.
   */
  canManageGrants?: boolean
}

/** The principal kinds the DataOps backend accepts on a grant. */
export type KnowledgeGrantSubjectType = 'user' | 'role' | 'department' | 'group'

/**
 * One grant as the permissions surface renders it.
 *
 * The shape mirrors what the backend stores, so the page can echo a row back when
 * revoking it without keeping a second copy of the fields.
 */
export interface GrantView {
  /** Stable row identifier. */
  id: string
  /** Path the grant covers, relative to the knowledge mount point. */
  relPath: string
  /** Whether the path is a file or a directory. */
  kind: 'file' | 'directory'
  /** Principal kind the grant names. */
  principalType: KnowledgeGrantSubjectType
  /** Principal id within its kind. */
  principalId: string
  /** Permission the grant confers. */
  action: string
  /** Who created the grant. */
  grantedBy: string
  /** ISO-8601 creation time. */
  grantedAt: string
}

/** One deployment step as the browser receives it. */
export interface DeployStepView {
  id: string
  label: string
  timeoutMs: number
  commands: string[]
}

/** One recorded deployment run. */
export interface DeployRunView {
  stepId: string
  hostId: string
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  log: string[]
}

/** One SSH host offered as a deployment target. */
export interface DeployHostView {
  id: string
  name: string
  hostname: string
  username: string
  port: number
  credentialConfigured: boolean
}
