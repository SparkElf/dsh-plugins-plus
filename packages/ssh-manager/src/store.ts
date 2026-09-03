import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type { SshCluster, SshCredentialInput, SshHost, SshManagerState } from './types.ts'

interface StoredData { version: 1; clusters: SshCluster[]; hosts: SshHost[] }

export class SshManagerStore {
  private readonly dataFile: string
  private readonly vault: WorkbenchVault
  private data: StoredData | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: { dataFile?: string; vault?: WorkbenchVault } = {}) {
    this.dataFile = options.dataFile ?? join(homedir(), '.dsh', 'ssh-manager.json')
    this.vault = options.vault ?? new WorkbenchVault()
  }

  private async load(): Promise<StoredData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    this.data = existsSync(this.dataFile)
      ? JSON.parse(await readFile(this.dataFile, 'utf8')) as StoredData
      : { version: 1, clusters: [], hosts: [] }
    if (this.data.version !== 1) throw new Error('Unsupported SSH Manager data format')
    return this.data
  }

  private async persist(): Promise<void> {
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  async state(): Promise<SshManagerState> {
    await this.mutations
    const data = await this.load()
    const hosts = await Promise.all(data.hosts.map(async host => ({ ...host, credentialConfigured: host.credentialId !== null && await this.vault.has('ssh', host.credentialId) })))
    return { clusters: data.clusters.map(cluster => ({ ...cluster, hostIds: [...cluster.hostIds], tags: [...cluster.tags] })), hosts }
  }

  async saveCluster(input: SshCluster): Promise<SshCluster> {
    return this.enqueue(async () => {
      const data = await this.load()
      const cluster: SshCluster = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], hostIds: [...new Set(input.hostIds)] }
      if (cluster.name === '') throw new Error('SSH cluster name is required')
      const index = data.clusters.findIndex(item => item.id === cluster.id)
      if (index === -1) data.clusters.push(cluster)
      else data.clusters[index] = cluster
      await this.persist()
      return cluster
    })
  }

  async deleteCluster(clusterId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      data.clusters = data.clusters.filter(cluster => cluster.id !== clusterId)
      data.hosts = data.hosts.map(host => host.clusterId === clusterId ? { ...host, clusterId: null } : host)
      await this.persist()
    })
  }

  async saveHost(input: SshHost, credential?: SshCredentialInput): Promise<SshHost> {
    return this.enqueue(async () => {
      const data = await this.load()
      const id = input.id === '' ? randomUUID() : input.id
      if (input.name.trim() === '' || input.hostname.trim() === '' || input.username.trim() === '') throw new Error('SSH host name, hostname, and username are required')
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH host port is invalid')
      if (input.clusterId !== null && !data.clusters.some(cluster => cluster.id === input.clusterId)) throw new Error('SSH cluster not found: ' + input.clusterId)
      if (input.jumpHostId === id) throw new Error('SSH host cannot use itself as a jump host')
      if (input.jumpHostId !== null && !data.hosts.some(host => host.id === input.jumpHostId)) throw new Error('SSH jump host not found: ' + input.jumpHostId)
      const credentialId = input.credentialId ?? id
      if (credential !== undefined && Object.values(credential).some(value => value !== undefined && value !== '')) await this.vault.set('ssh', credentialId, credential as Record<string, unknown>)
      const host: SshHost = { ...input, id, name: input.name.trim(), description: input.description.trim(), hostname: input.hostname.trim(), username: input.username.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], credentialId, credentialConfigured: await this.vault.has('ssh', credentialId) }
      const index = data.hosts.findIndex(item => item.id === id)
      if (index === -1) data.hosts.push(host)
      else data.hosts[index] = host
      for (const cluster of data.clusters) {
        cluster.hostIds = cluster.id === host.clusterId ? [...new Set([...cluster.hostIds, host.id])] : cluster.hostIds.filter(hostId => hostId !== host.id)
      }
      await this.persist()
      return host
    })
  }

  async deleteHost(hostId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const host = data.hosts.find(item => item.id === hostId)
      if (host === undefined) return
      data.hosts = data.hosts.filter(item => item.id !== hostId).map(item => item.jumpHostId === hostId ? { ...item, jumpHostId: null } : item)
      data.clusters = data.clusters.map(cluster => ({ ...cluster, hostIds: cluster.hostIds.filter(id => id !== hostId) }))
      if (host.credentialId !== null) await this.vault.delete('ssh', host.credentialId)
      await this.persist()
    })
  }

  async host(hostId: string): Promise<SshHost> {
    const host = (await this.state()).hosts.find(item => item.id === hostId)
    if (host === undefined) throw new Error('SSH host not found: ' + hostId)
    return host
  }

  async credential(hostId: string): Promise<SshCredentialInput | undefined> {
    const host = await this.host(hostId)
    return host.credentialId === null ? undefined : this.vault.get<SshCredentialInput & Record<string, unknown>>('ssh', host.credentialId)
  }
}
