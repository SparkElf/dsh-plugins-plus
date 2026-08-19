/**
 * Multi-user bridge server: phones and desktops authenticate with email
 * verification codes or WeChat and bind to a pairing code. The server is a
 * BLIND forwarder: `/ws/client` and `/ws/bridge` sockets are piped verbatim,
 * so relayed payloads stay end-to-end encrypted between the phone service
 * worker and the desktop plugin; the server never parses relay frames.
 * Bridges dial OUT from the local network, so no inbound port is needed.
 * @module @sparkelf/dsh-mobile-bridge-server/server
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { SW_SOURCE, CLIENT_SOURCE } from './phone.ts'
import { UserStore } from './store.ts'
import type { WechatConfig } from './wechat.ts'
import { generateScheme } from './wechat-scheme.ts'

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
  /** WeChat credentials enabling URL Scheme generation for mini-program QRs. */
  wechatScheme?: WechatConfig
}

const COOKIE = 'mbs'
const DEEPSEEK_LOGO = readFileSync(new URL('./deepseek-logo.svg', import.meta.url), 'utf8')

const LANDING = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>DeepSeek Harness Mobile</title>
<style>
:root{color-scheme:dark;--page:#0d1015;--surface:#161b23;--field:#0f131a;--border:#303846;--label:#f4f7fb;--muted:#aeb8c8;--placeholder:#818da1;--primary:#405de6;--primary-hover:#4965ef;--danger:#ff7b84}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;background:var(--page)}
body{min-height:100dvh;margin:0;padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom));background:var(--page);color:var(--label);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body::before{position:fixed;inset:0;content:"";pointer-events:none;background-image:linear-gradient(rgb(77 107 254/.055) 1px,transparent 1px),linear-gradient(90deg,rgb(77 107 254/.055) 1px,transparent 1px);background-size:32px 32px}
main{position:relative;width:min(100%,420px);margin:clamp(8px,5vh,44px) auto 0;padding:24px;border:1px solid var(--border);border-top:2px solid var(--primary);border-radius:8px;background:rgb(22 27 35/.96);box-shadow:0 24px 64px rgb(2 6 14/.42)}
.brand{display:flex;align-items:center;gap:12px;padding-bottom:18px;border-bottom:1px solid var(--border)}
.brand img{display:block;width:148px;height:auto}
.product{padding-left:12px;border-left:1px solid var(--border);color:var(--muted);font-size:11px;font-weight:650;line-height:1.2}
.intro{margin:20px 0}
h1{margin:0;font-size:20px;line-height:1.35;font-weight:650}
.intro p,.scanFirst{margin:4px 0 0;color:var(--muted);font-size:13px}
.scanFirst{padding:14px 0 2px;border-top:1px solid var(--border)}
[hidden]{display:none!important}
.field{display:grid;gap:6px}
.field+.field,.codeRow+.field{margin-top:14px}
label{color:var(--muted);font-size:12px;font-weight:600}
input,button{width:100%;min-width:0;height:44px;border-radius:8px;font:inherit}
input{padding:0 12px;border:1px solid var(--border);outline:none;background:var(--field);color:var(--label);font-size:16px}
input::placeholder{color:var(--placeholder)}
input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgb(77 107 254/.16)}
.codeRow{display:grid;grid-template-columns:minmax(0,1fr) 96px;align-items:end;gap:8px;margin-top:14px}
button{border:0;background:var(--primary);color:white;font-weight:650;cursor:pointer;transition:background-color .16s ease,transform .08s ease}
button:hover{background:var(--primary-hover)}
button:active{transform:translateY(1px)}
button.ghost{border:1px solid var(--border);background:#252c37;color:var(--label)}
button.ghost:hover{background:#303846}
button:disabled{opacity:.6;cursor:wait}
#l{margin-top:20px}
p.err{min-height:20px;margin:10px 0 0;color:var(--danger);font-size:13px;line-height:20px}
@media(max-width:340px){main{padding:18px}.brand img{width:132px}.codeRow{grid-template-columns:minmax(0,1fr) 84px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body>
<main aria-labelledby="title"><header class="brand"><img src="/bridge/deepseek-logo.svg" alt="DeepSeek"><span class="product">HARNESS<br>MOBILE</span></header><div class="intro"><h1 id="title">移动连接</h1><p>端到端加密通道</p></div><p class="scanFirst" id="scanFirst">请扫描桌面端二维码</p><section id="loginForm" hidden><div class="field"><label for="e">邮箱</label><input id="e" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com"></div><div class="codeRow"><div class="field"><label for="c">验证码</label><input id="c" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码"></div><button id="s" class="ghost" type="button">发送</button></div><div class="field"><label for="b">配对码</label><input id="b" autocomplete="off" placeholder="6 位字符"></div><button id="l" type="button">登录并连接</button><p class="err" id="x" role="alert"></p></section></main>
<script src="/bridge/client.js"></script></body></html>`

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
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
/** Options for the bridge server. */
export interface BridgeServerRuntimeOptions extends BridgeServerOptions {
  /** Pairing login ticket lifetime; defaults to five minutes. */
  ticketTtlMs?: number
}

export function createBridgeServer(store: UserStore, options: BridgeServerRuntimeOptions = {}) {
  const externalAuth = options.externalAuth ?? {}
  const mailer = options.mailer
  const ticketTtlMs = options.ticketTtlMs ?? 5 * 60_000
  const bridges = new Map<string, WebSocket | null>()
  const bridgeCodes = new Map<WebSocket, string>()
  const tickets = new Map<string, { createdAt: number; used: boolean; refreshToken: string; email2fa?: string }>()

  const issueTicket = (email2fa?: string) => {
    const code = randomBytes(3).toString('hex')
    const refreshToken = randomBytes(24).toString('hex')
    const createdAt = Date.now()
    tickets.set(code, { createdAt, used: false, refreshToken, ...email2fa ? { email2fa } : {} })
    return { code, refreshToken, expiresAt: createdAt + ticketTtlMs }
  }

  const notifyPaired = (code: string): void => {
    const socket = bridges.get(code)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ control: 'paired' }))
  }

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/bridge' || url.pathname === '/bridge/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LANDING)
        return
      }
      if (url.pathname === '/bridge/deepseek-logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
        res.end(DEEPSEEK_LOGO)
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
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/bridge') {
        // QR auto-login: possession of a live pairing code proves the desktop
        // is online; the phone gets a session without typing credentials.
        try {
          const { code } = JSON.parse(await readBody(req)) as { code: string }
          const ticket = tickets.get(code)
          const bridgeSocket = bridges.get(code)
          if (ticket === undefined || bridgeSocket?.readyState !== WebSocket.OPEN) throw new Error('unknown or offline pairing code')
          if (ticket.used) throw new Error('pairing code already used')
          if (Date.now() - ticket.createdAt > ticketTtlMs) throw new Error('pairing code expired')
          if (ticket.email2fa !== undefined && mailer !== undefined) {
            // Optional second factor: the owner's inbox must confirm the scan.
            await mailer(ticket.email2fa, store.issueEmailCode(ticket.email2fa))
            json(res, 200, { challenge: 'email' })
            return
          }
          ticket.used = true
          notifyPaired(code)
          const token = store.loginExternal('bridge', code)
          store.bind(token, code)
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`] })
          res.end(JSON.stringify({ token }))
        } catch (error) { json(res, 401, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/bridge/verify') {
        try {
          const { code, emailCode } = JSON.parse(await readBody(req)) as { code: string; emailCode: string }
          const ticket = tickets.get(code)
          const bridgeSocket = bridges.get(code)
          if (ticket === undefined || bridgeSocket?.readyState !== WebSocket.OPEN || ticket.email2fa === undefined) throw new Error('no pending challenge')
          if (ticket.used) throw new Error('pairing code already used')
          if (Date.now() - ticket.createdAt > ticketTtlMs) throw new Error('pairing code expired')
          store.consumeEmailCode(ticket.email2fa, emailCode)
          ticket.used = true
          notifyPaired(code)
          const token = store.loginExternal('bridge', code)
          store.bind(token, code)
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
      if (req.method === 'GET' && url.pathname === '/bridge/wxauth') {
        // Mini-program web-view entry: wx.login code plus optional pairing.
        const code = url.searchParams.get('code') ?? ''
        const pair = url.searchParams.get('pair') ?? ''
        const verify = externalAuth.wechat
        if (verify === undefined) { json(res, 503, { error: 'wechat not configured' }); return }
        try {
          const externalId = await verify({ code })
          const token = store.loginExternal('wechat', externalId)
          if (pair.length > 0) store.bind(token, pair)
          res.writeHead(302, {
            'set-cookie': [`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`],
            location: '/',
          })
          res.end()
        } catch (error) { json(res, 401, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/scheme') {
        if (options.wechatScheme === undefined) { json(res, 503, { error: 'wechat not configured' }); return }
        try {
          const { query } = JSON.parse(await readBody(req)) as { query: string }
          const openlink = await generateScheme(options.wechatScheme, String(query ?? '').slice(0, 512))
          json(res, 200, { openlink })
        } catch (error) { json(res, 502, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bridge/start') {
        const { email2fa } = JSON.parse(await readBody(req) || '{}') as { email2fa?: string }
        const issued = issueTicket(typeof email2fa === 'string' && email2fa.length > 0 ? email2fa : undefined)
        bridges.set(issued.code, null)
        json(res, 200, issued)
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bridge/rotate') {
        const { code, refreshToken } = JSON.parse(await readBody(req) || '{}') as { code?: string; refreshToken?: string }
        if (typeof code !== 'string' || typeof refreshToken !== 'string') {
          json(res, 401, { error: 'invalid pairing refresh token' })
          return
        }
        const ticket = tickets.get(code)
        if (ticket === undefined || !sameToken(ticket.refreshToken, refreshToken)) {
          json(res, 401, { error: 'invalid pairing refresh token' })
          return
        }
        if (ticket.used) {
          json(res, 409, { paired: true })
          return
        }
        const socket = bridges.get(code)
        if (socket == null || socket.readyState !== WebSocket.OPEN) {
          json(res, 409, { error: 'bridge is offline' })
          return
        }
        const issued = issueTicket(ticket.email2fa)
        bridges.delete(code)
        tickets.delete(code)
        bridges.set(issued.code, socket)
        bridgeCodes.set(socket, issued.code)
        json(res, 200, issued)
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
        bridgeCodes.set(ws, code)
        ws.on('close', () => {
          const activeCode = bridgeCodes.get(ws)
          if (activeCode !== undefined && bridges.get(activeCode) === ws) {
            bridges.delete(activeCode)
            tickets.delete(activeCode)
          }
          bridgeCodes.delete(ws)
        })
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
