/**
 * Zero-dependency user store: identities are email addresses or external
 * provider ids (WeChat), never passwords; HMAC session tokens; user-to-bridge
 * bindings; and short-lived email verification codes. Persisted as one JSON
 * document with atomic replacement.
 * @module @sparkelf/dsh-mobile-bridge-server/store
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One registered user record, keyed by provider plus external id. */
export interface UserRecord {
  key: string
  provider: string
  externalId: string
  bridge: string | null
}

/** One pending email verification code. */
interface CodeRecord {
  code: string
  expiresAt: number
}

/** Persisted store document. */
interface StoreDocument {
  users: Record<string, UserRecord>
  tokens: Record<string, string>
  codes: Record<string, CodeRecord>
}

/** Verification code lifetime in milliseconds. */
export const CODE_TTL_MS = 5 * 60_000

/** File-backed user/token store with atomic writes. */
export class UserStore {
  private doc: StoreDocument

  constructor(private file: string, private tokenSecret: string) {
    try {
      this.doc = JSON.parse(readFileSync(file, 'utf8')) as StoreDocument
    } catch {
      this.doc = { users: {}, tokens: {}, codes: {} }
    }
    this.doc.codes ??= {}
  }

  private save(): void {
    const tmp = join(this.file + '.tmp')
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private mintToken(key: string): string {
    const token = createHmac('sha256', this.tokenSecret).update(key + ':' + randomBytes(8).toString('hex')).digest('hex')
    this.doc.tokens[token] = key
    this.save()
    return token
  }

  /** Mint a six-digit verification code for one email, replacing any pending one. */
  issueEmailCode(email: string): string {
    const key = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) throw new Error('invalid email')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.doc.codes[key] = { code, expiresAt: Date.now() + CODE_TTL_MS }
    this.save()
    return code
  }

  /** Verify and consume one email code; wrong or expired codes fail loudly. */
  consumeEmailCode(email: string, code: string): void {
    const key = email.trim().toLowerCase()
    const pending = this.doc.codes[key]
    const expected = Buffer.from(pending?.code ?? '------')
    const attempt = Buffer.from(code.padEnd(6, '-'))
    const valid = pending !== undefined && pending.expiresAt > Date.now()
      && expected.length === attempt.length && timingSafeEqual(expected, attempt)
    if (!valid) throw new Error('invalid or expired code')
    delete this.doc.codes[key]
    this.save()
  }

  /** Log in through a verified identity, creating the user on first sight. */
  loginExternal(provider: string, externalId: string): string {
    const key = provider + ':' + externalId
    if (!this.doc.users[key]) {
      this.doc.users[key] = { key, provider, externalId, bridge: null }
    }
    return this.mintToken(key)
  }

  /** Resolve a session token to its user key. */
  userFor(token: string): string | undefined {
    return this.doc.tokens[token]
  }

  /** Bind a user to a bridge code. */
  bind(token: string, bridge: string): string {
    const key = this.userFor(token)
    if (!key) throw new Error('unknown token')
    this.doc.users[key].bridge = bridge.trim()
    this.save()
    return key
  }

  /** The bridge code a user is bound to. */
  bridgeFor(token: string): string | null {
    const key = this.userFor(token)
    return key ? this.doc.users[key].bridge : null
  }

  /** Stable fingerprint for integrity checks in tests. */
  fingerprint(): string {
    return createHash('sha256').update(JSON.stringify(this.doc)).digest('hex').slice(0, 12)
  }
}
