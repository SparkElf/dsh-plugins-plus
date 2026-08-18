/**
 * Multi-user bridge server: mobile browsers authenticate with session tokens
 * and talk HTTP-through-WebSocket to the local DeepSeek Harness instance whose
 * plugin holds the paired bridge code. Bridges dial OUT from the local network,
 * so no inbound port or NAT rule is needed at home.
 * @module @sparkelf/dsh-mobile-bridge-server/server
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { UserStore } from './store.ts'

/** One HTTP request relayed from a mobile client to a local bridge. */
export interface RelayRequest {
  id: string
  kind: 'http'
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/** The bridge's answer to one relayed request. */
export interface RelayResponse {
  id: string
  status: number
  headers: Record<string, string>
  body: string
}

const LANDING = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>DSH Mobile Bridge</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#14161a;color:#e8eaed;display:grid;place-items:center;min-height:100vh}main{width:min(92vw,380px);background:#1d2127;border-radius:14px;padding:24px}h1{font-size:18px;margin:0 0 12px}input{width:100%;box-sizing:border-box;margin:6px 0;padding:10px;border-radius:8px;border:1px solid #333a44;background:#14161a;color:inherit}button{width:100%;margin-top:10px;padding:10px;border:0;border-radius:8px;background:#4c8dff;color:#fff;font-weight:600}p.err{color:#ff8080;min-height:1.2em}</style>
<main><h1>DeepSeek Harness Mobile</h1><input id=u placeholder=用户名><input id=p type=password placeholder=密码><input id=b placeholder=绑定码（首次登录后填）><p class=err id=e></p><button id=r>注册</button><button id=l>登录</button><button id=g>绑定并进入</button></main>
<script>const $=id=>document.getElementById(id);const api=async(p,o)=>{const r=await fetch(p,o);const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j};const tok=()=>localStorage.t;$('r').onclick=async()=>{try{localStorage.t=(await api('/api/register',{method:'POST',body:JSON.stringify({name:$('u').value,password:$('p').value})})).token;$('e').textContent='已注册，请绑定'}catch(e){$('e').textContent=e.message}};$('l').onclick=async()=>{try{localStorage.t=(await api('/api/login',{method:'POST',body:JSON.stringify({name:$('u').value,password:$('p').value})})).token;$('e').textContent='已登录，请填绑定码'}catch(e){$('e').textContent=e.message}};$('g').onclick=async()=>{try{await api('/api/bind',{method:'POST',headers:{authorization:'Bearer '+tok(), 'content-type':'application/json'},body:JSON.stringify({bridge:$('b').value})});location.href='/app'}catch(e){$('e').textContent=e.message}};</script>`

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the bridge server: HTTP auth/bind/landing routes plus two WebSocket
 * endpoints (`/ws/bridge` for local plugins, `/ws/client` for browsers).
 * @param store - user/token/binding store.
 * @returns the node HTTP server (listen owned by the caller).
 */
export function createBridgeServer(store: UserStore) {
  const bridges = new Map<string, WebSocket>()
  const pending = new Map<string, (response: RelayResponse) => void>()

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LANDING)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        try {
          const { name, password } = JSON.parse(await readBody(req)) as { name: string; password: string }
          json(res, 200, { token: store.register(name, password) })
        } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        try {
          const { name, password } = JSON.parse(await readBody(req)) as { name: string; password: string }
          json(res, 200, { token: store.login(name, password) })
        } catch (error) { json(res, 401, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const name = store.userFor(token)
        if (!name) { json(res, 401, { error: 'unknown token' }); return }
        json(res, 200, { name, bridge: store.bridgeFor(token) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/bind') {
        try {
          const { bridge } = JSON.parse(await readBody(req)) as { bridge: string }
          json(res, 200, { name: store.bind(token, bridge) })
        } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/start') {
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
        ws.on('message', raw => {
          const message = JSON.parse(String(raw)) as RelayResponse
          const settle = pending.get(message.id)
          if (settle) { pending.delete(message.id); settle(message) }
        })
        ws.on('close', () => { if (bridges.get(code) === ws) bridges.delete(code) })
      })
      return
    }
    if (url.pathname === '/ws/client') {
      const token = url.searchParams.get('token') ?? ''
      const bridge = store.bridgeFor(token)
      const bridgeSocket = bridge ? bridges.get(bridge) : undefined
      if (!bridge || !bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', raw => {
          const request = JSON.parse(String(raw)) as RelayRequest
          pending.set(request.id, response => { ws.send(JSON.stringify(response)) })
          bridgeSocket.send(JSON.stringify(request))
        })
      })
      return
    }
    socket.destroy()
  })

  return http
}
