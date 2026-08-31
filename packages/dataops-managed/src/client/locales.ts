/** English managed DataOps Settings copy. */
export const en = {
  nav: 'DataOps',
  title: 'DataOps',
  managed: 'Managed by this DataOps workspace',
  description: 'DSH uses your current DataOps session JWT. DataOps applies its role and resource permissions to every tool request.',
  identityLabel: 'Identity and permissions',
  identityValue: 'Current DataOps JWT',
  toolsLabel: 'DataOps tools',
  toolsValue: 'Authorized by DataOps on every request',
} as const

/** Stable key set shared by every managed DataOps locale. */
export type ManagedDataOpsKey = keyof typeof en

/** Chinese managed DataOps Settings copy. */
export const zh: Record<ManagedDataOpsKey, string> = {
  nav: 'DataOps',
  title: 'DataOps',
  managed: '由当前 DataOps 工作区托管',
  description: 'DSH 使用当前 DataOps 会话 JWT；DataOps 对每次工具请求应用角色与资源权限。',
  identityLabel: '身份与权限',
  identityValue: '当前 DataOps JWT',
  toolsLabel: 'DataOps 工具',
  toolsValue: '每次请求均由 DataOps 授权',
}
