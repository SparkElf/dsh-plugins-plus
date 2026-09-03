import { WorkbenchVault, type WorkbenchVaultOptions } from '@sparkelf/dsh-workbench-vault'
import { SshManagerStore, type SshCommandRequest, type SshCredentialRecords, type SshHost } from '@sparkelf/dsh-ssh-manager'
import { ApiClientStore, type ApiRequest, type ApiResponse } from '@sparkelf/dsh-api-client'

const vaultOptions = {} satisfies WorkbenchVaultOptions
const vault = new WorkbenchVault(vaultOptions)
const credentials = {} as SshCredentialRecords
const ssh = new SshManagerStore({ credentials, legacyVault: vault })
const api = new ApiClientStore({ vault })

const host = {
  id: 'host-id',
  name: 'Host',
  description: '',
  tags: [],
  clusterId: null,
  environment: 'testing',
  hostname: 'host.example.test',
  port: 22,
  username: 'tester',
  authKind: 'agent',
  credentialId: null,
  credentialConfigured: false,
  jumpHostId: null,
  knownHostFingerprint: null,
  keepAliveSeconds: 30,
} satisfies SshHost
const command = {
  hostIds: [host.id],
  command: 'uptime',
  timeoutMs: 30_000,
  confirmation: 'mutating',
} satisfies SshCommandRequest

const request = {
  id: 'request-id',
  collectionId: 'collection-id',
  name: 'Request',
  description: '',
  method: 'GET',
  url: 'https://api.example.test/health',
  query: [],
  headers: [],
  auth: { kind: 'none', credentialId: null, options: {} },
  body: { kind: 'none', content: '' },
  environmentId: null,
} satisfies ApiRequest

const hostWrite: Promise<SshHost> = ssh.saveHost(host)
const requestWrite: Promise<ApiRequest> = api.saveRequest(request)
const historyWrite: (response: ApiResponse) => Promise<void> = response => api.addHistory(response)

void [command, hostWrite, requestWrite, historyWrite]
