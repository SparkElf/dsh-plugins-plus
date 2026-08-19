import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UserStore } from './store.ts'

function freshStore() {
  const file = join(mkdtempSync(join(tmpdir(), 'mbs-')), 'users.json')
  return new UserStore(file, '0123456789abcdef')
}

describe('user store', () => {
  it('issues and consumes email codes once', () => {
    const store = freshStore()
    const code = store.issueEmailCode('Dee@Example.com')
    expect(code).toMatch(/^\d{6}$/)
    store.consumeEmailCode('dee@example.com', code)
    expect(() => store.consumeEmailCode('dee@example.com', code)).toThrow(/invalid/)
    expect(() => store.issueEmailCode('not-an-email')).toThrow(/invalid email/)
  })

  it('logs in external providers and creates the user on first sight', () => {
    const store = freshStore()
    const token = store.loginExternal('wechat', 'wx-open-1')
    expect(store.userFor(token)).toBe('wechat:wx-open-1')
    const emailToken = store.loginExternal('email', 'dee@example.com')
    expect(store.userFor(emailToken)).toBe('email:dee@example.com')
    store.bind(token, 'ff00ff')
    expect(store.bridgeFor(token)).toBe('ff00ff')
  })

  it('persists across instances via the json file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mbs-')), 'users.json')
    writeFileSync(file, JSON.stringify({ users: {}, tokens: {}, codes: {} }))
    const first = new UserStore(file, '0123456789abcdef')
    first.loginExternal('email', 'carol@example.com')
    const second = new UserStore(file, '0123456789abcdef')
    expect(second.loginExternal('email', 'carol@example.com')).toBeTruthy()
  })
})
