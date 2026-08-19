import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptJSON, deriveKey, encryptJSON } from '../../mobile-bridge/src/crypto.ts'
import { relayToLocalWeb, type RelayRequest } from '../../mobile-bridge/src/index.ts'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

let local: Server
let bridge: Server
let localPort: number
let bridgePort: number
let sentCodes: { email: string; code: string }[]
const wireLog: string[] = []

beforeAll(async () => {
  local = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><head></head><body>stock web secret-marker</body>')
  })
  await new Promise<void>(resolve => local.listen(0, resolve))
  localPort = (local.address() as AddressInfo).port
  sentCodes = []
  const store = new UserStore(join(mkdtempSync(join(tmpdir(), 'mbs-')), 'u.json'), '0123456789abcdef')
  bridge = createBridgeServer(store, {
    mailer: async (email, code) => { sentCodes.push({ email, code }) },
  })
  await new Promise<void>(resolve => bridge.listen(0, resolve))
  bridgePort = (bridge.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise(resolve => bridge.close(resolve))
  await new Promise(resolve => local.close(resolve))
})

describe('bridge server end to end', () => {
  it('emails a code, logs in, and binds', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    await fetch(base + '/bridge/api/email/code', { method: 'POST', body: JSON.stringify({ email: 'dee@example.com' }) })
    const code = sentCodes.at(-1)?.code ?? ''
    const login = await fetch(base + '/bridge/api/login/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'dee@example.com', code }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    const bind = await fetch(base + '/bridge/api/bind', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })
    expect(bind.status).toBe(200)
  })

  it('pipes encrypted frames blindly: the phone reads the stock web, the wire stays ciphertext', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    await fetch(base + '/bridge/api/email/code', { method: 'POST', body: JSON.stringify({ email: 'phone@example.com' }) })
    const code = sentCodes.at(-1)?.code ?? ''
    const login = await fetch(base + '/bridge/api/login/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'phone@example.com', code }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    await fetch(base + '/bridge/api/bind', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })

    const pairingSecret = 'deadbeef'
    const desktopKey = await deriveKey('user-pass', pairingSecret)
    const phoneKey = await deriveKey('user-pass', pairingSecret)

    // Desktop side: decrypt phone frames, answer from the local web, encrypt back.
    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
    await new Promise<void>((resolve, reject) => { bridgeSocket.on('open', () => resolve()); bridgeSocket.on('error', reject) })
    bridgeSocket.on('message', raw => {
      const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
      wireLog.push(String(raw))
      if (wire.blob === undefined) return
      const blobIn = wire.blob
      void (async () => {
        const request = await decryptJSON<RelayRequest>(desktopKey, blobIn)
        await relayToLocalWeb({ ...request, id: wire.id }, localPort, frame => {
          void (async () => {
            if (frame.end) { bridgeSocket.send(JSON.stringify({ id: frame.id, end: true })); return }
            if (frame.stream) { bridgeSocket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(desktopKey, { stream: true, status: frame.status, headers: frame.headers }) })); return }
            if (frame.chunk !== undefined) { bridgeSocket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(desktopKey, { d: frame.chunk }) })); return }
            bridgeSocket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(desktopKey, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64' }) }))
          })()
        })
      })()
    })

    // Phone side (simulated service worker): encrypted request, decrypted response.
    const client = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/client`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => { client.on('open', () => resolve()); client.on('error', reject) })
    const answer = new Promise<{ status: number; html: string }>(resolve => {
      client.on('message', raw => {
        const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
        wireLog.push(String(raw))
        if (wire.blob === undefined) return
        void decryptJSON<{ status: number; body: string }>(phoneKey, wire.blob).then(full => {
          resolve({ status: full.status, html: Buffer.from(full.body, 'base64').toString('utf8') })
        })
      })
    })
    const blob = await encryptJSON(phoneKey, { method: 'GET', path: '/', headers: { accept: 'text/html' }, body: '', bodyEncoding: 'base64' })
    client.send(JSON.stringify({ id: 'p1', blob }))

    const result = await answer
    expect(result.status).toBe(200)
    expect(result.html).toContain('stock web secret-marker')
    for (const line of wireLog) expect(line).not.toContain('secret-marker')

    client.close()
    bridgeSocket.close()
  })

  it('rejects wrong codes and unknown providers', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    await fetch(base + '/bridge/api/email/code', { method: 'POST', body: JSON.stringify({ email: 'x@example.com' }) })
    const bad = await fetch(base + '/bridge/api/login/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@example.com', code: '000000' }),
    })
    expect(bad.status).toBe(401)
    const unknown = await fetch(base + '/bridge/api/login/external', {
      method: 'POST',
      body: JSON.stringify({ provider: 'wechat', payload: { code: 'c1' } }),
    })
    expect(unknown.status).toBe(401)
  })
})
