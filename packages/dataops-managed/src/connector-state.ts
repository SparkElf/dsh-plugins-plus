/**
 * The DataOps connector's workspace-visible state and skill-center catalogue.
 *
 * The skill center is skill-first, with connectors as its fourth tab. DataOps contributes one
 * connector whose capability rows are derived from the same scope that drives tool disclosure;
 * a capability the account cannot use is omitted rather than rendered as a disabled placeholder.
 *
 * This module owns only state and presentation. It never authorizes a tool call or a DataOps
 * request: the backend remains the final boundary.
 *
 * @module connector-state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canReview,
  hasPermission,
  isSuperAdmin,
  type DataOpsScope,
} from './tool-scope.ts'

/** Same-origin route the skill center's connector tab reads and writes. */
export const CONNECTORS_PATH = '/api/dsh-skill-center/connectors'

/** Connector id shown in the skill center. */
export const DATAOPS_CONNECTOR_ID = 'dataops-managed'

/** Persisted enable state; a missing file means the connector is off. */
export interface DataOpsConnectorState {
  enabled: boolean
  capabilities: Record<string, boolean>
}

/** One capability row the skill center renders. */
export interface ConnectorCapabilityView {
  id: string
  name: string
  description: string
  enabled: boolean
  permitted: boolean
  unavailableReason?: string
}

/** One connector row the skill center renders. */
export interface ConnectorView {
  id: string
  name: string
  vendor: string
  description: string
  enabled: boolean
  connected: boolean
  capabilities: ConnectorCapabilityView[]
}

/** Resolve the persisted state file without depending on a global DSH path. */
export const CONNECTOR_STATE_PATH = join(
  process.env.DSH_HOME?.trim() || '/workspace/.dataops/dsh',
  'dataops-managed',
  'connector-state.json',
)

/** Capability definitions before permission filtering. */
const CAPABILITIES = [
  {
    id: 'skill.plaza',
    name: '技能广场',
    description: '读取、安装和管理当前账号可见的技能',
    allowed: (scope: DataOpsScope) => hasPermission(scope, 'skill:read'),
  },
  {
    id: 'review.queue',
    name: '审核队列',
    description: '查看待审技能、扫描风险并给出审核结论',
    allowed: (scope: DataOpsScope) => canReview(scope),
  },
  {
    id: 'data.query',
    name: '数据查询',
    description: '通过 DataOps 数据查询能力回答业务问题',
    allowed: () => true,
  },
  {
    id: 'api.docs',
    name: '管理接口文档',
    description: '仅超级管理员可查询 DataOps OpenAPI 接口文档',
    allowed: (scope: DataOpsScope) => isSuperAdmin(scope),
  },
] as const

/** Read state; a missing or corrupt file is a safe disabled state. */
export async function readConnectorState(path = CONNECTOR_STATE_PATH): Promise<DataOpsConnectorState> {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8')) as Partial<DataOpsConnectorState>
    return {
      enabled: payload.enabled === true,
      capabilities: typeof payload.capabilities === 'object' && payload.capabilities !== null
        ? { ...payload.capabilities }
        : {},
    }
  } catch {
    return { enabled: false, capabilities: {} }
  }
}

/** Persist state atomically. */
export async function writeConnectorState(
  state: DataOpsConnectorState,
  path = CONNECTOR_STATE_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid.toString()
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, path)
}

/** Build the connector row for one current scope. */
export function buildConnectorView(scope: DataOpsScope | undefined, state: DataOpsConnectorState): ConnectorView {
  const capabilities = scope === undefined
    ? []
    : CAPABILITIES.filter(capability => capability.allowed(scope)).map(capability => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        enabled: state.capabilities[capability.id] !== false,
        permitted: true,
      }))
  return {
    id: DATAOPS_CONNECTOR_ID,
    name: '万相AI中台连接器',
    vendor: 'DataOps',
    description: '把万相AI中台的技能、审核和数据能力接入当前工作区。',
    enabled: state.enabled,
    connected: scope !== undefined,
    capabilities,
  }
}

/** Whether one capability id is in the fixed catalogue. */
export function hasCapability(id: string): boolean {
  return CAPABILITIES.some(capability => capability.id === id)
}
