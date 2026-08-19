/**
 * Multi-user bridge server: phones authenticate with a session cookie, bind
 * to a pairing code, and then the server reverse-proxies every other request
 * through the outbound tunnel into the owner's local DeepSeek Harness web —
 * the stock responsive UI, design system and all, with the narrow-width
 * overlay stylesheet injected into HTML responses. Bridges dial OUT from the
 * local network, so no inbound port or NAT rule is needed at home.
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
  /** 'text' carries utf-8; 'base64' carries binary-safe payloads. */
  bodyEncoding?: 'text' | 'base64'
}

/** Verifies one external login payload and returns the stable identity. */
export type ExternalAuthVerifier = (payload: Record<string, unknown>) => Promise<string>

/** Options for the bridge server. */
export interface BridgeServerOptions {
  /** Enabled external login providers (e.g. wechat) with their verifiers. */
  externalAuth?: Record<string, ExternalAuthVerifier>
}

const COOKIE = 'mbs'

const LANDING = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>DSH Mobile Bridge</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#14161a;color:#e8eaed;display:grid;place-items:center;min-height:100vh}main{width:min(92vw,380px);background:#1d2127;border-radius:14px;padding:24px}h1{font-size:18px;margin:0 0 12px}input{width:100%;box-sizing:border-box;margin:6px 0;padding:10px;border-radius:8px;border:1px solid #333a44;background:#14161a;color:inherit}button{width:100%;margin-top:10px;padding:10px;border:0;border-radius:8px;background:#4c8dff;color:#fff;font-weight:600}p.err{color:#ff8080;min-height:1.2em}</style>
<main><h1>DeepSeek Harness Mobile</h1><input id=u placeholder=用户名><input id=p type=password placeholder=密码><input id=b placeholder=绑定码（登录后填，首次）><p class=err id=e></p><button id=r>注册</button><button id=l>登录</button><button id=g>绑定并进入</button></main>
<script>const $=id=>document.getElementById(id);const api=async(p,o)=>{const r=await fetch('/bridge'+p,Object.assign({credentials:'same-origin'},o));const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j};$('r').onclick=async()=>{try{await api('/api/register',{method:'POST',body:JSON.stringify({name:$('u').value,password:$('p').value})});$('e').textContent='已注册，请登录'}catch(e){$('e').textContent=e.message}};$('l').onclick=async()=>{try{await api('/api/login',{method:'POST',body:JSON.stringify({name:$('u').value,password:$('p').value})});$('e').textContent='已登录；未绑定请填绑定码，已绑定刷新即进入'}catch(e){$('e').textContent=e.message}};$('g').onclick=async()=>{try{await api('/api/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bridge:$('b').value})});location.href='/'}catch(e){$('e').textContent=e.message}};</script>`

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
 * @param options - external auth provider verifiers; empty by default.
 * @returns the node HTTP server (listen owned by the caller).
 */
export function createBridgeServer(store: UserStore, options: BridgeServerOptions = {}) {
  const externalAuth = options.externalAuth ?? {}
  const bridges = new Map<string, WebSocket>()
  const pending = new Map<string, (response: RelayResponse) => void>()

  const relay = (socket: WebSocket, request: Omit<RelayRequest, 'id'>): Promise<RelayResponse> =>
    new Promise((resolve, reject) => {
      const id = randomBytes(8).toString('hex')
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('relay timeout')) }, 30_000)
      pending.set(id, response => { clearTimeout(timer); pending.delete(id); resolve(response) })
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
      if (req.method === 'POST' && url.pathname === '/bridge/api/register') {
        try {
          const { name, password } = JSON.parse(await readBody(req)) as { name: string; password: string }
          const token = store.register(name, password)
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`] })
          res.end(JSON.stringify({ token }))
        } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login') {
        try {
          const { name, password } = JSON.parse(await readBody(req)) as { name: string; password: string }
          const token = store.login(name, password)
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
      try {
        const response = await relay(socket, {
          kind: 'http',
          method: req.method ?? 'GET',
          path: url.pathname + url.search,
          headers,
          body: rawBody.toString('base64'),
          bodyEncoding: 'base64',
        })
        const contentType = response.headers['content-type'] ?? ''
        let out = response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64') : Buffer.from(response.body, 'utf8')
        if (response.bodyEncoding !== 'base64' && contentType.includes('text/html')) {
          out = Buffer.from(out.toString('utf8').replace('</head>', '<link rel="stylesheet" href="/mobile/bridge/style.css"></head>'), 'utf8')
        }
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
          const message = JSON.parse(String(raw)) as RelayResponse
          const settle = pending.get(message.id)
          if (settle) settle(message)
        })
        ws.on('close', () => { if (bridges.get(code) === ws) bridges.delete(code) })
      })
      return
    }
    socket.destroy()
  })

  return http
}
