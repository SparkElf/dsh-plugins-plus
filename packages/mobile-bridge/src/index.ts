/**
 * Mobile bridge plugin: dials OUT to the public bridge server, serves the
 * narrow-width overlay under `/mobile`, and answers the paired phone's
 * end-to-end encrypted relay frames against the local loopback web. The
 * pairing secret and optional user passphrase never leave the desktop except
 * inside the one-time QR payload; the server only forwards ciphertext.
 * @module @sparkelf/dsh-mobile-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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
  /** Optional owner email; when set with emailTwoFactor, scans need an inbox code. */
  ownerEmail: string
  emailTwoFactor: boolean
}

/** Settings namespace owning the mobile bridge section. */
export const MOBILE_BRIDGE_SETTINGS_NAMESPACE = settingsNamespace('mobile-bridge')

/** Schema for the settings section; secrets render masked. */
export const Config: z<MobileBridgeConfig> = z.object({
  serverUrl: z.string().default(''),
  localPort: z.number().step(1).min(1).default(3080),
  userKey: z.string().role('secret').default(''),
  autoConnect: z.boolean().default(true),
  autoReconnect: z.boolean().default(true),
  ownerEmail: z.string().default(''),
  emailTwoFactor: z.boolean().default(false),
})

/** Cordis 装配必须先提供 WebServer，插件才可注册移动端路由。 */
export const inject = ['webServer']

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

/** 注册 `/mobile` 路由并维护到公网桥接服务的出站加密连接。 */
export function apply(ctx: Context, config: MobileBridgeConfig): void {
  let current: () => MobileBridgeConfig = () => config
  let restartConnection = (): void => {}
  installSettingsSection(ctx, MOBILE_BRIDGE_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: () => { restartConnection() },
  })
  const state = {
    socket: undefined as WebSocket | undefined,
    connected: false,
    restartRequested: false,
    lastQrUrl: '',
  }
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleConnect = (delayMs: number): void => {
    if (disposed) return
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void connect()
    }, delayMs)
  }

  async function connect(): Promise<void> {
    if (disposed) return
    const live = current()
    if (!live.serverUrl || !live.autoConnect) return
    try {
      const started = await fetch(`${live.serverUrl}/bridge/api/bridge/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...live.emailTwoFactor && live.ownerEmail ? { email2fa: live.ownerEmail } : {} }),
      }).then(response => response.json()) as { code: string }
      const secret = randomBytes(16).toString('hex')
      // With a passphrase set, k stays out of the QR: the phone must type it,
      // turning the scan into possession plus knowledge (two factors).
      const qrPayload = encodeURIComponent(JSON.stringify({
        u: live.serverUrl, c: started.code, s: secret, ...(live.userKey ? {} : { k: '' }), b: started.code,
      }))
      const qrUrl = `${live.serverUrl}/bridge/#${qrPayload}`
      state.lastQrUrl = qrUrl
      const wsUrl = live.serverUrl.replace(/^http/, 'ws') + '/ws/bridge?code=' + started.code
      const socket = new WebSocket(wsUrl)
      state.socket = socket
      const key = await deriveKey(live.userKey ?? '', secret)
      socket.on('open', () => { state.connected = true })
      socket.on('message', raw => {
        void (async () => {
          const wire = JSON.parse(String(raw)) as { id: string; blob?: string }
          if (wire.blob === undefined) return
          const request = await decryptJSON<RelayRequest>(key, wire.blob)
          await relayToLocalWeb({ ...request, id: wire.id }, live.localPort, frame => {
            void (async () => {
              if (frame.end) { socket.send(JSON.stringify({ id: frame.id, end: true })); return }
              if (frame.stream) { socket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(key, { stream: true, status: frame.status, headers: frame.headers }) })); return }
              if (frame.chunk !== undefined) { socket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(key, { d: frame.chunk }) })); return }
              socket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(key, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64' }) }))
            })().catch(error => { console.error('[dsh-mobile-bridge] relay frame failed', error) })
          })
        })().catch(error => { console.error('[dsh-mobile-bridge] relay request failed', error) })
      })
      socket.on('close', () => {
        if (state.socket === socket) state.socket = undefined
        state.connected = false
        const restartNow = state.restartRequested
        state.restartRequested = false
        if (restartNow || current().autoReconnect) scheduleConnect(restartNow ? 0 : 5000)
      })
      socket.on('error', error => {
        console.error('[dsh-mobile-bridge] websocket failed', error)
        socket.close()
      })
    } catch (error) {
      console.error('[dsh-mobile-bridge] connection failed', error)
      if (current().autoReconnect) scheduleConnect(5000)
    }
  }

  restartConnection = () => {
    if (state.socket === undefined) {
      scheduleConnect(0)
      return
    }
    state.restartRequested = true
    state.socket.close()
  }

  ctx.effect(function* () {
    const web = (ctx as Context & { webServer: MobileWebServer }).webServer
    const dispose = web.register({
      kind: 'prefix',
      path: '/mobile',
      handler: (req: unknown, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => {
        const path = String((req as { url?: string }).url ?? '/mobile/')
        if (path.startsWith('/mobile/bridge/status')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ connected: state.connected, serverUrl: current().serverUrl, qrUrl: state.lastQrUrl }))
          return
        }
        if (path.startsWith('/mobile/bridge/style.css')) {
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
          res.end(MOBILE_CSS)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      },
    })
    void connect()
    yield () => {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      state.socket?.close()
      dispose()
    }
  }, 'dsh-mobile-bridge lifecycle')
}

export { base64ToBytes, bytesToBase64, decryptJSON, deriveKey, encryptJSON }
