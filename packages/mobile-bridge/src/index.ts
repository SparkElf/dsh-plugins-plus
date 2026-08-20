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
import SettingsProvider, { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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
  /** Days a paired phone remains signed in after its browser closes. */
  sessionDays: number
  /** Stable desktop identity persisted inside this plugin's Settings namespace. */
  bridgeId: string
  /** Desktop credential used only for authenticated bridge and device operations. */
  bridgeToken: string
  /** Stable E2EE secret shared only through pairing QR payloads. */
  bridgeSecret: string
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
  sessionDays: z.number().step(1).min(1).max(365).default(7),
  bridgeId: z.string().role('secret').default(''),
  bridgeToken: z.string().role('secret').default(''),
  bridgeSecret: z.string().role('secret').default(''),
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

interface RelaySocketOpenRequest {
  kind: 'websocket-open'
  path: string
  protocols: string[]
}

interface RelaySocketMessageRequest {
  kind: 'websocket-message'
  data: string
  binary: boolean
}

interface RelaySocketCloseRequest {
  kind: 'websocket-close'
  code: number
  reason: string
}

type IncomingRelayRequest = Omit<RelayRequest, 'id'> | RelaySocketOpenRequest | RelaySocketMessageRequest | RelaySocketCloseRequest

/** One outbound relay frame before encryption. */
export interface RelayFrame {
  id: string
  status?: number
  headers?: Record<string, string>
  stream?: boolean
  chunk?: string
  bodyEncoding?: 'text' | 'base64'
  compression?: 'gzip'
  end?: boolean
  body?: string
}

const TEXTUAL = /^(text\/|application\/(javascript|json|.*\+json))/

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
    const compressed = TEXTUAL.test(contentType)
    const body = compressed ? gzipSync(bytes) : bytes
    const frame: RelayFrame = {
      id: request.id,
      status: response.status,
      headers: { 'content-type': contentType },
      body: body.toString('base64'),
      bodyEncoding: 'base64',
      ...(compressed ? { compression: 'gzip' as const } : {}),
    }
    send(frame)
    return frame
  } catch (error) {
    console.error('[dsh-mobile-bridge] local HTTP relay failed', error)
    const frame: RelayFrame = { id: request.id, status: 502, headers: {}, body: Buffer.from(error instanceof Error ? error.message : String(error)).toString('base64'), bodyEncoding: 'base64' }
    send(frame)
    return frame
  }
}

interface PairingTicket {
  code: string
  refreshToken: string
  expiresAt: number
}

/** One phone paired to this desktop bridge. */
export interface MobileBridgeDevice {
  id: string
  bridgeId: string
  name: string
  ip: string
  pairedAt: number
  lastSeenAt: number
  online: boolean
}

const PAIRING_ROTATE_LEAD_MS = 60_000
const PAIRING_ROTATE_RETRY_MS = 5_000

interface MobileRequest {
  url?: string
  method?: string
  on(event: 'close', listener: () => void): void
}

interface MobileResponse {
  writeHead(code: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(body?: string): void
}

interface MobileWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: MobileRequest, res: MobileResponse) => void
  }): () => void
}

interface MobileBridgeStatusView {
  connected: boolean
  serverUrl: string
  qrUrl: string
  pairingCode: string
  qrRefreshAt: number
  devices: MobileBridgeDevice[]
}

/** Register local routes and maintain the stable outbound encrypted bridge. */
export function apply(ctx: Context, config: MobileBridgeConfig): void {
  let current: () => MobileBridgeConfig = () => config
  let restartConnection = (): void => {}
  installSettingsSection(ctx, MOBILE_BRIDGE_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: () => { restartConnection() },
  })
  ctx.inject(['settings'], settingsCtx => {
    const settings = (settingsCtx as Context & { settings: SettingsProvider }).settings
    const resolved = settings.get(MOBILE_BRIDGE_SETTINGS_NAMESPACE) as MobileBridgeConfig
    if (resolved.bridgeId !== '' && resolved.bridgeToken !== '' && resolved.bridgeSecret !== '') return
    void settings.update(MOBILE_BRIDGE_SETTINGS_NAMESPACE, {
      bridgeId: resolved.bridgeId || randomBytes(16).toString('hex'),
      bridgeToken: resolved.bridgeToken || randomBytes(32).toString('hex'),
      bridgeSecret: resolved.bridgeSecret || randomBytes(16).toString('hex'),
    }).catch((error: unknown) => { console.error('[dsh-mobile-bridge] identity persistence failed', error) })
  })

  const state = {
    socket: undefined as WebSocket | undefined,
    connected: false,
    restartRequested: false,
    pairing: undefined as PairingTicket | undefined,
    lastQrUrl: '',
    qrRefreshAt: 0,
    devices: [] as MobileBridgeDevice[],
  }
  const statusStreams = new Set<MobileResponse>()
  const localSockets = new Map<string, WebSocket>()
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let pairingTimer: ReturnType<typeof setTimeout> | undefined

  const statusView = (): MobileBridgeStatusView => ({
    connected: state.connected,
    serverUrl: current().serverUrl,
    qrUrl: state.lastQrUrl,
    pairingCode: state.pairing?.code ?? '',
    qrRefreshAt: state.qrRefreshAt,
    devices: state.devices,
  })

  const emitStatus = (): void => {
    const event = 'data: ' + JSON.stringify(statusView()) + '\n\n'
    for (const stream of statusStreams) stream.write(event)
  }

  const scheduleConnect = (delayMs: number): void => {
    if (disposed) return
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void connect()
    }, delayMs)
  }

  const clearPairingTimer = (): void => {
    if (pairingTimer === undefined) return
    clearTimeout(pairingTimer)
    pairingTimer = undefined
  }

  const schedulePairingRotation = (delayMs: number): void => {
    if (disposed) return
    clearPairingTimer()
    state.qrRefreshAt = Date.now() + delayMs
    emitStatus()
    pairingTimer = setTimeout(() => {
      pairingTimer = undefined
      void rotatePairing()
    }, delayMs)
  }

  const pairingUrl = (serverUrl: string, code: string, secret: string, userKey: string): string => {
    const payload = encodeURIComponent(JSON.stringify({ u: serverUrl, c: code, s: secret, ...(userKey ? {} : { k: '' }), b: code }))
    return serverUrl + '/bridge/#' + payload
  }

  const loadDevices = async (): Promise<void> => {
    const live = current()
    const response = await fetch(live.serverUrl + '/bridge/api/bridge/devices?bridgeId=' + encodeURIComponent(live.bridgeId), {
      headers: { authorization: 'Bearer ' + live.bridgeToken },
    })
    if (!response.ok) throw new Error('device list failed with ' + response.status + ': ' + await response.text())
    const body = await response.json() as { devices: MobileBridgeDevice[] }
    state.devices = body.devices
    emitStatus()
  }

  const disconnectDevice = async (deviceId: string): Promise<MobileBridgeStatusView> => {
    const live = current()
    const response = await fetch(live.serverUrl + '/bridge/api/bridge/devices/' + encodeURIComponent(deviceId) + '?bridgeId=' + encodeURIComponent(live.bridgeId), {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + live.bridgeToken },
    })
    if (!response.ok) throw new Error('device disconnect failed with ' + response.status + ': ' + await response.text())
    const body = await response.json() as { devices: MobileBridgeDevice[] }
    state.devices = body.devices
    emitStatus()
    return statusView()
  }

  // 配对票据只负责新设备准入；轮换不得改变稳定桌面身份或现有设备密钥。
  async function rotatePairing(): Promise<void> {
    const pairing = state.pairing
    const socket = state.socket
    if (disposed || pairing === undefined || socket === undefined || socket.readyState !== WebSocket.OPEN) return
    state.qrRefreshAt = Date.now() + PAIRING_ROTATE_RETRY_MS
    emitStatus()
    try {
      const live = current()
      const response = await fetch(live.serverUrl + '/bridge/api/bridge/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bridgeId: live.bridgeId, code: pairing.code, refreshToken: pairing.refreshToken }),
      })
      if (!response.ok) throw new Error('pairing rotation failed with ' + response.status + ': ' + await response.text())
      const next = await response.json() as PairingTicket
      if (state.pairing !== pairing) return
      state.pairing = next
      state.lastQrUrl = pairingUrl(live.serverUrl, next.code, live.bridgeSecret, live.userKey)
      schedulePairingRotation(Math.max(0, next.expiresAt - Date.now() - PAIRING_ROTATE_LEAD_MS))
    } catch (error) {
      console.error('[dsh-mobile-bridge] pairing rotation failed', error)
      if (state.pairing !== pairing) return
      if (Date.now() >= pairing.expiresAt) {
        state.restartRequested = true
        socket.close()
        return
      }
      schedulePairingRotation(PAIRING_ROTATE_RETRY_MS)
    }
  }

  const sendSocketEvent = async (desktop: WebSocket, key: CryptoKey, id: string, payload: Record<string, unknown>): Promise<void> => {
    desktop.send(JSON.stringify({ id, blob: await encryptJSON(key, payload) }))
  }

  // 应用 WebSocket 与 HTTP 共用同一 E2EE 桌面连接，外层 id 只承担设备路由。
  const relayApplicationSocket = (request: RelaySocketOpenRequest | RelaySocketMessageRequest | RelaySocketCloseRequest, id: string, localPort: number, desktop: WebSocket, key: CryptoKey): void => {
    if (request.kind === 'websocket-open') {
      if (!request.path.startsWith('/') || localSockets.has(id)) throw new Error('application websocket open frame is invalid')
      const local = new WebSocket('ws://127.0.0.1:' + localPort + request.path, request.protocols)
      localSockets.set(id, local)
      local.on('open', () => {
        console.info('[dsh-mobile-bridge] application websocket opened', { id, path: request.path })
        void sendSocketEvent(desktop, key, id, { kind: 'websocket-open', protocol: local.protocol }).catch(error => {
          console.error('[dsh-mobile-bridge] application websocket open response failed', error)
        })
      })
      local.on('message', (data, isBinary) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data)
        const payload = isBinary
          ? { kind: 'websocket-message', data: bytes.toString('base64'), binary: true }
          : { kind: 'websocket-message', data: bytes.toString('utf8'), binary: false }
        void sendSocketEvent(desktop, key, id, payload).catch(error => {
          console.error('[dsh-mobile-bridge] application websocket message response failed', error)
        })
      })
      local.on('close', (code, reason) => {
        console.info('[dsh-mobile-bridge] application websocket closed', { id, path: request.path, code, reason: reason.toString('utf8') })
        localSockets.delete(id)
        if (desktop.readyState !== WebSocket.OPEN) return
        void sendSocketEvent(desktop, key, id, { kind: 'websocket-close', code, reason: reason.toString('utf8') }).catch(error => {
          console.error('[dsh-mobile-bridge] application websocket close response failed', error)
        })
      })
      local.on('error', error => {
        console.error('[dsh-mobile-bridge] local application websocket failed', error)
        local.close()
      })
      return
    }
    const local = localSockets.get(id)
    if (local === undefined) throw new Error('application websocket is not open')
    if (request.kind === 'websocket-message') {
      local.send(request.binary ? Buffer.from(request.data, 'base64') : request.data)
      return
    }
    local.close(request.code, request.reason)
  }

  // 每次重连复用 Settings 持久化身份，并在同一连接上投影全部设备状态。
  async function connect(): Promise<void> {
    if (disposed) return
    const live = current()
    if (!live.serverUrl || !live.autoConnect || !live.bridgeId || !live.bridgeToken || !live.bridgeSecret) return
    try {
      const response = await fetch(live.serverUrl + '/bridge/api/bridge/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bridgeId: live.bridgeId,
          bridgeToken: live.bridgeToken,
          sessionDays: live.sessionDays,
          ...live.emailTwoFactor && live.ownerEmail ? { email2fa: live.ownerEmail } : {},
        }),
      })
      if (!response.ok) throw new Error('pairing start failed with ' + response.status + ': ' + await response.text())
      const started = await response.json() as PairingTicket
      state.pairing = started
      state.lastQrUrl = ''
      const key = await deriveKey(live.userKey, live.bridgeSecret)
      const wsUrl = live.serverUrl.replace(/^http/u, 'ws') + '/ws/bridge?bridgeId=' + encodeURIComponent(live.bridgeId)
      const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer ' + started.refreshToken } })
      state.socket = socket
      socket.on('open', () => {
        state.connected = true
        state.lastQrUrl = pairingUrl(live.serverUrl, started.code, live.bridgeSecret, live.userKey)
        schedulePairingRotation(Math.max(0, started.expiresAt - Date.now() - PAIRING_ROTATE_LEAD_MS))
        void loadDevices().catch(error => { console.error('[dsh-mobile-bridge] device list refresh failed', error) })
      })
      socket.on('message', raw => {
        void (async () => {
          const wire = JSON.parse(String(raw)) as { id?: unknown; blob?: unknown; control?: unknown; devices?: unknown }
          if (wire.control === 'paired' || wire.control === 'devices') {
            if (!Array.isArray(wire.devices)) throw new Error('device control frame is missing devices')
            state.devices = wire.devices as MobileBridgeDevice[]
            const onlineDevices = new Set(state.devices.filter(device => device.online).map(device => device.id))
            for (const [id, local] of localSockets) {
              const separator = id.indexOf(':')
              if (separator !== -1 && !onlineDevices.has(id.slice(0, separator))) local.close(1001, 'device offline')
            }
            emitStatus()
            if (wire.control === 'paired') void rotatePairing()
            return
          }
          if (typeof wire.id !== 'string' || typeof wire.blob !== 'string') throw new Error('relay request frame is invalid')
          const request = await decryptJSON<IncomingRelayRequest>(key, wire.blob)
          if (request.kind === 'websocket-open' || request.kind === 'websocket-message' || request.kind === 'websocket-close') {
            relayApplicationSocket(request, wire.id, live.localPort, socket, key)
            return
          }
          await relayToLocalWeb({ ...request, id: wire.id }, live.localPort, frame => {
            void (async () => {
              if (frame.end) { socket.send(JSON.stringify({ id: frame.id, end: true })); return }
              if (frame.stream) { socket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(key, { stream: true, status: frame.status, headers: frame.headers }) })); return }
              if (frame.chunk !== undefined) { socket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(key, { d: frame.chunk }) })); return }
              socket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(key, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64', compression: frame.compression }) }))
            })().catch(error => { console.error('[dsh-mobile-bridge] relay frame failed', error) })
          })
        })().catch(error => { console.error('[dsh-mobile-bridge] relay request failed', error) })
      })
      socket.on('close', () => {
        if (state.socket === socket) {
          state.socket = undefined
          state.connected = false
          state.pairing = undefined
          state.lastQrUrl = ''
          state.qrRefreshAt = 0
          state.devices = state.devices.map(device => ({ ...device, online: false }))
          for (const local of localSockets.values()) local.close(1012, 'bridge offline')
          localSockets.clear()
          clearPairingTimer()
          emitStatus()
        }
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
      clearPairingTimer()
      state.pairing = undefined
      state.lastQrUrl = ''
      state.qrRefreshAt = 0
      state.socket?.close()
      emitStatus()
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
      handler: (req, res) => {
        const path = String(req.url ?? '/mobile/')
        if (path.startsWith('/mobile/bridge/events')) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          statusStreams.add(res)
          res.write('data: ' + JSON.stringify(statusView()) + '\n\n')
          req.on('close', () => { statusStreams.delete(res) })
          return
        }
        if (path.startsWith('/mobile/bridge/status')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(statusView()))
          return
        }
        if (path.startsWith('/mobile/bridge/style.css')) {
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
          res.end('')
          return
        }
        if (req.method === 'DELETE' && path.startsWith('/mobile/bridge/devices/')) {
          const deviceId = decodeURIComponent(path.slice('/mobile/bridge/devices/'.length).split('?')[0])
          void disconnectDevice(deviceId).then(next => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(next))
          }).catch(error => {
            console.error('[dsh-mobile-bridge] device disconnect failed', error)
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          })
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
      clearPairingTimer()
      state.socket?.close()
      for (const local of localSockets.values()) local.close(1001, 'bridge disposed')
      localSockets.clear()
      for (const stream of statusStreams) stream.end()
      statusStreams.clear()
      dispose()
    }
  }, 'dsh-mobile-bridge lifecycle')
}

export { base64ToBytes, bytesToBase64, decryptJSON, deriveKey, encryptJSON }
