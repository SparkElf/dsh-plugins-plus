/**
 * Mobile bridge plugin: dials OUT to the public bridge server, serves the
 * narrow-width overlay under `/mobile/`, and answers the paired phone's
 * end-to-end encrypted relay frames against the local loopback web. The
 * pairing secret and optional user passphrase never leave the desktop except
 * inside the one-time QR payload; the server only forwards ciphertext.
 * @module @sparkelf/dsh-mobile-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { base64ToBytes, bytesToBase64, decryptJSON, deriveKey, encryptJSON } from './crypto.ts'

/** Plugin row config rendered by the stock settings page. */
export interface MobileBridgeConfig {
  serverUrl: string
  localPort: number
  /** Optional user passphrase mixed into every session key. */
  userKey: string
  autoConnect: boolean
  autoReconnect: boolean
}

/** One relayed request, decrypted from the phone. */
export interface RelayRequest {
  id: string
  kind?: 'http'
  method: string
  path: string
  headers: Record<string, string>
  body: string
  bodyEncoding?: 'text' | 'base64'
}

/** One outbound relay frame before encryption. */
export interface RelayFrame {
  id: string
  status?: number
  headers?: Record<string, string>
  stream?: boolean
  chunk?: string
  bodyEncoding?: 'text' | 'base64'
  end?: boolean
  body?: string
}

const TEXTUAL = /^(text\/|application\/(json|.*\+json))/

/**
 * Handle one decrypted relayed request against the local loopback web,
 * binary-safe and stream-aware.
 * @param request - decrypted relay request.
 * @param localPort - local Harness web port.
 * @param send - outbound plaintext frame sink (caller encrypts).
 * @param fetchImpl - fetch seam for tests.
 * @returns resolves when the local response completes.
 */
export async function relayToLocalWeb(
  request: RelayRequest,
  localPort: number,
  send: (frame: RelayFrame) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<RelayFrame> {
  try {
    const decoded = request.bodyEncoding === 'base64' ? Buffer.from(request.body, 'base64') : Buffer.from(request.body, 'utf8')
    const response = await fetchImpl(`http://127.0.0.1:${localPort}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${localPort}` },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : decoded,
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream') && response.body) {
      send({ id: request.id, stream: true, status: response.status, headers: { 'content-type': contentType } })
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        send({ id: request.id, chunk: Buffer.from(value).toString('base64'), bodyEncoding: 'base64' })
      }
      send({ id: request.id, end: true })
      return { id: request.id, end: true }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const frame: RelayFrame = {
      id: request.id,
      status: response.status,
      headers: { 'content-type': contentType },
      body: bytes.toString('base64'),
      bodyEncoding: 'base64',
    }
    send(frame)
    return frame
  } catch (error) {
    const frame: RelayFrame = { id: request.id, status: 502, headers: {}, body: Buffer.from(error instanceof Error ? error.message : String(error)).toString('base64'), bodyEncoding: 'base64' }
    send(frame)
    return frame
  }
}

const MOBILE_CSS = `/* narrow-width overlay: fixes occlusion via semantic selectors, stock tokens untouched */
@media (max-width: 720px){
  body{padding-bottom:env(safe-area-inset-bottom)}
  header{flex-wrap:wrap;row-gap:4px}
  header nav,header [role="toolbar"]{max-width:100%;overflow-x:auto;scrollbar-width:none}
  aside,[class*="drawer"],[class*="sidebar"]{max-width:88vw}
  main{padding-bottom:calc(72px + env(safe-area-inset-bottom))}
  [class*="floating"],[class*="fab"],button[class*="compose"]{bottom:calc(16px + env(safe-area-inset-bottom)) !important;z-index:60}
  [class*="toast"],[class*="popup"],[role="dialog"]{max-width:94vw;left:50%;transform:translateX(-50%)}
  [class*="tooltip"]{display:none}
}
`

interface MobileWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => void
  }): () => void
}

/**
 * Register the `/mobile/` overlay route and the outbound encrypted tunnel.
 * @param ctx - context carrying the web server seam.
 * @param config - server URL, local port, passphrase, and reconnect policy.
 */
export function apply(ctx: Context, config: MobileBridgeConfig): void {
  const state = {
    socket: undefined as WebSocket | undefined,
    connected: false,
    codes: new Map<string, string>(),
  }

  async function connect() {
    if (!config.serverUrl || !config.autoConnect) return
    try {
      const started = await fetch(`${config.serverUrl}/bridge/api/bridge/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then(response => response.json()) as { code: string }
      const secret = randomBytes(16).toString('hex')
      state.codes.set(started.code, secret)
      const qrPayload = encodeURIComponent(JSON.stringify({
        u: config.serverUrl, c: started.code, s: secret, k: config.userKey ?? '', b: started.code,
      }))
      console.log('[mobile-bridge] pairing code:', started.code)
      console.log('[mobile-bridge] phone QR url:', `${config.serverUrl}/bridge/#${qrPayload}`)
      const wsUrl = config.serverUrl.replace(/^http/, 'ws') + '/ws/bridge?code=' + started.code
      const socket = new WebSocket(wsUrl)
      state.socket = socket
      const key = await deriveKey(config.userKey ?? '', secret)
      socket.on('open', () => { state.connected = true })
      socket.on('message', raw => {
        void (async () => {
          const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
          if (wire.blob === undefined) return
          const request = await decryptJSON<RelayRequest>(key, wire.blob)
          await relayToLocalWeb({ ...request, id: wire.id }, config.localPort, frame => {
            void (async () => {
              if (frame.end) { socket.send(JSON.stringify({ id: frame.id, end: true })); return }
              if (frame.stream) { socket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(key, { stream: true, status: frame.status, headers: frame.headers }) })); return }
              if (frame.chunk !== undefined) { socket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(key, { d: frame.chunk }) })); return }
              socket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(key, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64' }) }))
            })()
          })
        })()
      })
      socket.on('close', () => {
        state.connected = false
        if (config.autoReconnect) setTimeout(() => void connect(), 5000)
      })
      socket.on('error', () => { socket.close() })
    } catch {
      if (config.autoReconnect) setTimeout(() => void connect(), 5000)
    }
  }

  ctx.effect(function* () {
    const web = (ctx as Context & { webServer: MobileWebServer }).webServer
    const dispose = web.register({
      kind: 'prefix',
      path: '/mobile/',
      handler: (_req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
        res.end(MOBILE_CSS)
      },
    })
    void connect()
    yield () => { state.socket?.close(); dispose() }
  }, 'dsh-mobile-bridge lifecycle')
}

export { base64ToBytes, bytesToBase64, decryptJSON, deriveKey, encryptJSON }
