/** English managed DataOps Settings copy. */
export const en = {
  nav: 'DataOps',
  title: 'DataOps',
  managed: 'Managed by this DataOps workspace',
  description: 'DataOps tools are provided automatically through the workspace-managed channel. No connection or authorization is required here.',
  identityLabel: 'Identity and permissions',
  identityValue: 'Managed by your current DataOps session',
  toolsLabel: 'DataOps tools',
  toolsValue: 'Provided automatically by the workspace',
} as const

/** Stable key set shared by every managed DataOps locale. */
export type ManagedDataOpsKey = keyof typeof en

/** Chinese managed DataOps Settings copy. */
export const zh: Record<ManagedDataOpsKey, string> = {
  nav: 'DataOps',
  title: 'DataOps',
  managed: '由当前 DataOps 工作区托管',
  description: 'DataOps 工具通过工作区托管通道自动提供，无需在这里连接、重新授权或断开。',
  identityLabel: '身份与权限',
  identityValue: '由当前 DataOps 会话管理',
  toolsLabel: 'DataOps 工具',
  toolsValue: '由工作区自动提供',
}
