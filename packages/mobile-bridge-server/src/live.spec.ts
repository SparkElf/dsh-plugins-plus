/**
 * Live dress rehearsal against a real local Harness web on :3080. Self-skips
 * in CI or anywhere the loopback web is absent; on a dev box it proves the
 * encrypted chain: phone-side crypto through the blind server pipe to the
 * desktop relay and back, reading the real stock HTML as ciphertext on wire.
 * @module @sparkelf/dsh-mobile-bridge-server/live
 */

import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, describe, expect, it } from 'vitest'
import { decryptJSON, deriveKey, encryptJSON } from '../../mobile-bridge/src/crypto.ts'
import { relayToLocalWeb, type RelayRequest } from '../../mobile-bridge/src/index.ts'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

const LIVE_PORT = Number(process.env.LIVE_HARNESS_PORT ?? 3080)

let reachable = false
try {
  const probe = await fetch(`http://127.0.0.1:${LIVE_PORT}/`, { signal: AbortSignal.timeout(3000) })
  reachable = probe.ok
} catch {
  reachable = false
}

let bridge: Server
let bridgePort: number
let liveCodes: string[] = []

if (reachable) {
  const store = new UserStore(join(mkdtempSync(join(tmpdir(), 'mbs-live-')), 'u.json'), '0123456789abcdef')
  const codes: string[] = []
  bridge = createBridgeServer(store, { mailer: async (_email, code) => { codes.push(code) } })
  liveCodes = codes
  await new Promise<void>(resolve => bridge.listen(0, resolve))
  bridgePort = (bridge.address() as AddressInfo).port
}

afterAll(async () => {
  if (reachable) await new Promise(resolve => bridge.close(resolve))
})

describe.skipIf(!reachable)('live rehearsal against the real Harness web', () => {
  it('reads the stock UI through the encrypted tunnel after email login', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    await fetch(base + '/bridge/api/email/code', {
      method: 'POST',
      body: JSON.stringify({ email: 'rehearsal@example.com' }),
    })
    const login = await fetch(base + '/bridge/api/login/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'rehearsal@example.com', code: liveCodes.at(-1) ?? '' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

    const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    await fetch(base + '/bridge/api/bind', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })

    const desktopKey = await deriveKey('', 'livepair')
    const phoneKey = await deriveKey('', 'livepair')
    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
    await new Promise<void>((resolve, reject) => { bridgeSocket.on('open', () => resolve()); bridgeSocket.on('error', reject) })
    bridgeSocket.on('message', raw => {
      const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
      if (wire.blob === undefined) return
      const blobIn = wire.blob
      void (async () => {
        const request = await decryptJSON<RelayRequest>(desktopKey, blobIn)
        await relayToLocalWeb({ ...request, id: wire.id }, LIVE_PORT, frame => {
          void (async () => {
            if (frame.end) { bridgeSocket.send(JSON.stringify({ id: frame.id, end: true })); return }
            if (frame.stream) { bridgeSocket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(desktopKey, { stream: true, status: frame.status, headers: frame.headers }) })); return }
            if (frame.chunk !== undefined) { bridgeSocket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(desktopKey, { d: frame.chunk }) })); return }
            bridgeSocket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(desktopKey, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64' }) }))
          })()
        })
      })()
    })

    const client = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/client`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => { client.on('open', () => resolve()); client.on('error', reject) })
    const answer = new Promise<string>(resolve => {
      client.on('message', raw => {
        const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
        if (wire.blob === undefined) return
        void decryptJSON<{ body: string }>(phoneKey, wire.blob).then(full => resolve(Buffer.from(full.body, 'base64').toString('utf8')))
      })
    })
    const blob = await encryptJSON(phoneKey, { method: 'GET', path: '/', headers: { accept: 'text/html' }, body: '', bodyEncoding: 'base64' })
    client.send(JSON.stringify({ id: 'live1', blob }))

    const html = await answer
    expect(html).toContain('__DSH_BOOT__')

    client.close()
    bridgeSocket.close()
  }, 20000)
})
