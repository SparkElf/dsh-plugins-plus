/**
 * Multi-user bridge server: phones and desktops authenticate with email
 * verification codes or WeChat, bind to a pairing code, and every other
 * request reverse-proxies through the outbound tunnel into the owner's local
 * Harness web. Relay bodies stay opaque base64 so the server never reads
 * client payload bytes (the E2EE layer encrypts them client-side). Bridges
 * dial OUT from the local network, so no inbound port or NAT rule is needed.
 * @module @sparkelf/dsh-mobile-bridge-server/server
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { UserStore } from './store.ts'

/** One HTTP request relayed from the server to a local bridge. */
export interface RelayRequest {
  id: string
  kind: 'http'
  method: string
  path: string
  headers: Record<string, string>
  body: string
  /** 'text' carries utf-8; 'base64' carries binary-safe payloads. */
  bodyEncoding?: 'text' | 'base64'
}

/** The bridge's answer to one relayed request. */
export interface RelayResponse {
  id: string
  status: number
  headers: Record<string, string>
  body: string
  bodyEncoding?: 'text' | 'base64'
  stream?: boolean
  chunk?: string
  end?: boolean
}

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
<main><h1>DeepSeek Harness Mobile</h1><input id=e type=email placeholder=邮箱><div style=display:flex;gap:8px><input id=c placeholder=验证码 style=margin:6px 0><button id=s class=ghost style=margin:6px 0;width:40%>发送</button></div><input id=b placeholder=绑定码（可选，扫码免填）><p class=err id=x></p><button id=l>登录</button></main>
<script>const $=id=>document.getElementById(id);const api=async(p,o)=>{const r=await fetch('/bridge'+p,Object.assign({credentials:'same-origin'},o));const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j};$('s').onclick=async()=>{try{await api('/api/email/code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:$('e').value})});$('x').textContent='验证码已发送'}catch(e){$('x').textContent=e.message}};$('l').onclick=async()=>{try{await api('/api/login/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:$('e').value,code:$('c').value,bridge:$('b').value})});location.href='/'}catch(e){$('x').textContent=e.message}};</script>`

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function cookieToken(req: IncomingMessage): string {
  const header = req.headers.cookie ?? ''
  const match = header.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * Build the bridge server: `/bridge/*` owns auth/bind/landing; everything else
 * reverse-proxies through the paired bridge tunnel for bound cookie sessions.
 * @param store - user/token/binding store.
 * @param options - mailer and external auth provider verifiers.
 * @returns the node HTTP server (listen owned by the caller).
 */
export function createBridgeServer(store: UserStore, options: BridgeServerOptions = {}) {
  const externalAuth = options.externalAuth ?? {}
  const mailer = options.mailer
  const bridges = new Map<string, WebSocket>()
  const pending = new Map<string, { settle?: (response: RelayResponse) => void; timer?: ReturnType<typeof setTimeout>; res?: ServerResponse }>()

  interface PendingEntry { settle?: (response: RelayResponse) => void; timer?: ReturnType<typeof setTimeout>; res?: ServerResponse }

  const relay = (socket: WebSocket, request: Omit<RelayRequest, 'id'>): Promise<RelayResponse> =>
    new Promise((resolve, reject) => {
      const id = randomBytes(8).toString('hex')
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('relay timeout')) }, 30_000)
      const entry: PendingEntry = { settle: response => { clearTimeout(timer); pending.delete(id); resolve(response) }, timer }
      pending.set(id, entry)
      socket.send(JSON.stringify({ id, ...request }))
    })

  /** Stream one event-stream request straight into the phone response. */
  const relayStream = (socket: WebSocket, request: Omit<RelayRequest, 'id'>, res: ServerResponse): Promise<void> =>
    new Promise(resolve => {
      const id = randomBytes(8).toString('hex')
      const entry: PendingEntry = { res }
      pending.set(id, entry)
      res.on('close', () => { pending.delete(id); resolve() })
      socket.send(JSON.stringify({ id, ...request }))
    })

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/bridge' || url.pathname === '/bridge/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LANDING)
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
      // Reverse proxy for bound sessions: everything else rides the tunnel.
      const bridge = store.bridgeFor(token)
      const socket = bridge ? bridges.get(bridge) : undefined
      if (!bridge || !socket || socket.readyState !== WebSocket.OPEN) {
        res.writeHead(302, { location: '/bridge/' })
        res.end()
        return
      }
      const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBodyBuffer(req)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && !['host', 'cookie', 'authorization', 'connection'].includes(key)) headers[key] = value
      }
      const requestFrame = {
        kind: 'http' as const,
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        headers,
        body: rawBody.toString('base64'),
        bodyEncoding: 'base64' as const,
      }
      if ((req.headers.accept ?? '').includes('text/event-stream')) {
        await relayStream(socket, requestFrame, res)
        return
      }
      try {
        const response = await relay(socket, requestFrame)
        const contentType = response.headers['content-type'] ?? ''
        const out = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64') : Buffer.from(response.body, 'utf8')
        res.writeHead(response.status, { 'content-type': contentType || 'application/octet-stream' })
        res.end(out)
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
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
        ws.on('message', raw => {
          const frame = JSON.parse(String(raw)) as RelayResponse
          const entry = pending.get(frame.id)
          if (!entry) return
          if (frame.stream && entry.res) {
            entry.res.writeHead(frame.status ?? 200, { 'content-type': frame.headers?.['content-type'] ?? 'text/event-stream', 'cache-control': 'no-cache' })
            return
          }
          if (frame.chunk !== undefined && entry.res) {
            entry.res.write(Buffer.from(frame.chunk, frame.bodyEncoding === 'text' ? 'utf8' : 'base64'))
            return
          }
          if (frame.end && entry.res) {
            pending.delete(frame.id)
            entry.res.end()
            return
          }
          if (entry.settle) {
            if (entry.timer) clearTimeout(entry.timer)
            pending.delete(frame.id)
            entry.settle(frame)
          }
        })
        ws.on('close', () => { if (bridges.get(code) === ws) bridges.delete(code) })
      })
      return
    }
    socket.destroy()
  })

  return http
}
