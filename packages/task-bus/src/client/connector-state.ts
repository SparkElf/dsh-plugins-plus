/**
 * Client state adapter for the Task Center's one connector.
 *
 * The Host owns the authoritative enabled/capability state and the tool
 * disclosure that follows it. This module only reads that state, sends the two
 * writes the panel offers, and projects the task rows a capability filter
 * selects. It never decides permissions: a capability absent from the Host's
 * answer is one this account may not use, so it is never rendered.
 *
 * @module @sparkelf/dsh-task-bus/client/connector-state
 */

/** Route the Host serves the connector state from. */
export const CONNECTOR_ROUTE = '/dsh-task-bus/api/connector'

/** Connector id carried by DataOps approval tasks. */
export const CONNECTOR_ID = 'wanxiang-ai'

/** Display name shared by the card and its empty state. */
export const CONNECTOR_NAME = '万相AI中台连接器'

/** State the Host persists and the card renders. */
export interface ConnectorState {
  /** Whether the connector contributes task capabilities at all. */
  enabled: boolean
  /**
   * Capability id to enabled flag. Only capabilities this account may use
   * appear here; an absent id is hidden rather than shown disabled.
   */
  capabilities: Record<string, boolean>
  /** Per-capability reason it cannot run right now, when the Host reports one. */
  reasons?: Record<string, string>
}

/** One capability row as the card renders it. */
export interface ConnectorCapabilityView {
  id: string
  label: string
  description?: string
  enabled: boolean
  unavailableReason?: string
}

/** Copy for the capability ids the Host currently ships. */
const CAPABILITY_COPY: Record<string, { label: string; description: string }> = {
  'approval.push': { label: '接收审批任务', description: '从万相AI中台接收待办理的审批任务' },
  'approval.writeback': { label: '回写审批结果', description: '把办理结果回写到万相AI中台' },
  'task.push': { label: '接收通用任务', description: '接收万相AI中台下发的通用任务' },
  'task.writeback': { label: '回写任务状态', description: '把任务处理状态回写到万相AI中台' },
  'ai.accept': { label: 'AI 受理', description: '由助手创建受理会话处理任务' },
}

/** Humanize an id the client has no display copy for. */
function humanizeCapability(id: string): string {
  return id.replace(/[._-]+/gu, ' ').trim()
}

/** Parse one unknown wire value into connector state. */
export function parseConnectorState(value: unknown): ConnectorState {
  if (typeof value !== 'object' || value === null) return { enabled: false, capabilities: {} }
  const row = value as Record<string, unknown>
  const capabilities: Record<string, boolean> = {}
  const reasons: Record<string, string> = {}
  const raw = typeof row.capabilities === 'object' && row.capabilities !== null
    ? row.capabilities as Record<string, unknown>
    : {}
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry === 'boolean') {
      capabilities[id] = entry
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const detail = entry as { enabled?: unknown; permitted?: unknown; reason?: unknown }
    // A future Host may send a per-capability object; `permitted: false` means
    // the account cannot use it, so the row stays out of the catalogue.
    if (detail.permitted === false) continue
    capabilities[id] = detail.enabled === true
    if (typeof detail.reason === 'string' && detail.reason !== '') reasons[id] = detail.reason
  }
  const rawReasons = typeof row.reasons === 'object' && row.reasons !== null
    ? row.reasons as Record<string, unknown>
    : {}
  for (const [id, reason] of Object.entries(rawReasons)) {
    if (typeof reason === 'string' && reason !== '') reasons[id] = reason
  }
  return {
    enabled: row.enabled === true,
    capabilities,
    ...Object.keys(reasons).length === 0 ? {} : { reasons },
  }
}

/**
 * Read the Host's connector state.
 * @param route - connector route; overridable for tests.
 * @returns the parsed state.
 * @throws when the Host rejects the request.
 */
export async function fetchConnectorState(route: string = CONNECTOR_ROUTE): Promise<ConnectorState> {
  const response = await fetch(route, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('连接器状态读取失败（' + String(response.status) + '）')
  return parseConnectorState(await response.json() as unknown)
}

/**
 * Write connector state through the Host.
 * @param patch - the enabled flag and optional capability changes to merge.
 * @param route - connector route; overridable for tests.
 * @returns the state the Host persisted.
 * @throws when the Host rejects the request.
 */
export async function saveConnectorState(
  patch: { enabled: boolean; capabilities?: Record<string, boolean> },
  route: string = CONNECTOR_ROUTE,
): Promise<ConnectorState> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error('连接器状态保存失败（' + String(response.status) + '）')
  return parseConnectorState(await response.json() as unknown)
}

/**
 * Project the capability rows the card renders.
 * @param state - Host state.
 * @returns one row per capability the account may use, in the Host's order.
 */
export function visibleCapabilities(state: ConnectorState | null): ConnectorCapabilityView[] {
  if (state === null) return []
  return Object.entries(state.capabilities).map(([id, enabled]) => {
    const copy = CAPABILITY_COPY[id]
    return {
      id,
      label: copy?.label ?? humanizeCapability(id),
      ...copy === undefined ? {} : { description: copy.description },
      enabled,
      ...state.reasons?.[id] === undefined ? {} : { unavailableReason: state.reasons[id] },
    }
  })
}

/** The subset of a Task Center row the connector projection reads. */
export interface ConnectorTaskLike {
  sourceType: string
  source: { type: string }
  /** Connector that produced the row, when the Host carries it. */
  connectorId?: string
  /** Capability that produced the row, when the Host carries it. */
  capabilityId?: string
}

/**
 * The connector that produced a task row. MVP DataOps approval rows predate
 * explicit ids, so their source type still identifies the built-in connector.
 * @param task - one task row.
 * @returns the connector id, or undefined for a generic Task Bus row.
 */
export function taskConnectorId(task: ConnectorTaskLike): string | undefined {
  if (task.connectorId !== undefined && task.connectorId !== '') return task.connectorId
  return task.sourceType === 'dataops_approval' ? CONNECTOR_ID : undefined
}

/**
 * The capability that produced a task row; an id-less DataOps approval row
 * belongs to `approval.push`.
 * @param task - one task row.
 * @returns the capability id, or undefined for a generic Task Bus row.
 */
export function taskCapabilityId(task: ConnectorTaskLike): string | undefined {
  if (task.capabilityId !== undefined && task.capabilityId !== '') return task.capabilityId
  return task.sourceType === 'dataops_approval' ? 'approval.push' : undefined
}

/**
 * Filter rows for the connector tab.
 * @param tasks - every loaded row.
 * @param capabilityId - `all`, or the capability whose rows should remain.
 * @returns rows produced by the built-in connector, narrowed to the capability.
 */
export function filterConnectorTasks<T extends ConnectorTaskLike>(
  tasks: readonly T[],
  capabilityId: string,
): T[] {
  return tasks.filter(task => (
    taskConnectorId(task) === CONNECTOR_ID
    && (capabilityId === 'all' || taskCapabilityId(task) === capabilityId)
  ))
}