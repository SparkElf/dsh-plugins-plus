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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

beforeAll(async () => {
  local = createServer((req, res) => {
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
  const store = new UserStore(join(mkdtempSync(join(tmpdir(), 'mbs-')), 'u.json'), '0123456789abcdef')
  bridge = createBridgeServer(store)
  await new Promise<void>(resolve => bridge.listen(0, resolve))
  bridgePort = (bridge.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise(resolve => bridge.close(resolve))
  await new Promise(resolve => local.close(resolve))
})

describe('bridge server end to end', () => {
  it('registers, binds, and proxies the stock web through the tunnel', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    const register = await fetch(base + '/bridge/api/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'dee', password: 'longpassword' }),
    })
    expect(register.status).toBe(200)
    const cookie = register.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).toContain('mbs=')

    const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    expect(start.code).toMatch(/^[0-9a-f]{6}$/)

    const bind = await fetch(base + '/bridge/api/bind', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })
    expect(bind.status).toBe(200)

    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
    await new Promise<void>((resolve, reject) => { bridgeSocket.on('open', () => resolve()); bridgeSocket.on('error', reject) })
    bridgeSocket.on('message', raw => {
      const request = JSON.parse(String(raw)) as RelayRequest
      void relayToLocalWeb(request, localPort).then(response => bridgeSocket.send(JSON.stringify(response)))
    })

    const page = await fetch(base + '/', { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('stock web')
    expect(html).toContain('/mobile/bridge/style.css')

    const image = await fetch(base + '/logo.png', { headers: { cookie } })
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)

    bridgeSocket.close()
  })

  it('redirects unbound or logged-out phones to the landing page', async () => {
    const page = await fetch(`http://127.0.0.1:${bridgePort}/`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/bridge/')
  })

  it('rejects unknown external providers', async () => {
    const unknown = await fetch(`http://127.0.0.1:${bridgePort}/bridge/api/login/external`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'wechat', payload: { code: 'c1' } }),
    })
    expect(unknown.status).toBe(401)
  })
})
