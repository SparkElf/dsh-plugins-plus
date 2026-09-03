export type SshAuthKind = 'password' | 'private-key' | 'agent'
export type SshEnvironment = 'development' | 'testing' | 'staging' | 'production' | 'other'

export interface SshCluster { id: string; name: string; description: string; tags: string[]; hostIds: string[] }
export interface SshHost {
  id: string
  name: string
  description: string
  tags: string[]
  clusterId: string | null
  environment: SshEnvironment
  hostname: string
  port: number
  username: string
  authKind: SshAuthKind
  credentialId: string | null
  credentialConfigured: boolean
  jumpHostId: string | null
  knownHostFingerprint: string | null
  keepAliveSeconds: number
}
export interface SshCredentialInput { password?: string; privateKey?: string; passphrase?: string }
export interface SshManagerState { clusters: SshCluster[]; hosts: SshHost[] }
export interface SshTerminalSession { id: string; hostId: string; title: string; cwd: string | null; connectedAt: number; state: 'connecting' | 'connected' | 'disconnected' | 'failed' }
export interface SshCommandRequest { hostIds: string[]; command: string; cwd?: string; environment?: Record<string, string>; timeoutMs: number; confirmation: 'always' | 'mutating' | 'never' }
export interface SshCommandResult { hostId: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; truncated: boolean }
