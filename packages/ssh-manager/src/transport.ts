import { Client, type ConnectConfig } from 'ssh2'
import type { SshCredentialInput, SshHost } from './types.ts'
import { SshManagerStore } from './store.ts'

export interface SshConnectionTest { hostId: string; latencyMs: number; fingerprint: string }

export function fingerprintFromHash(hash: string): string {
  if (!/^[0-9a-f]+$/iu.test(hash) || hash.length % 2 !== 0) throw new Error('SSH host key hash is invalid')
  return 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/u, '')
}

export function sshConnectConfig(host: SshHost, credential: SshCredentialInput | undefined): ConnectConfig {
  if (host.jumpHostId !== null) throw new Error('SSH jump-host transport is not implemented yet')
  if (host.knownHostFingerprint === null || host.knownHostFingerprint.trim() === '') throw new Error('SSH known-host fingerprint is required before connecting')
  const config: ConnectConfig = { host: host.hostname, port: host.port, username: host.username, readyTimeout: 10_000, keepaliveInterval: Math.max(0, host.keepAliveSeconds) * 1000, keepaliveCountMax: 3, hostHash: 'sha256' }
  if (host.authKind === 'password') {
    if (!credential?.password) throw new Error('SSH password is not configured')
    config.password = credential.password
  } else if (host.authKind === 'private-key') {
    if (!credential?.privateKey) throw new Error('SSH private key is not configured')
    config.privateKey = credential.privateKey
    if (credential.passphrase) config.passphrase = credential.passphrase
  } else {
    if (!process.env.SSH_AUTH_SOCK) throw new Error('SSH_AUTH_SOCK is not available')
    config.agent = process.env.SSH_AUTH_SOCK
  }
  return config
}

export async function testSshHost(store: SshManagerStore, hostId: string): Promise<SshConnectionTest> {
  const host = await store.host(hostId)
  const config = sshConnectConfig(host, await store.credential(hostId))
  const expected = host.knownHostFingerprint as string
  const client = new Client()
  const started = performance.now()
  let observed: string | undefined
  config.hostVerifier = (hash: string) => { observed = fingerprintFromHash(hash); return observed === expected }
  return new Promise<SshConnectionTest>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      client.end()
      if (error !== undefined) reject(error)
      else resolve({ hostId, latencyMs: Math.round(performance.now() - started), fingerprint: observed as string })
    }
    client.once('ready', () => { finish() })
    client.once('error', error => {
      if (observed !== undefined && observed !== expected) finish(new Error('SSH host fingerprint mismatch. Observed ' + observed))
      else finish(error)
    })
    try { client.connect(config) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
