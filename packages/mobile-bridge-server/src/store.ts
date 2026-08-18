/**
 * Zero-dependency user store: scrypt-hashed credentials, HMAC session
 * tokens, and user-to-bridge bindings, persisted as one JSON document with
 * atomic replacement.
 * @module @sparkelf/dsh-mobile-bridge-server/store
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One registered user record. */
export interface UserRecord {
  name: string
  salt: string
  hash: string
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

  /** Register a new user; rejects duplicates and weak input loudly. */
  register(name: string, password: string): string {
    const key = name.trim()
    if (key.length < 2 || password.length < 8) throw new Error('name needs 2+ chars and password 8+')
    if (this.doc.users[key]) throw new Error('user already exists')
    const salt = randomBytes(8).toString('hex')
    this.doc.users[key] = { name: key, salt, hash: hashPassword(password, salt), bridge: null }
    this.save()
    return this.login(key, password)
  }

  /** Verify credentials and mint a session token. */
  login(name: string, password: string): string {
    const user = this.doc.users[name.trim()]
    if (!user) throw new Error('invalid credentials')
    const attempt = Buffer.from(hashPassword(password, user.salt), 'hex')
    const expected = Buffer.from(user.hash, 'hex')
    if (attempt.length !== expected.length || !timingSafeEqual(attempt, expected)) throw new Error('invalid credentials')
    const token = createHmac('sha256', this.tokenSecret).update(user.name + ':' + randomBytes(8).toString('hex')).digest('hex')
    this.doc.tokens[token] = user.name
    this.save()
    return token
  }

  /** Resolve a session token to its user name. */
  userFor(token: string): string | undefined {
    return this.doc.tokens[token]
  }

  /** Bind a user to a bridge code. */
  bind(token: string, bridge: string): string {
    const name = this.userFor(token)
    if (!name) throw new Error('unknown token')
    this.doc.users[name].bridge = bridge.trim()
    this.save()
    return name
  }

  /** The bridge code a user is bound to. */
  bridgeFor(token: string): string | null {
    const name = this.userFor(token)
    return name ? this.doc.users[name].bridge : null
  }

  /** Stable fingerprint for integrity checks in tests. */
  fingerprint(): string {
    return createHash('sha256').update(JSON.stringify(this.doc)).digest('hex').slice(0, 12)
  }
}
