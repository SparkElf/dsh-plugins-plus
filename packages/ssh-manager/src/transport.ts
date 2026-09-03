import { Client, type ConnectConfig } from 'ssh2'
import type { SshCommandResult, SshCredentialInput, SshHost } from './types.ts'
import { SshManagerStore } from './store.ts'

const OUTPUT_LIMIT = 1 << 20
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

async function connectSshHost(store: SshManagerStore, hostId: string): Promise<{ client: Client; host: SshHost; fingerprint: string; latencyMs: number }> {
  const host = await store.host(hostId)
  const config = sshConnectConfig(host, await store.credential(hostId))
  const expected = host.knownHostFingerprint as string
  const client = new Client()
  const started = performance.now()
  let observed: string | undefined
  config.hostVerifier = (hash: string) => { observed = fingerprintFromHash(hash); return observed === expected }
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => { if (settled) return; settled = true; client.end(); reject(error) }
    client.once('ready', () => { if (settled) return; settled = true; resolve({ client, host, fingerprint: observed as string, latencyMs: Math.round(performance.now() - started) }) })
    client.once('error', error => { if (observed !== undefined && observed !== expected) fail(new Error('SSH host fingerprint mismatch. Observed ' + observed)); else fail(error) })
    try { client.connect(config) } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

export async function testSshHost(store: SshManagerStore, hostId: string): Promise<SshConnectionTest> {
  const connection = await connectSshHost(store, hostId)
  connection.client.end()
  return { hostId, latencyMs: connection.latencyMs, fingerprint: connection.fingerprint }
}

function appendBounded(current: string, chunk: Buffer): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= OUTPUT_LIMIT) return { value: current, truncated: true }
  const remaining = OUTPUT_LIMIT - Buffer.byteLength(current)
  if (chunk.byteLength <= remaining) return { value: current + chunk.toString('utf8'), truncated: false }
  return { value: current + chunk.subarray(0, remaining).toString('utf8'), truncated: true }
}

export async function executeSshCommand(store: SshManagerStore, hostId: string, command: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<SshCommandResult> {
  if (command.trim() === '' || command.length > 32_768) throw new Error('SSH command must contain 1 to 32768 characters')
  const timeout = Math.min(10 * 60_000, Math.max(1_000, Math.trunc(timeoutMs)))
  const connection = await connectSshHost(store, hostId)
  const started = performance.now()
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    let streamRef: { close(): void } | undefined
    const finish = (error?: Error, exitCode: number | null = null, exitSignal: string | null = null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      connection.client.end()
      if (error !== undefined) reject(error)
      else resolve({ hostId, exitCode, signal: exitSignal, stdout, stderr, durationMs: Math.round(performance.now() - started), truncated })
    }
    const abort = (): void => { streamRef?.close(); finish(new Error('SSH command was cancelled')) }
    const timer = setTimeout(() => { streamRef?.close(); finish(new Error('SSH command timed out after ' + timeout.toString() + ' ms')) }, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    connection.client.exec(command, (error, stream) => {
      if (error !== undefined) { finish(error); return }
      streamRef = stream
      stream.on('data', (chunk: Buffer) => { const next = appendBounded(stdout, Buffer.from(chunk)); stdout = next.value; truncated ||= next.truncated })
      stream.stderr.on('data', (chunk: Buffer) => { const next = appendBounded(stderr, Buffer.from(chunk)); stderr = next.value; truncated ||= next.truncated })
      stream.once('close', (code: number | null, remoteSignal: string | null) => { finish(undefined, code, remoteSignal) })
      stream.once('error', (streamError: Error) => { finish(streamError) })
    })
  })
}
