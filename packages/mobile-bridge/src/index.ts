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

const DEFAULT_SERVER_URL = 'https://www.tokensfree.eu.cc'
const DOM_DIAGNOSTICS_MARKER_HEADER = 'x-dsh-mobile-bridge-diagnostics'
const DOM_DIAGNOSTICS_DEVICE_HEADER = 'x-dsh-mobile-bridge-device'
const DOM_DIAGNOSTICS_MAX_BYTES = 128 * 1024
const DOM_DIAGNOSTICS_MAX_ELEMENTS = 96

/** 服务器配置只保存中继基址；手机入口路径由插件统一追加。 */
function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/bridge') ? trimmed.slice(0, -'/bridge'.length) : trimmed
}

/** 在Host唯一配置边界归一化历史设置，避免连接请求重复追加 `/bridge`。 */
function normalizeConfig(value: MobileBridgeConfig): MobileBridgeConfig {
  return { ...value, serverUrl: normalizeServerUrl(value.serverUrl) }
}

/** Plugin row config rendered by the stock settings page. */
export interface MobileBridgeConfig {
  serverUrl: string
  localPort: number
  /** Optional user passphrase mixed into every session key. */
  userKey: string
  autoConnect: boolean
  autoReconnect: boolean
  /** Opt-in remote phone geometry capture for local UI diagnosis. */
  domDiagnostics: boolean
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
  serverUrl: z.string().default(DEFAULT_SERVER_URL),
  localPort: z.number().step(1).min(1).default(3080),
  userKey: z.string().role('secret').default(''),
  autoConnect: z.boolean().default(true),
  autoReconnect: z.boolean().default(true),
  domDiagnostics: z.boolean().default(false),
  ownerEmail: z.string().default(''),
  emailTwoFactor: z.boolean().default(false),
  sessionDays: z.number().step(1).min(1).max(365).default(7),
  bridgeId: z.string().role('secret').default(''),
  bridgeToken: z.string().role('secret').default(''),
  bridgeSecret: z.string().role('secret').default(''),
})

/** 诊断开关不改变中继连接参数，切换时不应重建手机隧道。 */
function sameConnectionConfig(left: MobileBridgeConfig, right: MobileBridgeConfig): boolean {
  return left.serverUrl === right.serverUrl
    && left.localPort === right.localPort
    && left.userKey === right.userKey
    && left.autoConnect === right.autoConnect
    && left.autoReconnect === right.autoReconnect
    && left.ownerEmail === right.ownerEmail
    && left.emailTwoFactor === right.emailTwoFactor
    && left.sessionDays === right.sessionDays
    && left.bridgeId === right.bridgeId
    && left.bridgeToken === right.bridgeToken
    && left.bridgeSecret === right.bridgeSecret
}

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
 * @param relayHeaders - Host-only headers proving the request traversed a paired phone tunnel.
 * @returns resolves when the local response completes.
 */
export async function relayToLocalWeb(
  request: RelayRequest,
  localPort: number,
  send: (frame: RelayFrame) => void = () => {},
  fetchImpl: typeof fetch = fetch,
  relayHeaders: Record<string, string> = {},
): Promise<RelayFrame> {
  try {
    const decoded = request.bodyEncoding === 'base64' ? Buffer.from(request.body, 'base64') : Buffer.from(request.body, 'utf8')
    const response = await fetchImpl(`http://127.0.0.1:${localPort}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, ...relayHeaders, host: `127.0.0.1:${localPort}` },
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

interface MobileDomDiagnosticRect {
  x: number
  y: number
  width: number
  height: number
}

interface MobileDomDiagnosticElement {
  locator: string
  tag: string
  role: string
  label: string
  classes: string[]
  dataAttributes: string[]
  rect: MobileDomDiagnosticRect
  styles: Record<string, string>
}

interface MobileDomDiagnosticSnapshotPayload {
  path: string
  viewport: { width: number; height: number; dpr: number }
  elements: MobileDomDiagnosticElement[]
}

interface MobileDomDiagnosticSnapshot extends MobileDomDiagnosticSnapshotPayload {
  deviceId: string
  capturedAt: number
}

interface MobileDomDiagnosticSummary {
  deviceId: string
  capturedAt: number
  viewport: MobileDomDiagnosticSnapshotPayload['viewport']
  elementCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`mobile DOM diagnostics: ${field} must be a finite number`)
  return value
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`mobile DOM diagnostics: ${field} must be a string no longer than ${maxLength}`)
  return value
}

function readStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`mobile DOM diagnostics: ${field} must contain at most ${maxItems} strings`)
  return value.map((item, index) => readBoundedString(item, `${field}[${index}]`, maxLength))
}

/** 在Host唯一不可信JSON入口校验有界几何快照；下游只消费该函数返回的字段。 */
function parseMobileDomDiagnosticSnapshot(raw: string, deviceId: string): MobileDomDiagnosticSnapshot {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || !isRecord(value.viewport) || !Array.isArray(value.elements) || value.elements.length > DOM_DIAGNOSTICS_MAX_ELEMENTS) {
    throw new Error('mobile DOM diagnostics: invalid snapshot')
  }
  const elements = value.elements.map((entry, index): MobileDomDiagnosticElement => {
    if (!isRecord(entry) || !isRecord(entry.rect) || !isRecord(entry.styles)) throw new Error(`mobile DOM diagnostics: elements[${index}] is invalid`)
    const styleEntries = Object.entries(entry.styles)
    if (styleEntries.length > 20) throw new Error(`mobile DOM diagnostics: elements[${index}].styles has too many entries`)
    return {
      locator: readBoundedString(entry.locator, `elements[${index}].locator`, 240),
      tag: readBoundedString(entry.tag, `elements[${index}].tag`, 32),
      role: readBoundedString(entry.role, `elements[${index}].role`, 80),
      label: readBoundedString(entry.label, `elements[${index}].label`, 160),
      classes: readStringArray(entry.classes, `elements[${index}].classes`, 8, 120),
      dataAttributes: readStringArray(entry.dataAttributes, `elements[${index}].dataAttributes`, 12, 120),
      rect: {
        x: readFiniteNumber(entry.rect.x, `elements[${index}].rect.x`),
        y: readFiniteNumber(entry.rect.y, `elements[${index}].rect.y`),
        width: readFiniteNumber(entry.rect.width, `elements[${index}].rect.width`),
        height: readFiniteNumber(entry.rect.height, `elements[${index}].rect.height`),
      },
      styles: Object.fromEntries(styleEntries.map(([key, item]) => [
        readBoundedString(key, `elements[${index}].styles key`, 64),
        readBoundedString(item, `elements[${index}].styles.${key}`, 160),
      ])),
    }
  })
  return {
    deviceId,
    capturedAt: Date.now(),
    path: readBoundedString(value.path, 'path', 2048),
    viewport: {
      width: readFiniteNumber(value.viewport.width, 'viewport.width'),
      height: readFiniteNumber(value.viewport.height, 'viewport.height'),
      dpr: readFiniteNumber(value.viewport.dpr, 'viewport.dpr'),
    },
    elements,
  }
}

const PAIRING_ROTATE_LEAD_MS = 60_000
const PAIRING_ROTATE_RETRY_MS = 5_000
const BRIDGE_HEARTBEAT_MS = 30_000

interface MobileRequest {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: 'close', listener: () => void): void
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
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
  pairingRefreshing: boolean
  devices: MobileBridgeDevice[]
  domDiagnosticsEnabled: boolean
  domDiagnostics: MobileDomDiagnosticSummary[]
}

/** Register local routes and maintain the stable outbound encrypted bridge. */
export function apply(ctx: Context, config: MobileBridgeConfig): void {
  const diagnosticsMarker = randomBytes(32).toString('hex')
  let current: () => MobileBridgeConfig = () => normalizeConfig(config)
  let lastConnectionConfig = current()
  let connectionRequested = current().autoConnect
  // 用户动作和设置提交都可能终止一次尚未完成的取票请求；代次只用于丢弃这次旧尝试。
  let connectionGeneration = 0
  let reconnectImmediately = false
  let restartConnection = (): void => {}
  let handleSettingsChange = (): void => { restartConnection() }
  let connectNow = (): MobileBridgeStatusView => statusView()
  let disconnectNow = (): MobileBridgeStatusView => statusView()
  installSettingsSection(ctx, MOBILE_BRIDGE_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => {
      current = () => normalizeConfig(source())
      lastConnectionConfig = current()
    },
    onChange: () => { handleSettingsChange() },
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
    pairing: undefined as PairingTicket | undefined,
    lastQrUrl: '',
    pairingRefreshing: false,
    devices: [] as MobileBridgeDevice[],
    domDiagnostics: new Map<string, MobileDomDiagnosticSnapshot>(),
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
    pairingRefreshing: state.pairingRefreshing,
    devices: state.devices,
    domDiagnosticsEnabled: current().domDiagnostics,
    domDiagnostics: [...state.domDiagnostics.values()].map(snapshot => ({
      deviceId: snapshot.deviceId,
      capturedAt: snapshot.capturedAt,
      viewport: snapshot.viewport,
      elementCount: snapshot.elements.length,
    })),
  })

  const emitStatus = (): void => {
    const event = 'data: ' + JSON.stringify(statusView()) + '\n\n'
    for (const stream of statusStreams) stream.write(event)
  }

  handleSettingsChange = (): void => {
    const next = current()
    const connectionChanged = !sameConnectionConfig(lastConnectionConfig, next)
    lastConnectionConfig = next
    if (!next.domDiagnostics) state.domDiagnostics.clear()
    emitStatus()
    if (connectionChanged) restartConnection()
  }

  const retainDiagnosticsForDevices = (): void => {
    const retained = new Set(state.devices.map(device => device.id))
    for (const deviceId of state.domDiagnostics.keys()) {
      if (!retained.has(deviceId)) state.domDiagnostics.delete(deviceId)
    }
  }

  const scheduleConnect = (delayMs: number): void => {
    if (disposed || !connectionRequested) return
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

  /** 清理桌面连接及其派生状态；主动断开和Socket关闭共用这一状态投影。 */
  const clearConnectionState = (): void => {
    state.socket = undefined
    state.connected = false
    state.pairing = undefined
    state.lastQrUrl = ''
    state.pairingRefreshing = false
    state.devices = state.devices.map(device => ({ ...device, online: false }))
    for (const local of localSockets.values()) local.close(1012, 'bridge offline')
    localSockets.clear()
    clearPairingTimer()
    emitStatus()
  }

  const schedulePairingRotation = (delayMs: number): void => {
    if (disposed) return
    clearPairingTimer()
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
    retainDiagnosticsForDevices()
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
    retainDiagnosticsForDevices()
    emitStatus()
    return statusView()
  }

  // 配对票据只负责新设备准入；请求期间隐藏旧票据并发布刷新进度，轮换不得改变稳定桌面身份或现有设备密钥。
  async function rotatePairing(): Promise<void> {
    const pairing = state.pairing
    const socket = state.socket
    if (disposed || pairing === undefined || socket === undefined || socket.readyState !== WebSocket.OPEN) return
    state.pairingRefreshing = true
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
      state.pairingRefreshing = false
      schedulePairingRotation(Math.max(0, next.expiresAt - Date.now() - PAIRING_ROTATE_LEAD_MS))
    } catch (error) {
      console.error('[dsh-mobile-bridge] pairing rotation failed', error)
      if (state.pairing !== pairing) return
      if (Date.now() >= pairing.expiresAt) {
        reconnectImmediately = true
        socket.close()
        return
      }
      state.pairingRefreshing = false
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

  // 连接动作复用持久化身份；取票和Socket建立期间只更新状态，不阻塞设置保存。
  async function connect(): Promise<void> {
    if (disposed || !connectionRequested || state.socket !== undefined) return
    const generation = connectionGeneration
    const live = current()
    if (!live.serverUrl || !live.bridgeId || !live.bridgeToken || !live.bridgeSecret) return
    state.pairingRefreshing = true
    emitStatus()
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
      if (generation !== connectionGeneration || !connectionRequested) return
      state.pairing = started
      state.lastQrUrl = ''
      const key = await deriveKey(live.userKey, live.bridgeSecret)
      if (generation !== connectionGeneration || !connectionRequested) return
      const wsUrl = live.serverUrl.replace(/^http/u, 'ws') + '/ws/bridge?bridgeId=' + encodeURIComponent(live.bridgeId)
      const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer ' + started.refreshToken } })
      let heartbeat: ReturnType<typeof setInterval> | undefined
      state.socket = socket
      socket.on('open', () => {
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.ping()
        }, BRIDGE_HEARTBEAT_MS)
        state.connected = true
        state.lastQrUrl = pairingUrl(live.serverUrl, started.code, live.bridgeSecret, live.userKey)
        state.pairingRefreshing = false
        schedulePairingRotation(Math.max(0, started.expiresAt - Date.now() - PAIRING_ROTATE_LEAD_MS))
        void loadDevices().catch(error => { console.error('[dsh-mobile-bridge] device list refresh failed', error) })
      })
      socket.on('message', raw => {
        void (async () => {
          const wire = JSON.parse(String(raw)) as { id?: unknown; blob?: unknown; control?: unknown; devices?: unknown }
          if (wire.control === 'paired' || wire.control === 'devices') {
            if (!Array.isArray(wire.devices)) throw new Error('device control frame is missing devices')
            state.devices = wire.devices as MobileBridgeDevice[]
            retainDiagnosticsForDevices()
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
          const separator = wire.id.indexOf(':')
          const deviceId = separator === -1 ? '' : wire.id.slice(0, separator)
          const diagnosticsHeaders: Record<string, string> = {}
          if (deviceId !== '') {
            diagnosticsHeaders[DOM_DIAGNOSTICS_MARKER_HEADER] = diagnosticsMarker
            diagnosticsHeaders[DOM_DIAGNOSTICS_DEVICE_HEADER] = deviceId
          }
          await relayToLocalWeb({ ...request, id: wire.id }, live.localPort, frame => {
            void (async () => {
              if (frame.end) { socket.send(JSON.stringify({ id: frame.id, end: true })); return }
              if (frame.stream) { socket.send(JSON.stringify({ id: frame.id, stream: true, blob: await encryptJSON(key, { stream: true, status: frame.status, headers: frame.headers }) })); return }
              if (frame.chunk !== undefined) { socket.send(JSON.stringify({ id: frame.id, chunk: await encryptJSON(key, { d: frame.chunk }) })); return }
              socket.send(JSON.stringify({ id: frame.id, blob: await encryptJSON(key, { status: frame.status, headers: frame.headers, body: frame.body, bodyEncoding: 'base64', compression: frame.compression }) }))
            })().catch(error => { console.error('[dsh-mobile-bridge] relay frame failed', error) })
          }, fetch, diagnosticsHeaders)
        })().catch(error => { console.error('[dsh-mobile-bridge] relay request failed', error) })
      })
      socket.on('close', (code, reason) => {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        const reasonText = reason.toString('utf8')
        console.info('[dsh-mobile-bridge] bridge websocket closed', { code, reason: reasonText })
        if (state.socket !== socket) return
        const immediate = reconnectImmediately
        reconnectImmediately = false
        clearConnectionState()
        // 4001 表示同一持久化桌面身份已被另一实例接管；当前实例重连只会让两端互相下线。
        const displaced = code === 4001 && reasonText === 'desktop reconnected'
        if (!displaced && connectionRequested && (immediate || current().autoReconnect)) scheduleConnect(immediate ? 0 : 5000)
      })
      socket.on('error', error => {
        console.error('[dsh-mobile-bridge] websocket failed', error)
        socket.close()
      })
    } catch (error) {
      if (generation !== connectionGeneration || !connectionRequested) return
      console.error('[dsh-mobile-bridge] connection failed', error)
      const socket = state.socket
      clearConnectionState()
      socket?.close()
      if (current().autoReconnect) scheduleConnect(5000)
    }
  }

  /** 设置提交后按启动策略重建唯一桌面连接。 */
  restartConnection = () => {
    connectionGeneration += 1
    connectionRequested = current().autoConnect
    reconnectImmediately = false
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    const socket = state.socket
    clearConnectionState()
    socket?.close()
    if (connectionRequested) scheduleConnect(0)
  }

  /** 用户明确要求连接时启动一次连接尝试，不修改自动重连策略。 */
  connectNow = () => {
    connectionRequested = true
    if (state.connected || state.socket !== undefined) return statusView()
    connectionGeneration += 1
    scheduleConnect(0)
    return statusView()
  }

  /** 用户明确断开时取消重试并关闭当前Socket。 */
  disconnectNow = () => {
    connectionRequested = false
    connectionGeneration += 1
    reconnectImmediately = false
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    const socket = state.socket
    clearConnectionState()
    socket?.close()
    return statusView()
  }

  const headerValue = (req: MobileRequest, name: string): string => {
    const value = req.headers?.[name]
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  }

  const isDiagnosticRelay = (req: MobileRequest): boolean =>
    headerValue(req, DOM_DIAGNOSTICS_MARKER_HEADER) === diagnosticsMarker

  const diagnosticDeviceId = (req: MobileRequest): string | null => {
    if (!isDiagnosticRelay(req)) return null
    const deviceId = headerValue(req, DOM_DIAGNOSTICS_DEVICE_HEADER)
    return deviceId === '' ? null : deviceId
  }

  /** 在paired relay入口限制body字节数，避免debug开关扩大手机请求的内存占用。 */
  const readDiagnosticBody = async (req: MobileRequest): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      size += buffer.length
      if (size > DOM_DIAGNOSTICS_MAX_BYTES) throw new Error('mobile DOM diagnostics: payload too large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  ctx.effect(function* () {
    const web = (ctx as Context & { webServer: MobileWebServer }).webServer
    const dispose = web.register({
      kind: 'prefix',
      path: '/mobile',
      handler: (req, res) => {
        const path = String(req.url ?? '/mobile/')
        const routePath = path.split('?')[0]
        if (req.method === 'GET' && routePath === '/mobile/bridge/diagnostics/capability') {
          const deviceId = diagnosticDeviceId(req)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ mobile: deviceId !== null, enabled: deviceId !== null && current().domDiagnostics }))
          return
        }
        if (routePath === '/mobile/bridge/diagnostics') {
          const deviceId = diagnosticDeviceId(req)
          if (req.method === 'POST') {
            if (deviceId === null) {
              res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'paired mobile diagnostics are required' }))
              return
            }
            if (!current().domDiagnostics) {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ stored: false }))
              return
            }
            void readDiagnosticBody(req).then(body => {
              state.domDiagnostics.set(deviceId, parseMobileDomDiagnosticSnapshot(body, deviceId))
              emitStatus()
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ stored: true }))
            }).catch(error => {
              console.error('[dsh-mobile-bridge] mobile DOM diagnostic capture failed', error)
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            })
            return
          }
          if (isDiagnosticRelay(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'diagnostic snapshots are available only to the local Harness' }))
            return
          }
          if (req.method === 'DELETE') {
            state.domDiagnostics.clear()
            emitStatus()
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ enabled: current().domDiagnostics, snapshots: [...state.domDiagnostics.values()] }))
            return
          }
          res.writeHead(405, { allow: 'GET, DELETE, POST' })
          res.end()
          return
        }
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
        if (req.method === 'POST' && path === '/mobile/bridge/connect') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(connectNow()))
          return
        }
        if (req.method === 'POST' && path === '/mobile/bridge/disconnect') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(disconnectNow()))
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
    connectionRequested = current().autoConnect
    if (connectionRequested) void connect()
    yield () => {
      disposed = true
      connectionRequested = false
      connectionGeneration += 1
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      clearPairingTimer()
      state.socket?.close()
      for (const local of localSockets.values()) local.close(1001, 'bridge disposed')
      localSockets.clear()
      for (const stream of statusStreams) stream.end()
      statusStreams.clear()
      state.domDiagnostics.clear()
      dispose()
    }
  }, 'dsh-mobile-bridge lifecycle')
}

export { base64ToBytes, bytesToBase64, decryptJSON, deriveKey, encryptJSON }
