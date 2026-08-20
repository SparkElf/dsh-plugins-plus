/**
 * Phone-side bootstrap sources served verbatim by the bridge server: the
 * service worker decrypts the end-to-end encrypted relay and serves the stock
 * Harness web from ciphertext; the client script owns login, pairing, and SW
 * registration. Both are plain auditable JavaScript with no secrets server-side.
 * @module @sparkelf/dsh-mobile-bridge-server/phone
 */

const CRYPTO_JS = `
async function deriveKey(userKey, pairingSecret) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('dsh-mobile-bridge/v1:' + userKey + ':' + pairingSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('dsh-mobile-bridge'), info: new Uint8Array(0) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function bytesToBase64(bytes) { let b = ''; for (const x of bytes) b += String.fromCharCode(x); return btoa(b); }
function base64ToBytes(blob) { const b = atob(blob); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; }
async function encryptJSON(key, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(JSON.stringify(value)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(nonce, 0); out.set(new Uint8Array(ct), 12);
  return bytesToBase64(out);
}
async function decryptJSON(key, blob) {
  const raw = base64ToBytes(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
`

export const SW_SOURCE = `/* DSH mobile bridge service worker: blind-server E2EE client. */
${CRYPTO_JS}
let pairValue = null
let pairWaiters = []
let keyPromise = null
let revoked = false
const PAIR_CACHE = 'dsh-mobile-bridge-pair-v1'
const PAIR_CACHE_KEY = '/bridge/.pair-state'
async function waitForPair() {
  if (pairValue) return pairValue
  const cache = await caches.open(PAIR_CACHE)
  const stored = await cache.match(PAIR_CACHE_KEY)
  if (stored) {
    const state = await stored.json()
    if (state.revoked) { revoked = true; return null }
    pairValue = state.pair
    return pairValue
  }
  return new Promise(resolve => { pairWaiters.push(resolve) })
}
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', event => {
  if (!event.data) return
  if (event.data.type === 'pair') {
    pairValue = event.data.pair
    keyPromise = null
    revoked = false
    for (const resolve of pairWaiters) resolve(pairValue)
    pairWaiters = []
    const persist = caches.open(PAIR_CACHE).then(cache => cache.put(PAIR_CACHE_KEY, new Response(JSON.stringify({ pair: pairValue }), { headers: { 'content-type': 'application/json' } })))
    event.waitUntil(persist.then(() => { event.ports[0].postMessage({ ready: true }) }))
    return
  }
  if (event.data.type === 'application-websocket') {
    const port = event.ports[0]
    event.waitUntil(openApplicationSocket(event.data, port).catch(error => {
      console.error('[dsh-mobile-bridge] application websocket setup failed', error)
      port.postMessage({ kind: 'websocket-error', message: error.message })
    }))
  }
})

let wsPromise = null
let counter = 0
const pending = new Map()

function wsReady() {
  if (wsPromise) return wsPromise
  wsPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/client')
    ws.onopen = () => resolve(ws)
    ws.onerror = () => {
      wsPromise = null
      const error = new Error('bridge socket failed')
      console.error('[dsh-mobile-bridge] bridge socket failed', error)
      reject(error)
    }
    ws.onclose = event => {
      wsPromise = null
      const error = new Error('bridge socket closed')
      const settlePending = () => {
        for (const entry of pending.values()) {
          if (entry.websocketPort) {
            if (!revoked) entry.websocketPort.postMessage({ kind: 'websocket-error', message: error.message })
            entry.websocketPort.close()
          } else if (entry.controller) void entry.controller.abort(error)
          else if (revoked) entry.resolve(revokedResponse())
          else entry.reject(error)
        }
        pending.clear()
      }
      if (event.code === 4003) {
        pairValue = null
        keyPromise = null
        revoked = true
        void caches.open(PAIR_CACHE).then(cache => cache.put(PAIR_CACHE_KEY, new Response(JSON.stringify({ revoked: true }), { headers: { 'content-type': 'application/json' } }))).catch(error => { console.error('[dsh-mobile-bridge] revoked pair persistence failed', error) })
        void self.clients.matchAll({ type: 'window' })
          .then(clients => Promise.all(clients.map(client => client.navigate('/__dsh_mobile_revoked'))))
          .then(settlePending)
          .catch(error => { console.error('[dsh-mobile-bridge] revoked page navigation failed', error); settlePending() })
        return
      }
      settlePending()
    }
    ws.onmessage = event => {
      const frame = JSON.parse(event.data)
      const entry = pending.get(frame.id)
      if (!entry) return
      if (entry.websocketPort) {
        void decryptJSON(entry.key, frame.blob).then(payload => {
          entry.websocketPort.postMessage(payload)
          if (payload.kind === 'websocket-close') { entry.websocketPort.close(); pending.delete(frame.id) }
        }).catch(error => {
          console.error('[dsh-mobile-bridge] application websocket response failed', error)
          entry.websocketPort.postMessage({ kind: 'websocket-error', message: error.message })
          pending.delete(frame.id)
        })
        return
      }
      if (frame.end) { entry.controller.close(); pending.delete(frame.id); return }
      void (async () => {
        if (frame.stream) { const head = await decryptJSON(entry.key, frame.blob); entry.status = head.status; entry.headers = head.headers; entry.resolve(); return }
        if (frame.chunk !== undefined) { const payload = await decryptJSON(entry.key, frame.chunk); const bytes = base64ToBytes(payload.d); entry.controller.enqueue(bytes); return }
        const full = await decryptJSON(entry.key, frame.blob)
        let body = base64ToBytes(full.body ?? '')
        if (full.compression === 'gzip') {
          const decompressed = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))
          body = new Uint8Array(await new Response(decompressed).arrayBuffer())
        }
        if ((full.headers?.['content-type'] ?? '').includes('text/html')) {
          let html = new TextDecoder().decode(body)
          if (!html.includes('/bridge/socket-client.js')) html = html.replace('</head>', '<script src="/bridge/socket-client.js"></script></head>')
          body = new TextEncoder().encode(html)
        }
        pending.delete(frame.id)
        entry.resolve(new Response(body, { status: full.status, headers: full.headers }))
      })().catch(error => { console.error('[dsh-mobile-bridge] response decrypt failed', error); entry.reject(error); pending.delete(frame.id) })
    }
  })
  return wsPromise
}

async function openApplicationSocket(command, port) {
  const pair = await waitForPair()
  if (revoked) throw new Error('device revoked')
  if (!keyPromise) keyPromise = deriveKey(pair.k ?? '', pair.s)
  const key = await keyPromise
  const ws = await wsReady()
  const id = 'w' + (++counter)
  pending.set(id, { key, websocketPort: port })
  port.onmessage = event => {
    void (async () => {
      const message = event.data
      const blob = await encryptJSON(key, message.kind === 'websocket-message'
        ? { kind: 'websocket-message', data: message.data, binary: message.binary }
        : { kind: 'websocket-close', code: message.code, reason: message.reason })
      ws.send(JSON.stringify({ id, blob }))
    })().catch(error => {
      console.error('[dsh-mobile-bridge] application websocket request failed', error)
      port.postMessage({ kind: 'websocket-error', message: error.message })
    })
  }
  port.start()
  const blob = await encryptJSON(key, { kind: 'websocket-open', path: command.path, protocols: command.protocols })
  ws.send(JSON.stringify({ id, blob }))
}

function revokedResponse() {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备已下线</title><style>*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:#0d1015;color:#f4f7fb;font:14px/1.5 system-ui,sans-serif}main{max-width:390px;margin:10vh auto;padding:8px}img{width:148px;height:auto}h1{margin:24px 0 8px;font-size:20px}p{margin:0;color:#aeb8c8}a{display:grid;height:44px;margin-top:24px;place-items:center;border-radius:8px;background:#405de6;color:white;font-weight:650;text-decoration:none}</style></head><body><main><img src="/bridge/deepseek-logo.svg" alt="DeepSeek"><h1>此设备已下线</h1><p>请在桌面端重新扫码后连接。</p><a href="/bridge/?revoked=1">返回配对</a></main></body></html>'
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/bridge') || url.pathname === '/sw.js' || url.pathname.startsWith('/ws')) return
  event.respondWith((async () => {
    let pair
    try {
      pair = await waitForPair()
    } catch (error) {
      console.error('[dsh-mobile-bridge] persisted pair state failed', error)
      return new Response('Mobile Bridge pair state failed', { status: 500 })
    }
    if (revoked) return revokedResponse()
    if (!keyPromise) keyPromise = deriveKey(pair.k ?? '', pair.s)
    const key = await keyPromise
    const request = event.request
    const bodyBytes = new Uint8Array(await request.arrayBuffer())
    const id = 'r' + (++counter)
    const headers = { accept: request.headers.get('accept') ?? '' }
    const contentType = request.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    const blob = await encryptJSON(key, {
      kind: 'http',
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body: bytesToBase64(bodyBytes),
      bodyEncoding: 'base64',
    })
    let ws
    try {
      ws = await wsReady()
    } catch (error) {
      if (revoked) return revokedResponse()
      console.error('[dsh-mobile-bridge] bridge connection failed', error)
      return new Response('Mobile Bridge connection failed', { status: 502 })
    }
    if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return new Promise((resolve, reject) => {
        const controller = new TransformStream()
        pending.set(id, { key, controller: controller.writable.getWriter(), resolve: () => resolve(new Response(controller.readable, { headers: { 'content-type': 'text/event-stream' } })), reject, status: 200, headers: {} })
        ws.send(JSON.stringify({ id, blob, streamHint: true }))
      })
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { key, resolve, reject })
      ws.send(JSON.stringify({ id, blob }))
    })
  })())
})
`

export const SOCKET_CLIENT_SOURCE = `/* E2EE WebSocket facade for the relayed Harness application. */
(function () {
  function bytesToBase64(bytes) { var out = ''; for (var value of bytes) out += String.fromCharCode(value); return btoa(out) }
  function base64ToBytes(value) { var raw = atob(value); var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i); return out }
  class BridgeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url, protocols) {
      super()
      var target = new URL(String(url), location.href)
      var socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      if (target.protocol !== socketProtocol || target.host !== location.host) throw new DOMException('Cross-origin WebSocket is not available through Mobile Bridge', 'SecurityError')
      this.url = target.href
      this.protocol = ''
      this.extensions = ''
      this.readyState = BridgeWebSocket.CONNECTING
      this.bufferedAmount = 0
      this.binaryType = 'blob'
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      this._port = new MessageChannel()
      this._port.port1.onmessage = event => {
        var message = event.data
        if (message.kind === 'websocket-open') {
          console.info('[dsh-mobile-bridge] application websocket facade opened', target.pathname)
          this.protocol = message.protocol
          this.readyState = BridgeWebSocket.OPEN
          this._emit(new Event('open'))
          return
        }
        if (message.kind === 'websocket-message') {
          var data = message.binary
            ? (this.binaryType === 'arraybuffer' ? base64ToBytes(message.data).buffer : new Blob([base64ToBytes(message.data)]))
            : message.data
          this._emit(new MessageEvent('message', { data: data }))
          return
        }
        if (message.kind === 'websocket-close') {
          this.readyState = BridgeWebSocket.CLOSED
          this._emit(new CloseEvent('close', { code: message.code, reason: message.reason, wasClean: true }))
          this._port.port1.close()
          return
        }
        this._fail(new Error(message.message || 'application websocket failed'))
      }
      this._port.port1.start()
      var protocolList = protocols === undefined ? [] : (Array.isArray(protocols) ? protocols : [protocols])
      navigator.serviceWorker.controller.postMessage({ type: 'application-websocket', path: target.pathname + target.search, protocols: protocolList }, [this._port.port2])
    }
    _emit(event) {
      this.dispatchEvent(event)
      var handler = this['on' + event.type]
      if (typeof handler === 'function') handler.call(this, event)
    }
    _fail(error) {
      console.error('[dsh-mobile-bridge] application websocket facade failed', error)
      this.readyState = BridgeWebSocket.CLOSED
      this._emit(new ErrorEvent('error', { error: error, message: error.message }))
      this._emit(new CloseEvent('close', { code: 1011, reason: error.message, wasClean: false }))
      this._port.port1.close()
    }
    send(data) {
      if (this.readyState !== BridgeWebSocket.OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError')
      if (typeof data === 'string') {
        this._port.port1.postMessage({ kind: 'websocket-message', data: data, binary: false })
        return
      }
      if (data instanceof Blob) {
        data.arrayBuffer().then(buffer => { if (this.readyState === BridgeWebSocket.OPEN) this.send(buffer) }).catch(error => { this._fail(error) })
        return
      }
      var bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      this._port.port1.postMessage({ kind: 'websocket-message', data: bytesToBase64(bytes), binary: true })
    }
    close(code, reason) {
      if (this.readyState === BridgeWebSocket.CLOSING || this.readyState === BridgeWebSocket.CLOSED) return
      this.readyState = BridgeWebSocket.CLOSING
      this._port.port1.postMessage({ kind: 'websocket-close', code: code === undefined ? 1000 : code, reason: reason === undefined ? '' : String(reason) })
    }
  }
  BridgeWebSocket.prototype.CONNECTING = BridgeWebSocket.CONNECTING
  BridgeWebSocket.prototype.OPEN = BridgeWebSocket.OPEN
  BridgeWebSocket.prototype.CLOSING = BridgeWebSocket.CLOSING
  BridgeWebSocket.prototype.CLOSED = BridgeWebSocket.CLOSED
  globalThis.WebSocket = BridgeWebSocket
})()
`

export const CLIENT_SOURCE = `/* DSH mobile bridge client bootstrap: login, pairing, preferences, and SW registration. */
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var COPY = {
    zh: {
      preferences: '显示偏好', title: '移动连接', scanFirst: '请扫描桌面端二维码', email: '邮箱', emailPlaceholder: 'name@example.com',
      code: '验证码', codePlaceholder: '6 位验证码', send: '发送', sending: '发送中', sent: '验证码已发送',
      pairingCode: '配对码', pairingPlaceholder: '6 位字符', connect: '登录并连接', connecting: '正在连接', light: '浅色', dark: '深色',
      ownerCode: '桌面所有者邮箱收到验证码，请输入', passphrase: '输入桌面端设置的加密口令', cancelled: '已取消',
      serviceWorkerUnsupported: '此浏览器不支持 Service Worker。', serviceWorkerTimeout: '移动连接初始化超时，请重新扫描最新二维码。',
      unknownPair: '配对码无效或桌面端已离线，请扫描最新二维码。', expiredPair: '配对码已过期，请扫描最新二维码。',
      usedPair: '配对码已使用，请扫描最新二维码。', invalidCode: '验证码无效或已过期。'
    },
    en: {
      preferences: 'Display preferences', title: 'Mobile connection', scanFirst: 'Scan the QR code shown on the desktop', email: 'Email', emailPlaceholder: 'name@example.com',
      code: 'Verification code', codePlaceholder: '6-digit code', send: 'Send', sending: 'Sending', sent: 'Code sent',
      pairingCode: 'Pairing code', pairingPlaceholder: '6 characters', connect: 'Sign in and connect', connecting: 'Connecting', light: 'Light', dark: 'Dark',
      ownerCode: 'Enter the code sent to the desktop owner email', passphrase: 'Enter the passphrase configured on the desktop', cancelled: 'Cancelled',
      serviceWorkerUnsupported: 'This browser does not support Service Workers.', serviceWorkerTimeout: 'Mobile connection setup timed out. Scan the latest QR code again.',
      unknownPair: 'The pairing code is invalid or the desktop is offline. Scan the latest QR code.', expiredPair: 'The pairing code expired. Scan the latest QR code.',
      usedPair: 'The pairing code was already used. Scan the latest QR code.', invalidCode: 'The verification code is invalid or expired.'
    }
  }
  var language = localStorage.getItem('dshmb-language') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  var theme = localStorage.getItem('dshmb-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  function tr(key) { return COPY[language][key] }
  function applyLanguage() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.querySelector('.preferences').setAttribute('aria-label', tr('preferences'))
    document.querySelectorAll('[data-i18n]').forEach(function (node) { node.textContent = tr(node.getAttribute('data-i18n')) })
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) { node.placeholder = tr(node.getAttribute('data-i18n-placeholder')) })
    $('langZh').setAttribute('aria-pressed', String(language === 'zh'))
    $('langEn').setAttribute('aria-pressed', String(language === 'en'))
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme
    $('themeLight').setAttribute('aria-pressed', String(theme === 'light'))
    $('themeDark').setAttribute('aria-pressed', String(theme === 'dark'))
  }
  $('langZh').onclick = function () { language = 'zh'; localStorage.setItem('dshmb-language', language); applyLanguage() }
  $('langEn').onclick = function () { language = 'en'; localStorage.setItem('dshmb-language', language); applyLanguage() }
  $('themeLight').onclick = function () { theme = 'light'; localStorage.setItem('dshmb-theme', theme); applyTheme() }
  $('themeDark').onclick = function () { theme = 'dark'; localStorage.setItem('dshmb-theme', theme); applyTheme() }
  applyLanguage()
  applyTheme()

  if (new URLSearchParams(location.search).has('revoked')) {
    localStorage.removeItem('dshmb-pair')
    history.replaceState(null, '', '/bridge/')
  }
  function api(path, options) {
    return fetch('/bridge' + path, Object.assign({ credentials: 'same-origin' }, options)).then(function (response) {
      return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || response.status); return body })
    })
  }
  function errorText(message) {
    if (message === 'unknown or offline pairing code') return tr('unknownPair')
    if (message === 'pairing code expired') return tr('expiredPair')
    if (message === 'pairing code already used') return tr('usedPair')
    if (message === 'invalid or expired code') return tr('invalidCode')
    if (message === 'serviceWorkerUnsupported') return tr('serviceWorkerUnsupported')
    if (message === 'serviceWorkerTimeout') return tr('serviceWorkerTimeout')
    if (message === 'cancelled') return tr('cancelled')
    return message
  }
  function showError(error) {
    console.error('[dsh-mobile-bridge] phone action failed', error)
    $('x').textContent = errorText(String(error && error.message || error))
  }
  function waitForControl() {
    if (navigator.serviceWorker.controller) return Promise.resolve()
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        navigator.serviceWorker.removeEventListener('controllerchange', controlled)
        reject(new Error('serviceWorkerTimeout'))
      }, 10000)
      function controlled() {
        clearTimeout(timer)
        resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', controlled, { once: true })
    })
  }
  function persistPair(registration, pair) {
    return new Promise(function (resolve, reject) {
      var channel = new MessageChannel()
      var timer = setTimeout(function () { reject(new Error('serviceWorkerTimeout')) }, 10000)
      channel.port1.onmessage = function () { clearTimeout(timer); resolve() }
      channel.port1.onmessageerror = function () { clearTimeout(timer); reject(new Error('serviceWorkerTimeout')) }
      registration.active.postMessage({ type: 'pair', pair: pair }, [channel.port2])
    })
  }
  function registerSw(pair) {
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('serviceWorkerUnsupported'))
    return navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function () { return navigator.serviceWorker.ready })
      .then(function (registration) { return persistPair(registration, pair) })
      .then(waitForControl)
  }
  function navigateToHarness() {
    history.replaceState(null, '', '/')
    location.assign('/')
  }

  var fragment = location.hash.slice(1)
  if (fragment) {
    try {
      var pair = JSON.parse(decodeURIComponent(fragment))
      var proceed = function () {
        $('x').textContent = tr('connecting')
        $('b').value = pair.b || pair.c
        localStorage.setItem('dshmb-pair', JSON.stringify(pair))
        // 先确认 Service Worker 已持久化密钥并接管页面，再消费一次性票据。
        registerSw(pair)
          .then(function () {
            return api('/api/login/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.b || pair.c }) })
          })
          .then(function (result) {
            if (result.challenge === 'email') {
              var mailCode = prompt(tr('ownerCode'))
              if (mailCode === null) throw new Error('cancelled')
              return api('/api/login/bridge/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.b || pair.c, emailCode: mailCode }) })
            }
            return result
          })
          .then(navigateToHarness)
          .catch(function (error) { history.replaceState(null, '', '/bridge/'); showError(error) })
      }
      if (pair.k === undefined) {
        var passphrase = prompt(tr('passphrase'))
        if (passphrase === null) showError(new Error('cancelled'))
        else { pair.k = passphrase; proceed() }
      } else proceed()
    } catch (error) {
      console.error('[dsh-mobile-bridge] QR payload failed', error)
    }
  }

  var stored = localStorage.getItem('dshmb-pair')
  $('loginForm').hidden = !stored
  $('scanFirst').hidden = !!stored
  if (!fragment && stored && document.cookie.includes('mbs=')) {
    registerSw(JSON.parse(stored)).then(navigateToHarness).catch(showError)
  }
  $('s').onclick = function () {
    var button = $('s')
    button.disabled = true
    button.textContent = tr('sending')
    $('x').textContent = ''
    api('/api/email/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value }) })
      .then(function () { $('x').textContent = tr('sent') })
      .catch(showError)
      .finally(function () { button.disabled = false; button.textContent = tr('send') })
  }
  $('l').onclick = function () {
    var button = $('l')
    button.disabled = true
    button.textContent = tr('connecting')
    $('x').textContent = ''
    var pair = JSON.parse(localStorage.getItem('dshmb-pair'))
    pair.b = $('b').value
    localStorage.setItem('dshmb-pair', JSON.stringify(pair))
    registerSw(pair)
      .then(function () {
        return api('/api/login/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value, code: $('c').value, bridge: pair.b }) })
      })
      .then(navigateToHarness)
      .catch(showError)
      .finally(function () { button.disabled = false; button.textContent = tr('connect') })
  }
})()
`
