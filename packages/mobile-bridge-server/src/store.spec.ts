import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashPassword, UserStore } from './store.ts'

function freshStore() {
  const file = join(mkdtempSync(join(tmpdir(), 'mbs-')), 'users.json')
  return new UserStore(file, '0123456789abcdef')
}

describe('user store', () => {
  it('registers, logs in, and rejects bad passwords', () => {
    const store = freshStore()
    const token = store.register('alice', 'longpassword')
    expect(store.userFor(token)).toBe('password:alice')
    expect(() => store.login('alice', 'wrongpass')).toThrow(/invalid/)
    expect(() => store.register('alice', 'longpassword')).toThrow(/exists/)
    expect(() => store.register('x', 'short')).toThrow(/8\+/)
  })

  it('binds users to bridges and reports the binding', () => {
    const store = freshStore()
    const token = store.register('bob', 'longpassword')
    expect(store.bridgeFor(token)).toBeNull()
    store.bind(token, 'abc123')
    expect(store.bridgeFor(token)).toBe('abc123')
  })

  it('logs in external providers and creates the user on first sight', () => {
    const store = freshStore()
    const token = store.loginExternal('wechat', 'wx-open-1')
    expect(store.userFor(token)).toBe('wechat:wx-open-1')
    const again = store.loginExternal('wechat', 'wx-open-1')
    expect(store.userFor(again)).toBe('wechat:wx-open-1')
    store.bind(token, 'ff00ff')
    expect(store.bridgeFor(token)).toBe('ff00ff')
  })

  it('hashes deterministically per salt', () => {
    expect(hashPassword('pw', '00')).toBe(hashPassword('pw', '00'))
    expect(hashPassword('pw', '00')).not.toBe(hashPassword('pw', '01'))
  })

  it('persists across instances via the json file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mbs-')), 'users.json')
    writeFileSync(file, JSON.stringify({ users: {}, tokens: {} }))
    const first = new UserStore(file, '0123456789abcdef')
    first.register('carol', 'longpassword')
    const second = new UserStore(file, '0123456789abcdef')
    expect(second.login('carol', 'longpassword')).toBeTruthy()
  })
})
