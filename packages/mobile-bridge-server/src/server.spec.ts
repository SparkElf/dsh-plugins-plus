import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relayToLocalWeb, type RelayRequest } from '../../mobile-bridge/src/index.ts'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

let local: Server
let bridge: Server
let localPort: number
let bridgePort: number
let sentCodes: { email: string; code: string }[]
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

beforeAll(async () => {
  local = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 50)
      return
    }
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><head></head><body>stock web</body>')
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

async function emailLogin(): Promise<string> {
  const base = `http://127.0.0.1:${bridgePort}`
  await fetch(base + '/bridge/api/email/code', {
    method: 'POST',
    body: JSON.stringify({ email: 'dee@example.com' }),
  })
  const code = sentCodes.at(-1)?.code ?? ''
  const login = await fetch(base + '/bridge/api/login/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'dee@example.com', code }),
  })
  expect(login.status).toBe(200)
  return login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function connectedBridge(): Promise<{ cookie: string; socket: WebSocket }> {
  const base = `http://127.0.0.1:${bridgePort}`
  const cookie = await emailLogin()
  const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
  await fetch(base + '/bridge/api/bind', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ bridge: start.code }),
  })
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
  await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject) })
  socket.on('message', raw => {
    const request = JSON.parse(String(raw)) as RelayRequest
    void relayToLocalWeb(request, localPort, frame => socket.send(JSON.stringify(frame)))
  })
  return { cookie, socket }
}

describe('bridge server end to end', () => {
  it('emails a code, logs in, and proxies the stock web through the tunnel', async () => {
    const { cookie, socket } = await connectedBridge()
    const page = await fetch(`http://127.0.0.1:${bridgePort}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('stock web')

    const image = await fetch(`http://127.0.0.1:${bridgePort}/logo.png`, { headers: { cookie } })
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
    socket.close()
  })

  it('streams SSE through the tunnel in order', async () => {
    const { cookie, socket } = await connectedBridge()
    const response = await fetch(`http://127.0.0.1:${bridgePort}/events`, { headers: { cookie, accept: 'text/event-stream' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
    socket.close()
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

  it('redirects unbound or logged-out phones to the landing page', async () => {
    const page = await fetch(`http://127.0.0.1:${bridgePort}/`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/bridge/')
  })
})
