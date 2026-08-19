import { describe, expect, it } from 'vitest'
import { wechatConfigFromEnv, wechatVerifier } from './wechat.ts'

function stubFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
}

describe('wechat verifier', () => {
  it('returns unionid when present, openid otherwise', async () => {
    const withUnion = wechatVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ access_token: 't', openid: 'od-1', unionid: 'uu-1' }))
    await expect(withUnion({ code: 'c1' })).resolves.toBe('uu-1')
    const openOnly = wechatVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ access_token: 't', openid: 'od-2' }))
    await expect(openOnly({ code: 'c2' })).resolves.toBe('od-2')
  })

  it('rejects missing codes and provider errors loudly', async () => {
    const verify = wechatVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ errcode: 40029, errmsg: 'invalid code' }))
    await expect(verify({})).rejects.toThrow(/missing/)
    await expect(verify({ code: 'bad' })).rejects.toThrow(/invalid code/)
  })

  it('enables only when env carries both credentials', () => {
    expect(wechatConfigFromEnv({})).toBeUndefined()
    expect(wechatConfigFromEnv({ WECHAT_APP_ID: 'a' })).toBeUndefined()
    expect(wechatConfigFromEnv({ WECHAT_APP_ID: 'a', WECHAT_APP_SECRET: 'b' })).toEqual({ appId: 'a', appSecret: 'b' })
  })
})
