/** Same-origin workspace-limits calls from the DataOps settings surface. */

/** Route the plugin's Host half serves for workspace limits. */
export const WORKSPACE_LIMITS_PATH = '/integrations/dataops/workspace-limits'

/** The two byte ceilings, as the panel edits them. */
export interface WorkspaceLimits {
  /** Largest file a sidebar download or agent read may carry. */
  fileReadMaxBytes: number
  /** Largest file an upload may carry. */
  uploadMaxBytes: number
}

/** Limits as this workspace currently holds them. */
export interface WorkspaceLimitsStatus {
  limits: WorkspaceLimits
  canWrite: boolean
  readOnlyReason: string | null
}

/** Narrow a response body to the status, rejecting anything else. */
function asStatus(value: unknown): WorkspaceLimitsStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const limits = record.limits as Record<string, unknown> | undefined
  if (typeof limits !== 'object' || limits === null) return null
  const fileReadMaxBytes = limits.fileReadMaxBytes
  const uploadMaxBytes = limits.uploadMaxBytes
  if (typeof fileReadMaxBytes !== 'number' || typeof uploadMaxBytes !== 'number') return null
  return {
    limits: { fileReadMaxBytes, uploadMaxBytes },
    canWrite: record.canWrite === true,
    readOnlyReason: typeof record.readOnlyReason === 'string' ? record.readOnlyReason : null,
  }
}

function readJson(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read the workspace limits the panel shows.
 * @returns The status, or null when the workspace is not connected to DataOps.
 */
export async function fetchWorkspaceLimits(): Promise<WorkspaceLimitsStatus | null> {
  const response = await fetch(WORKSPACE_LIMITS_PATH, { credentials: 'same-origin' })
  if (response.status === 503) return null
  if (!response.ok) throw new Error(`Workspace limits read failed with HTTP ${String(response.status)}`)
  return asStatus(await response.json())
}

/**
 * Store new workspace limits.
 * @param limits - The ceilings to store.
 * @returns The stored status.
 */
export async function saveWorkspaceLimits(limits: WorkspaceLimits): Promise<WorkspaceLimitsStatus | null> {
  const response = await fetch(WORKSPACE_LIMITS_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(limits),
  })
  if (response.status === 503) return null
  if (!response.ok) throw new Error(`Workspace limits write failed with HTTP ${String(response.status)}`)
  const body = readJson(await response.json())
  return body === null ? null : asStatus(body)
}