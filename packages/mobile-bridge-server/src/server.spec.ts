import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

let local: Server
let bridge: Server
let localPort: number
let bridgePort: number

beforeAll(async () => {
  local = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local-ok') })
  await new Promise<void>(resolve => local.listen(0, resolve))
  localPort = (local.address() as AddressInfo).port
  const store = new UserStore(join(mkdtempSync(join(tmpdir(), 'mbs-')), 'u.json'), '0123456789abcdef')
  bridge = createBridgeServer(store)
  await new Promise<void>(resolve => bridge.listen(0, resolve))
  bridgePort = (bridge.address() as AddressInfo).port
  ;(bridge as Server & { store?: UserStore }).store = store
})

afterAll(async () => {
  await new Promise(resolve => bridge.close(resolve))
  await new Promise(resolve => local.close(resolve))
})

describe('bridge server end to end', () => {
  it('registers, binds, and relays one http request through the tunnel', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    const register = await fetch(base + '/api/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'dee', password: 'longpassword' }),
    }).then(response => response.json()) as { token: string }
    expect(register.token).toBeTruthy()

    const start = await fetch(base + '/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    expect(start.code).toMatch(/^[0-9a-f]{6}$/)

    const bind = await fetch(base + '/api/bind', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + register.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })
    expect(bind.status).toBe(200)

    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
    await new Promise<void>((resolve, reject) => { bridgeSocket.on('open', () => resolve()); bridgeSocket.on('error', reject) })
    bridgeSocket.on('message', raw => {
      const request = JSON.parse(String(raw)) as { id: string; path: string }
      void fetch(`http://127.0.0.1:${localPort}${request.path}`).then(async response => {
        bridgeSocket.send(JSON.stringify({ id: request.id, status: response.status, headers: {}, body: await response.text() }))
      })
    })

    const client = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/client?token=${register.token}`)
    await new Promise<void>((resolve, reject) => { client.on('open', () => resolve()); client.on('error', reject) })
    const relayed = new Promise<{ status: number; body: string }>(resolve => {
      client.on('message', raw => resolve(JSON.parse(String(raw)) as { status: number; body: string }))
    })
    client.send(JSON.stringify({ id: 'q1', kind: 'http', method: 'GET', path: '/anything', headers: {}, body: '' }))
    await expect(relayed).resolves.toMatchObject({ status: 200, body: 'local-ok' })
    client.close()
    bridgeSocket.close()
  })

  it('accepts external logins through configured verifiers only', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    const unknown = await fetch(base + '/api/login/external', {
      method: 'POST',
      body: JSON.stringify({ provider: 'wechat', payload: { code: 'c1' } }),
    })
    expect(unknown.status).toBe(401)
  })

  it('rejects unbound or unknown clients on the client socket', async () => {
    const refused = new Promise<boolean>(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/client?token=bogus`)
      socket.on('error', () => resolve(true))
      socket.on('open', () => resolve(false))
    })
    expect(await refused).toBe(true)
  })
})
