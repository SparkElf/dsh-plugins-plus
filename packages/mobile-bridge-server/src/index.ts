/**
 * Bridge server entry: reads MOBILE_BRIDGE_PORT (default 8787),
 * MOBILE_BRIDGE_DATA (store json path), MOBILE_BRIDGE_SECRET (token HMAC
 * secret; required, no insecure default).
 * @module @sparkelf/dsh-mobile-bridge-server
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'
import { wechatConfigFromEnv, wechatVerifier } from './wechat.ts'

const secret = process.env.MOBILE_BRIDGE_SECRET ?? ''
if (secret.length < 16) {
  console.error('MOBILE_BRIDGE_SECRET must be at least 16 chars')
  process.exit(1)
}
const data = process.env.MOBILE_BRIDGE_DATA ?? 'mobile-bridge-users.json'
mkdirSync(dirname(data) === '.' ? '.' : dirname(data), { recursive: true })
const port = Number(process.env.MOBILE_BRIDGE_PORT ?? 8787)

const wechat = wechatConfigFromEnv()
const server = createBridgeServer(new UserStore(data, secret), {
  ...wechat === undefined ? {} : { externalAuth: { wechat: wechatVerifier(wechat) } },
})
if (wechat) console.log('[mobile-bridge] wechat login enabled')
server.listen(port, () => {
  console.log(`[mobile-bridge] listening on :${port}`)
})
