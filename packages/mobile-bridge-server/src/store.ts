/**
 * Zero-dependency user store: scrypt-hashed password credentials or external
 * provider identities (the seam third-party logins such as WeChat plug into),
 * HMAC session tokens, and user-to-bridge bindings, persisted as one JSON
 * document with atomic replacement.
 * @module @sparkelf/dsh-mobile-bridge-server/store
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One registered user record, keyed by provider plus external id. */
export interface UserRecord {
  key: string
  provider: string
  externalId: string
  salt: string | null
  hash: string | null
  /** Bridge code this user is bound to, when paired. */
  bridge: string | null
}

/** Persisted store document. */
interface StoreDocument {
  users: Record<string, UserRecord>
  tokens: Record<string, string>
}

/** Hash one password with a salt for storage. */
export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex')
}

/** File-backed user/token store with atomic writes. */
export class UserStore {
  private doc: StoreDocument

  constructor(private file: string, private tokenSecret: string) {
    try {
      this.doc = JSON.parse(readFileSync(file, 'utf8')) as StoreDocument
    } catch {
      this.doc = { users: {}, tokens: {} }
    }
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

  /** Register a password user; rejects duplicates and weak input loudly. */
  register(name: string, password: string): string {
    const key = name.trim()
    if (key.length < 2 || password.length < 8) throw new Error('name needs 2+ chars and password 8+')
    if (this.doc.users['password:' + key]) throw new Error('user already exists')
    const salt = randomBytes(8).toString('hex')
    this.doc.users['password:' + key] = {
      key: 'password:' + key,
      provider: 'password',
      externalId: key,
      salt,
      hash: hashPassword(password, salt),
      bridge: null,
    }
    return this.mintToken('password:' + key)
  }

  /** Verify password credentials and mint a session token. */
  login(name: string, password: string): string {
    const user = this.doc.users['password:' + name.trim()]
    if (!user || !user.salt || !user.hash) throw new Error('invalid credentials')
    const attempt = Buffer.from(hashPassword(password, user.salt), 'hex')
    const expected = Buffer.from(user.hash, 'hex')
    if (attempt.length !== expected.length || !timingSafeEqual(attempt, expected)) throw new Error('invalid credentials')
    return this.mintToken(user.key)
  }

  /**
   * Log in through an external provider, creating the user on first sight.
   * The server only calls this after the provider verifier confirmed the
   * payload, so the external id is trusted here.
   * @param provider - provider kind (e.g. wechat).
   * @param externalId - provider-verified stable identity.
   * @returns a fresh session token.
   */
  loginExternal(provider: string, externalId: string): string {
    const key = provider + ':' + externalId
    if (!this.doc.users[key]) {
      this.doc.users[key] = { key, provider, externalId, salt: null, hash: null, bridge: null }
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
