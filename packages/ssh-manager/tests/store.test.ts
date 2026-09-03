import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import { SshManagerStore } from '../src/store.ts'
import type { SshHost } from '../src/types.ts'

function host(overrides: Partial<SshHost> = {}): SshHost {
  return { id: '', name: 'Primary', description: 'Production node', tags: ['prod', 'prod'], clusterId: null, environment: 'production', hostname: 'server.example.com', port: 22, username: 'deploy', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: null, keepAliveSeconds: 30, ...overrides }
}

describe('SshManagerStore', () => {
  it('persists sanitized hosts, credentials, clusters, and references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-store-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh-manager.json'), vault: new WorkbenchVault({ directory }) })
    const cluster = await store.saveCluster({ id: '', name: 'Production', description: '', tags: ['critical'], hostIds: [] })
    const saved = await store.saveHost(host({ clusterId: cluster.id }), { password: 'host-secret' })
    expect(saved.tags).toEqual(['prod'])
    expect(saved.credentialConfigured).toBe(true)
    const state = await store.state()
    expect(state.clusters[0]?.hostIds).toEqual([saved.id])
    expect(JSON.stringify(state)).not.toContain('host-secret')
    expect(await store.credential(saved.id)).toEqual({ password: 'host-secret' })
    expect(await readFile(join(directory, 'ssh-manager.json'), 'utf8')).not.toContain('host-secret')
    expect(await readFile(join(directory, 'workbench-vault.json'), 'utf8')).not.toContain('host-secret')
  })

  it('validates jump hosts and clears references on delete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-links-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh-manager.json'), vault: new WorkbenchVault({ directory }) })
    const jump = await store.saveHost(host({ name: 'Jump', hostname: 'jump.example.com' }))
    const target = await store.saveHost(host({ name: 'Target', hostname: 'target.example.com', jumpHostId: jump.id }))
    await expect(store.saveHost(host({ name: 'Invalid', jumpHostId: 'missing' }))).rejects.toThrow(/jump host not found/)
    await store.deleteHost(jump.id)
    expect((await store.host(target.id)).jumpHostId).toBeNull()
  })
})
