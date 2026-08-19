/**
 * Client half: narrow-width overlay for the stock web plus a first-class
 * Settings navigation row (`settings.section` slot contribution) rendering the
 * mobile bridge configuration with the harness design tokens. Data rides the
 * exposed `mobile-bridge` settings namespace over the loopback RPC.
 * @module @sparkelf/dsh-mobile-bridge/client
 */

import type { Context } from '@deepseek-ai/cordis'
import React, { useEffect, useRef, useState } from 'react'

const NS = 'mobile-bridge'

const STYLE = `
.dshmb-section{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.dshmb-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l)}
.dshmb-row .lab{font-size:14px;font-weight:600}
.dshmb-row .desc{font-size:12px;opacity:.65;margin-top:4px}
.dshmb-row input[type=text],.dshmb-row input[type=password],.dshmb-row input[type=number]{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;width:280px}
.dshmb-row input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary)}
.dshmb-status{padding:4px 10px;border-radius:99px;background:var(--dsw-alias-bg-overlay);font-size:12px}
.dshmb-status.on{color:var(--dsw-alias-brand-primary)}
.dshmb-save{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-brand-primary-invert);border:0;border-radius:8px;padding:8px 18px;cursor:pointer}
.dshmb-msg{font-size:12px;opacity:.8;min-height:16px}
.dshmb-qr{margin-top:8px;background:#fff;display:inline-block;padding:8px;border-radius:8px}
`

interface SectionValues {
  serverUrl: string
  localPort: number
  userKey: string
  ownerEmail: string
  emailTwoFactor: boolean
  autoConnect: boolean
}

function rpc(method: string, payload: unknown): Promise<any> {
  const id = 'r' + Math.random().toString(36).slice(2)
  return fetch('/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  }).then(r => r.json()).then(d => {
    if (!d.result || !d.result.ok) throw new Error((d.result && d.result.error && d.result.error.message) || 'rpc failed')
    return d.result.value
  })
}

/** Settings page body for the mobile bridge, styled with harness tokens. */
export function MobileBridgeSection(): React.ReactElement {
  const [values, setValues] = useState<SectionValues>({ serverUrl: '', localPort: 3080, userKey: '', ownerEmail: '', emailTwoFactor: false, autoConnect: true })
  const [status, setStatus] = useState<{ connected: boolean; qrUrl: string }>({ connected: false, qrUrl: '' })
  const [msg, setMsg] = useState('')
  const qrRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/mobile/bridge/status').then(r => r.json()).then(s => setStatus({ connected: !!s.connected, qrUrl: s.qrUrl ?? '' })).catch(() => {})
    rpc('settings.describe', {}).then(v => {
      const row = (v.namespaces ?? []).find((n: any) => n.ns === NS)
      if (!row) return
      const val = row.value ?? {}
      setValues({
        serverUrl: val.serverUrl ?? '',
        localPort: val.localPort ?? 3080,
        userKey: val.userKey ?? '',
        ownerEmail: val.ownerEmail ?? '',
        emailTwoFactor: !!val.emailTwoFactor,
        autoConnect: val.autoConnect !== false,
      })
    }).catch(e => setMsg(String(e.message ?? e)))
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
    script.onload = () => {}
    document.head.appendChild(script)
  }, [])

  useEffect(() => {
    const win = window as any
    if (qrRef.current && status.qrUrl && win.QRCode) {
      qrRef.current.innerHTML = ''
      new win.QRCode(qrRef.current, { text: status.qrUrl, width: 180, height: 180 })
    }
  }, [status])

  const set = <K extends keyof SectionValues>(key: K, value: SectionValues[K]) => setValues(v => ({ ...v, [key]: value }))

  const save = () => {
    rpc('settings.update', { ns: NS, patch: { ...values, autoReconnect: values.autoConnect } })
      .then(() => setMsg('已保存，插件将按新配置重连。'))
      .catch(e => setMsg(String(e.message ?? e)))
  }

  return React.createElement('div', { className: 'dshmb-section' },
    React.createElement('style', null, STYLE),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '连接状态'),
        React.createElement('div', { className: 'desc' }, '桌面到公网桥接服务的出站加密通道。'),
      ),
      React.createElement('span', { className: 'dshmb-status' + (status.connected ? ' on' : '') }, status.connected ? '已连接' : '未连接'),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '服务器地址'),
        React.createElement('div', { className: 'desc' }, '桥接服务的 HTTPS 地址。'),
      ),
      React.createElement('input', { type: 'text', value: values.serverUrl, onChange: e => set('serverUrl', e.target.value) }),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '本地端口'),
        React.createElement('div', { className: 'desc' }, '本机 Harness Web 端口。'),
      ),
      React.createElement('input', { type: 'number', value: values.localPort, onChange: e => set('localPort', Number(e.target.value) || 3080) }),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '加密口令'),
        React.createElement('div', { className: 'desc' }, '留空=仅配对密钥；设置后 QR 不再携带，手机需输入（双因素）。'),
      ),
      React.createElement('input', { type: 'password', value: values.userKey, onChange: e => set('userKey', e.target.value) }),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '所有者邮箱'),
        React.createElement('div', { className: 'desc' }, '扫码二因子验证码的收件地址。'),
      ),
      React.createElement('input', { type: 'text', value: values.ownerEmail, onChange: e => set('ownerEmail', e.target.value) }),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '扫码邮箱二因子'),
        React.createElement('div', { className: 'desc' }, '手机扫码后需输入所有者邮箱验证码。'),
      ),
      React.createElement('input', { type: 'checkbox', checked: values.emailTwoFactor, onChange: e => set('emailTwoFactor', e.target.checked) }),
    ),
    React.createElement('div', { className: 'dshmb-row' },
      React.createElement('div', null,
        React.createElement('div', { className: 'lab' }, '启动自动连接 / 自动重连'),
        React.createElement('div', { className: 'desc' }, '启动时与断线后自动建立出站连接。'),
      ),
      React.createElement('input', { type: 'checkbox', checked: values.autoConnect, onChange: e => set('autoConnect', e.target.checked) }),
    ),
    React.createElement('div', null,
      React.createElement('div', { className: 'lab' }, '手机配对'),
      React.createElement('div', { className: 'desc' }, '手机扫码即自动登录并连接（端到端加密，服务器盲转发）。'),
      React.createElement('div', { ref: qrRef, className: 'dshmb-qr' }),
    ),
    React.createElement('div', null,
      React.createElement('button', { className: 'dshmb-save', onClick: save }, '保存配置'),
      React.createElement('span', { className: 'dshmb-msg' }, ' ' + msg),
    ),
  )
}

/** Browser entry: overlay plus the settings navigation row. */
export function apply(ctx: Context): void {
  if (typeof document === 'undefined') return
  const narrow = window.matchMedia('(max-width: 720px)')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/mobile/bridge/style.css'
  const sync = () => { link.disabled = !narrow.matches }
  narrow.addEventListener('change', sync)
  sync()
  document.head.appendChild(link)

  const slots = (ctx as Context & { slots?: {
    inject(name: string, factory: () => unknown): unknown
    register(spec: Record<string, unknown>, component: unknown): unknown
  } }).slots
  if (slots === undefined) return
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 40,
    label: () => '移动连接',
  }, MobileBridgeSection))
}
