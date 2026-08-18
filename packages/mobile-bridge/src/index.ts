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
}

/**
 * Handle one relayed request against the local loopback web.
 * @param request - relayed request.
 * @param localPort - local Harness web port.
 * @param fetchImpl - fetch seam for tests.
 * @returns the relay response.
 */
export async function relayToLocalWeb(
  request: RelayRequest,
  localPort: number,
  fetchImpl: typeof fetch = fetch,
) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${localPort}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${localPort}` },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    })
    return {
      id: request.id,
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? '' },
      body: await response.text(),
    }
  } catch (error) {
    return { id: request.id, status: 502, headers: {}, body: error instanceof Error ? error.message : String(error) }
  }
}

const MOBILE_CSS = `/* narrow-width overlay: fixes occlusion without touching stock styles */
@media (max-width: 720px){
  body{padding-bottom:env(safe-area-inset-bottom)}
  [class*="floating"],[class*="fab"]{bottom:calc(16px + env(safe-area-inset-bottom)) !important}
  header{flex-wrap:wrap;row-gap:4px}
  [class*="drawer"],[class*="sidebar"]{max-width:88vw}
  [class*="toast"],[class*="popup"]{max-width:94vw;left:50%;transform:translateX(-50%)}
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
        const started = await fetch(`${config.serverUrl}/api/bridge/start`, {
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
          socket.send(JSON.stringify(await relayToLocalWeb(request, config.localPort)))
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
