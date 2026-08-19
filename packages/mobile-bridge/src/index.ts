/**
 * Mobile bridge plugin: dials OUT to the public bridge server with a pairing
 * code, relays the paired mobile client's HTTP requests to the local Harness
 * web loopback, and serves the mobile overlay plus status under `/mobile/`.
 * Outbound-only keeps home networks free of inbound ports and NAT rules.
 * @module @sparkelf/dsh-mobile-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'

/** Plugin row config. */
export interface MobileBridgeConfig {
  serverUrl: string
  secret: string
  localPort: number
}

/** Minimal web-server seam used by this plugin. */
interface MobileWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => void
  }): () => void
}

/** One relayed request from the bridge server. */
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

const TEXTUAL = /^(text\/|application\/(json|.*\+json))/

/** One outbound relay message (head, chunk, or end frame). */
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

/**
 * Handle one relayed request against the local loopback web, binary-safe and
 * stream-aware: event-stream responses (the stock web's SSE mux) flow as
 * head/chunk/end frames so live updates reach the phone; everything else
 * returns one base64-safe frame.
 * @param request - relayed request.
 * @param localPort - local Harness web port.
 * @param send - outbound frame sink (the bridge socket).
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
      send({ id: request.id, status: response.status, headers: { 'content-type': contentType }, stream: true })
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
    const textual = TEXTUAL.test(contentType)
    const frame: RelayFrame = {
      id: request.id,
      status: response.status,
      headers: { 'content-type': contentType },
      body: textual ? bytes.toString('utf8') : bytes.toString('base64'),
      bodyEncoding: textual ? 'text' : 'base64',
    }
    send(frame)
    return frame
  } catch (error) {
    const frame: RelayFrame = { id: request.id, status: 502, headers: {}, body: error instanceof Error ? error.message : String(error), bodyEncoding: 'text' }
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

/**
 * Register the `/mobile/` routes and the outbound bridge tunnel.
 * @param ctx - context carrying the web server seam.
 * @param config - server URL, bridge secret, and local web port.
 */
export function apply(ctx: Context, config: MobileBridgeConfig): void {
  const state = { code: '', socket: undefined as WebSocket | undefined, connected: false }

  async function connect() {
    if (!config.serverUrl) return
    try {
      if (!state.code) {
        const started = await fetch(`${config.serverUrl}/bridge/api/bridge/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: config.secret }),
        }).then(response => response.json()) as { code: string }
        state.code = started.code
        console.log('[mobile-bridge] pairing code:', state.code)
      }
      const wsUrl = config.serverUrl.replace(/^http/, 'ws') + '/ws/bridge?code=' + state.code
      const socket = new WebSocket(wsUrl)
      state.socket = socket
      socket.on('open', () => { state.connected = true })
      socket.on('message', raw => {
        void (async () => {
          const request = JSON.parse(String(raw)) as RelayRequest
          await relayToLocalWeb(request, config.localPort, frame => socket.send(JSON.stringify(frame)))
        })()
      })
      socket.on('close', () => { state.connected = false; setTimeout(() => void connect(), 5000) })
      socket.on('error', () => { socket.close() })
    } catch {
      setTimeout(() => void connect(), 5000)
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
