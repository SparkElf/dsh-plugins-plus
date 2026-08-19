/**
 * WeChat open-platform web login verifier: exchanges the QR-login `code` for
 * an access token and returns the stable openid (unionid when present) as
 * the external identity. Enabled only when WECHAT_APP_ID and
 * WECHAT_APP_SECRET are configured; otherwise the provider stays absent.
 * @module @sparkelf/dsh-mobile-bridge-server/wechat
 */

import type { ExternalAuthVerifier } from './server.ts'

/** WeChat open-platform credentials for one deployment. */
export interface WechatConfig {
  appId: string
  appSecret: string
}

/** Build a WeChat verifier from config; fetch seam injectable for tests. */
export function wechatVerifier(
  config: WechatConfig,
  fetchImpl: typeof fetch = fetch,
): ExternalAuthVerifier {
  return async payload => {
    const code = String(payload.code ?? '').trim()
    if (code.length === 0) throw new Error('missing wechat code')
    const url = 'https://api.weixin.qq.com/sns/oauth2/access_token'
      + `?appid=${encodeURIComponent(config.appId)}`
      + `&secret=${encodeURIComponent(config.appSecret)}`
      + `&code=${encodeURIComponent(code)}`
      + '&grant_type=authorization_code'
    const response = await fetchImpl(url)
    const token = await response.json() as { errcode?: number; errmsg?: string; openid?: string; unionid?: string }
    if (token.errcode) throw new Error('wechat: ' + (token.errmsg ?? String(token.errcode)))
    const identity = token.unionid ?? token.openid
    if (!identity) throw new Error('wechat: no stable identity in token response')
    return identity
  }
}

/** Read WeChat config from env; undefined disables the provider. */
export function wechatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WechatConfig | undefined {
  const appId = (env.WECHAT_APP_ID ?? '').trim()
  const appSecret = (env.WECHAT_APP_SECRET ?? '').trim()
  if (!appId || !appSecret) return undefined
  return { appId, appSecret }
}
