import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import { SshManagerStore } from '../src/store.ts'
import { executeSshCommand, fingerprintFromHash, sshConnectConfig, testSshHost } from '../src/transport.ts'
import type { SshHost } from '../src/types.ts'

const host: SshHost = { id: 'host', name: 'Host', description: '', tags: [], clusterId: null, environment: 'testing', hostname: 'localhost', port: 22, username: 'user', authKind: 'password', credentialId: 'host', credentialConfigured: true, jumpHostId: null, knownHostFingerprint: 'SHA256:AQID', keepAliveSeconds: 30 }
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

describe('SSH transport policy', () => {
  it('formats OpenSSH SHA256 fingerprints', () => { expect(fingerprintFromHash('010203')).toBe('SHA256:AQID') })
  it('requires a credential and strict known-host fingerprint', () => {
    expect(sshConnectConfig(host, { password: 'secret' })).toMatchObject({ host: 'localhost', port: 22, username: 'user', password: 'secret', hostHash: 'sha256' })
    expect(() => sshConnectConfig({ ...host, knownHostFingerprint: null }, { password: 'secret' })).toThrow(/fingerprint is required/)
    expect(() => sshConnectConfig(host, undefined)).toThrow(/password is not configured/)
    expect(() => sshConnectConfig({ ...host, jumpHostId: 'jump' }, { password: 'secret' })).toThrow(/jump-host transport/)
  })
  it('rejects an unknown host key and connects after the observed fingerprint is saved', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    const server = new Server({ hostKeys: [pair.privateKey] }, client => { client.on('error', () => {}); client.on('authentication', context => { if (context.method === 'password' && context.username === 'user' && context.password === 'secret') context.accept(); else context.reject() }); client.on('ready', () => { client.on('session', accept => { const session = accept(); session.on('exec', (acceptExec, _reject, info) => { const stream = acceptExec(); stream.write('stdout: ' + info.command); stream.stderr.write('stderr'); stream.exit(0); stream.end() }) }) }) })
    server.on('error', () => {})
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('SSH test server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-transport-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), vault: new WorkbenchVault({ directory }) })
    const saved = await store.saveHost({ ...host, id: '', hostname: '127.0.0.1', port: address.port, credentialId: null, credentialConfigured: false, knownHostFingerprint: 'SHA256:wrong' }, { password: 'secret' })
    let observed = ''
    try { await testSshHost(store, saved.id) } catch (error) { observed = String(error).match(/Observed (SHA256:[A-Za-z0-9+/]+)/u)?.[1] ?? '' }
    expect(observed).toMatch(/^SHA256:/u)
    await store.saveHost({ ...saved, knownHostFingerprint: observed })
    await expect(testSshHost(store, saved.id)).resolves.toMatchObject({ hostId: saved.id, fingerprint: observed })
    await expect(executeSshCommand(store, saved.id, 'printf ok')).resolves.toMatchObject({ hostId: saved.id, exitCode: 0, stdout: 'stdout: printf ok', stderr: 'stderr', truncated: false })
  })
})
