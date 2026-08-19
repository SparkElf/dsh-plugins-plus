/**
 * Multi-user bridge server: phones and desktops authenticate with email
 * verification codes or WeChat and bind to a pairing code. The server is a
 * BLIND forwarder: `/ws/client` and `/ws/bridge` sockets are piped verbatim,
 * so relayed payloads stay end-to-end encrypted between the phone service
 * worker and the desktop plugin; the server never parses relay frames.
 * Bridges dial OUT from the local network, so no inbound port is needed.
 * @module @sparkelf/dsh-mobile-bridge-server/server
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { SW_SOURCE, CLIENT_SOURCE } from './phone.ts'
import { UserStore } from './store.ts'

/** Verifies one external login payload and returns the stable identity. */
export type ExternalAuthVerifier = (payload: Record<string, unknown>) => Promise<string>

/** Sends one verification code email; injected so tests never touch SMTP. */
export type CodeMailer = (email: string, code: string) => Promise<void>

/** Options for the bridge server. */
export interface BridgeServerOptions {
  /** Enabled external login providers (e.g. wechat) with their verifiers. */
  externalAuth?: Record<string, ExternalAuthVerifier>
  /** Delivers email verification codes; required for email login. */
  mailer?: CodeMailer
}

const COOKIE = 'mbs'

const LANDING = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>DSH Mobile Bridge</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#14161a;color:#e8eaed;display:grid;place-items:center;min-height:100vh}main{width:min(92vw,380px);background:#1d2127;border-radius:14px;padding:24px}h1{font-size:18px;margin:0 0 12px}input{width:100%;box-sizing:border-box;margin:6px 0;padding:10px;border-radius:8px;border:1px solid #333a44;background:#14161a;color:inherit}button{width:100%;margin-top:10px;padding:10px;border:0;border-radius:8px;background:#4c8dff;color:#fff;font-weight:600}button.ghost{background:#2a3038}p.err{color:#ff8080;min-height:1.2em}</style>
<main><h1>DeepSeek Harness Mobile</h1><input id=e type=email placeholder=邮箱><div style=display:flex;gap:8px><input id=c placeholder=验证码 style=margin:6px 0><button id=s class=ghost style=margin:6px 0;width:40%>发送</button></div><input id=b placeholder=绑定码（扫码可免填）><p class=err id=x></p><button id=l>登录并连接</button></main>
<script src="/bridge/client.js"></script>`

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function cookieToken(req: IncomingMessage): string {
  const header = req.headers.cookie ?? ''
  const match = header.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * Build the bridge server: `/bridge/*` owns auth/bind/landing plus the phone
 * bootstrap assets; `/ws/bridge` and `/ws/client` are piped verbatim.
 * @param store - user/token/binding store.
 * @param options - mailer and external auth provider verifiers.
 * @returns the node HTTP server (listen owned by the caller).
 */
export function createBridgeServer(store: UserStore, options: BridgeServerOptions = {}) {
  const externalAuth = options.externalAuth ?? {}
  const mailer = options.mailer
  const bridges = new Map<string, WebSocket>()

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/bridge' || url.pathname === '/bridge/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LANDING)
        return
      }
      if (url.pathname === '/bridge/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(CLIENT_SOURCE)
        return
      }
      if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'service-worker-allowed': '/' })
        res.end(SW_SOURCE)
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/email/code') {
        if (mailer === undefined) { json(res, 503, { error: 'email login not configured' }); return }
        try {
          const { email } = JSON.parse(await readBody(req)) as { email: string }
          const code = store.issueEmailCode(email)
          await mailer(email, code)
          json(res, 200, { sent: true })
        } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/email') {
        try {
          const { email, code, bridge } = JSON.parse(await readBody(req)) as { email: string; code: string; bridge?: string }
          store.consumeEmailCode(email, code)
          const token = store.loginExternal('email', email.trim().toLowerCase())
          if (typeof bridge === 'string' && bridge.trim().length > 0) store.bind(token, bridge)
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`] })
          res.end(JSON.stringify({ token }))
        } catch (error) { json(res, 401, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/external') {
        try {
          const { provider, payload } = JSON.parse(await readBody(req)) as { provider: string; payload: Record<string, unknown> }
          const verify = externalAuth[provider]
          if (!verify) throw new Error('unknown provider')
          const externalId = await verify(payload ?? {})
          const token = store.loginExternal(provider, externalId)
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`] })
          res.end(JSON.stringify({ token }))
        } catch (error) { json(res, 401, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      const token = cookieToken(req) || (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (req.method === 'GET' && url.pathname === '/bridge/api/me') {
        const name = store.userFor(token)
        if (!name) { json(res, 401, { error: 'unknown token' }); return }
        json(res, 200, { name, bridge: store.bridgeFor(token) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bind') {
        try {
          const { bridge } = JSON.parse(await readBody(req)) as { bridge: string }
          json(res, 200, { name: store.bind(token, bridge) })
        } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bridge/start') {
        const code = randomBytes(3).toString('hex')
        bridges.set(code, null as unknown as WebSocket)
        json(res, 200, { code })
        return
      }
      json(res, 404, { error: 'not found' })
    })()
  })

  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ws/bridge') {
      const code = url.searchParams.get('code') ?? ''
      if (!bridges.has(code)) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => {
        bridges.set(code, ws)
        ws.on('close', () => { if (bridges.get(code) === ws) bridges.delete(code) })
      })
      return
    }
    if (url.pathname === '/ws/client') {
      const token = url.searchParams.get('token') ?? cookieToken(req)
      const bridge = store.bridgeFor(token)
      const bridgeSocket = bridge ? bridges.get(bridge) : undefined
      if (!bridge || !bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, client => {
        // Blind pipe: raw frames only, never parsed.
        client.on('message', raw => { if (bridgeSocket.readyState === WebSocket.OPEN) bridgeSocket.send(raw.toString()) })
        bridgeSocket.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(raw.toString()) })
        const detach = () => { bridgeSocket.removeAllListeners('message') }
        client.on('close', detach)
      })
      return
    }
    socket.destroy()
  })

  return http
}
