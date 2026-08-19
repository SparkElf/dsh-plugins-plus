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
let pairPromiseResolve;
const pairReady = new Promise(resolve => { pairPromiseResolve = resolve });
let keyPromise = null;
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'pair') pairPromiseResolve(event.data.pair)
})

let wsPromise = null
let counter = 0
const pending = new Map()

function wsReady() {
  if (wsPromise) return wsPromise
  wsPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/client')
    ws.onopen = () => resolve(ws)
    ws.onerror = () => { wsPromise = null; reject(new Error('bridge socket failed')) }
    ws.onmessage = event => {
      const frame = JSON.parse(event.data)
      const entry = pending.get(frame.id)
      if (!entry) return
      if (frame.end) { entry.controller.close(); pending.delete(frame.id); return }
      void (async () => {
        if (frame.stream) { const head = await decryptJSON(entry.key, frame.blob); entry.status = head.status; entry.headers = head.headers; return }
        if (frame.chunk !== undefined) { const payload = await decryptJSON(entry.key, frame.chunk); const bytes = base64ToBytes(payload.d); entry.controller.enqueue(bytes); return }
        const full = await decryptJSON(entry.key, frame.blob)
        let body = base64ToBytes(full.body ?? '')
        if ((full.headers?.['content-type'] ?? '').includes('text/html')) {
          let html = new TextDecoder().decode(body)
          if (!html.includes('/mobile/bridge/style.css')) html = html.replace('</head>', '<link rel="stylesheet" href="/mobile/bridge/style.css"></head>')
          body = new TextEncoder().encode(html)
        }
        pending.delete(frame.id)
        entry.resolve(new Response(body, { status: full.status, headers: full.headers }))
      })()
    }
  })
  return wsPromise
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/bridge') || url.pathname === '/sw.js' || url.pathname.startsWith('/ws')) return
  event.respondWith((async () => {
    const pair = await pairReady
    if (!keyPromise) keyPromise = deriveKey(pair.k ?? '', pair.s)
    const key = await keyPromise
    const request = event.request
    const bodyBytes = new Uint8Array(await request.arrayBuffer())
    const id = 'r' + (++counter)
    const blob = await encryptJSON(key, {
      method: request.method,
      path: url.pathname + url.search,
      headers: { accept: request.headers.get('accept') ?? '' },
      body: bytesToBase64(bodyBytes),
      bodyEncoding: 'base64',
    })
    const ws = await wsReady()
    if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return new Promise((resolve, reject) => {
        const controller = new TransformStream()
        pending.set(id, { key, controller: controller.writable.getWriter(), resolve: () => resolve(new Response(controller.readable, { headers: { 'content-type': 'text/event-stream' } })), status: 200, headers: {} })
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

export const CLIENT_SOURCE = `/* DSH mobile bridge client bootstrap: login, pairing, SW registration. */
(function () {
  var $ = function (id) { return document.getElementById(id) }
  function api(p, o) {
    return fetch('/bridge' + p, Object.assign({ credentials: 'same-origin' }, o)).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j })
    })
  }
  function registerSw(pair) {
    if (!('serviceWorker' in navigator)) { document.querySelector('main').insertAdjacentHTML('beforeend', '<p class=err>此浏览器不支持 service worker</p>'); return }
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () {
      return navigator.serviceWorker.ready
    }).then(function (reg) {
      reg.active.postMessage({ type: 'pair', pair: pair })
      if (location.pathname !== '/') location.href = '/'
    })
  }
  var fragment = location.hash.slice(1)
  if (fragment) {
    try {
      var pair = JSON.parse(decodeURIComponent(fragment))
      localStorage.setItem('dshmb-pair', JSON.stringify(pair))
      api('/api/login/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.b || pair.c }) })
        .then(function () { history.replaceState(null, '', '/'); registerSw(pair) })
        .catch(function (e) { var m = document.querySelector('main'); if (m) m.insertAdjacentHTML('beforeend', '<p class=err>' + e.message + '</p>') })
      return
    } catch (e) { /* fall through to manual login */ }
  }
  var stored = localStorage.getItem('dshmb-pair')
  if (stored && document.cookie.includes('mbs=')) { registerSw(JSON.parse(stored)); return }
  if (!document.getElementById('e')) return
  $('s').onclick = function () {
    api('/api/email/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value }) })
      .then(function () { $('x').textContent = '验证码已发送' })
      .catch(function (e) { $('x').textContent = e.message })
  }
  $('l').onclick = function () {
    api('/api/login/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value, code: $('c').value, bridge: $('b').value }) })
      .then(function () {
        var pair = JSON.parse(localStorage.getItem('dshmb-pair') || '{"s":""}')
        registerSw(pair)
      })
      .catch(function (e) { $('x').textContent = e.message })
  }
})()
`
