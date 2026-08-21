/** Browser half: mobile stylesheet lifecycle plus the first-class Settings section. */

import type {} from './contract.ts'
import { MobileBridgeSection } from './MobileBridgeSection.tsx'
import { RevokedDeviceModal } from './RevokedDeviceModal.tsx'
import type { MobileBridgeSectionInjected, MobileBridgeStatus, MobileBridgeValues } from './MobileBridgeSection.tsx'
import type { MobileBridgeClientContext } from './context.ts'
import { en, zh } from './locales.ts'

const LOCALE_NS = 'settingsMobileBridge' as const
const SETTINGS_NS = 'mobile-bridge'
const DEFAULT_SERVER_URL = 'https://www.tokensfree.eu.cc'

/** 浏览器保存前把历史 `/bridge` 输入收敛为Host使用的中继基址。 */
function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/bridge') ? trimmed.slice(0, -'/bridge'.length) : trimmed
}

interface SettingsDescription {
  namespaces: Array<{ ns: string; value: MobileBridgeValues }>
}

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

interface RpcResponse<T> {
  result: RpcResult<T>
}

/** Execute one typed Host RPC over the public browser carrier. */
async function rpc<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`)
  const body = await response.json() as RpcResponse<T>
  if (!body.result.ok) throw new Error(body.result.error.message)
  return body.result.value
}

/** Services required by the browser plugin fiber. */
export const inject = ['slots', 'locale']

/** Register all browser contributions owned by Mobile Bridge. */
export function apply(ctx: MobileBridgeClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-mobile-bridge: dictionaries')

  ctx.effect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/mobile/bridge/style.css'
    link.dataset.plugin = '@sparkelf/dsh-mobile-bridge'
    document.head.appendChild(link)
    return () => { link.remove() }
  }, 'dsh-mobile-bridge: narrow-screen stylesheet')

  const operations: MobileBridgeSectionInjected = {
    loadValues: async () => {
      const value = await rpc<SettingsDescription>('settings.describe', {})
      const row = value.namespaces.find(candidate => candidate.ns === SETTINGS_NS)
      if (row === undefined) throw new Error('mobile-bridge settings namespace is unavailable')
      return {
        serverUrl: normalizeServerUrl(row.value.serverUrl),
        localPort: row.value.localPort,
        userKey: row.value.userKey,
        ownerEmail: row.value.ownerEmail,
        emailTwoFactor: row.value.emailTwoFactor,
        sessionDays: row.value.sessionDays,
        autoConnect: row.value.autoConnect,
        autoReconnect: row.value.autoReconnect,
      }
    },
    saveValues: async values => {
      await rpc('settings.update', {
        ns: SETTINGS_NS,
        patch: { ...values, serverUrl: normalizeServerUrl(values.serverUrl) },
      })
    },
    loadStatus: async () => {
      const response = await fetch('/mobile/bridge/status')
      if (!response.ok) throw new Error(`Mobile Bridge status failed with HTTP ${response.status}`)
      return await response.json() as MobileBridgeStatus
    },
    subscribeStatus: listener => {
      const source = new EventSource('/mobile/bridge/events')
      source.onmessage = event => {
        try {
          listener(JSON.parse(event.data) as MobileBridgeStatus)
        } catch (error) {
          console.error('[dsh-mobile-bridge] live status event failed', error)
        }
      }
      return () => { source.close() }
    },
    disconnectDevice: async deviceId => {
      const response = await fetch('/mobile/bridge/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' })
      if (!response.ok) throw new Error(`Mobile Bridge device disconnect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
    connectNow: async () => {
      const response = await fetch('/mobile/bridge/connect', { method: 'POST' })
      if (!response.ok) throw new Error(`Mobile Bridge connect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
    disconnectNow: async () => {
      const response = await fetch('/mobile/bridge/disconnect', { method: 'POST' })
      if (!response.ok) throw new Error(`Mobile Bridge disconnect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-bridge-revoked',
    order: 100,
    locale: LOCALE_NS,
  }, RevokedDeviceModal))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 40,
    label: () => ctx.locale.bind(LOCALE_NS)('nav'),
    locale: LOCALE_NS,
    inject: () => operations,
  }, MobileBridgeSection))
}
