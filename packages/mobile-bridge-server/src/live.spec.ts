/**
 * Live dress rehearsal against a real local Harness web on :3080. Self-skips
 * in CI or anywhere the loopback web is absent; on a dev box it proves the
 * whole chain — register, bind, tunnel, stock HTML with injected overlay.
 * @module @sparkelf/dsh-mobile-bridge-server/live
 */

import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, describe, expect, it } from 'vitest'
import { relayToLocalWeb, type RelayRequest } from '../../mobile-bridge/src/index.ts'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

const LIVE_PORT = Number(process.env.LIVE_HARNESS_PORT ?? 3080)

let reachable = false
try {
  const probe = await fetch(`http://127.0.0.1:${LIVE_PORT}/`, { signal: AbortSignal.timeout(3000) })
  reachable = probe.ok
} catch {
  reachable = false
}

let bridge: Server
let bridgePort: number
let liveCodes: string[] = []

if (reachable) {
  const store = new UserStore(join(mkdtempSync(join(tmpdir(), 'mbs-live-')), 'u.json'), '0123456789abcdef')
  const codes: string[] = []
  bridge = createBridgeServer(store, { mailer: async (_email, code) => { codes.push(code) } })
  liveCodes = codes
  await new Promise<void>(resolve => bridge.listen(0, resolve))
  bridgePort = (bridge.address() as AddressInfo).port
}

afterAll(async () => {
  if (reachable) await new Promise(resolve => bridge.close(resolve))
})

describe.skipIf(!reachable)('live rehearsal against the real Harness web', () => {
  it('serves the stock UI through the tunnel after email login', async () => {
    const base = `http://127.0.0.1:${bridgePort}`
    await fetch(base + '/bridge/api/email/code', {
      method: 'POST',
      body: JSON.stringify({ email: 'rehearsal@example.com' }),
    })
    const login = await fetch(base + '/bridge/api/login/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'rehearsal@example.com', code: liveCodes.at(-1) ?? '' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

    const start = await fetch(base + '/bridge/api/bridge/start', { method: 'POST', body: '{}' }).then(response => response.json()) as { code: string }
    const bridgeSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/bridge?code=${start.code}`)
    await new Promise<void>((resolve, reject) => { bridgeSocket.on('open', () => resolve()); bridgeSocket.on('error', reject) })
    bridgeSocket.on('message', raw => {
      const request = JSON.parse(String(raw)) as RelayRequest
      void relayToLocalWeb(request, LIVE_PORT, frame => bridgeSocket.send(JSON.stringify(frame)))
    })

    const bind = await fetch(base + '/bridge/api/bind', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bridge: start.code }),
    })
    expect(bind.status).toBe(200)

    const page = await fetch(base + '/', { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('__DSH_BOOT__')

    // The overlay stylesheet lives on the plugin's /mobile/ route; it only
    // exists once the plugin is installed in the target runtime (deployment
    // step in docs/deploy-mobile-bridge.md), so assert it conditionally.
    const direct = await fetch(`http://127.0.0.1:${LIVE_PORT}/mobile/bridge/style.css`)
    if ((direct.headers.get('content-type') ?? '').includes('text/css')) {
      const css = await fetch(base + '/mobile/bridge/style.css', { headers: { cookie } })
      expect(css.status).toBe(200)
      expect(await css.text()).toContain('max-width: 720px')
    }

    bridgeSocket.close()
  }, 20000)
})
