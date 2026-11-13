/**
 * Per-user memory settings: whether personal memory learning is enabled.
 *
 * The product rule (design §22.2) is deliberately conservative:
 *
 * - a new user is **paused** (`memoryEnabled: false`), so no extraction starts
 *   until the user explicitly confirms the enable dialog;
 * - the switch is per user, not per session, and survives restarts;
 * - the file is local state under `<usersRoot>/<userId>/settings.json`, never
 *   knowledge content and never Git content;
 * - a missing or unreadable file is a valid "paused" answer, not an error. Only
 *   a filesystem permission failure is surfaced.
 *
 * The route/UI layer reads `read()` or `isEnabled()` and writes through
 * `setEnabled()`; every write is atomic (tmp + rename).
 *
 * @module @sparkelf/dsh-knowledge-base/memory-settings
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathSegment, writeFileAtomic } from './memoryBindings.ts'

/** File name inside one user's directory. */
export const MEMORY_SETTINGS_FILE = 'settings.json'

/** Persisted settings shape. */
export interface MemorySettings {
  version: 1
  /** `false` means paused: no new memories are learned. */
  memoryEnabled: boolean
}

/** The paused default for a user who has never confirmed the enable dialog. */
export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  version: 1,
  memoryEnabled: false,
})

/**
 * Atomic settings store over `<usersRoot>/<userId>/settings.json`.
 *
 * `read()` tolerates a corrupt file by returning the paused default; the next
 * `setEnabled()` rewrites it. This keeps the memory page usable after a partial
 * write or a hand-edited file instead of failing the whole route.
 */
export class MemorySettingsStore {
  private readonly usersRoot: string

  constructor(usersRoot: string) {
    if (typeof usersRoot !== 'string' || usersRoot.trim() === '') {
      throw new Error('memory-settings: usersRoot must be a non-empty path')
    }
    this.usersRoot = usersRoot
  }

  /** Absolute settings file for one user. */
  filePath(userId: string): string {
    assertPathSegment(userId, 'userId')
    return join(this.usersRoot, userId, MEMORY_SETTINGS_FILE)
  }

  /**
   * Read one user's settings.
   *
   * Missing, malformed, or schema-invalid content returns the paused default.
   * A file with a boolean `memoryEnabled` is accepted even if `version` is
   * missing, so an older/hand-written settings file does not silently turn
   * memory on (the boolean still decides).
   */
  async read(userId: string): Promise<MemorySettings> {
    let source: string
    try {
      source = await readFile(this.filePath(userId), 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return { ...DEFAULT_MEMORY_SETTINGS }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return { ...DEFAULT_MEMORY_SETTINGS }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_MEMORY_SETTINGS }
    }
    const memoryEnabled = (parsed as Record<string, unknown>).memoryEnabled
    if (typeof memoryEnabled !== 'boolean') return { ...DEFAULT_MEMORY_SETTINGS }
    return { version: 1, memoryEnabled }
  }

  /** Whether learning is enabled for this user (default `false`). */
  async isEnabled(userId: string): Promise<boolean> {
    return (await this.read(userId)).memoryEnabled
  }

  /**
   * Persist the enable/pause switch atomically.
   *
   * @returns the normalized settings actually written.
   */
  async setEnabled(userId: string, enabled: boolean): Promise<MemorySettings> {
    if (typeof enabled !== 'boolean') {
      throw new Error('memory-settings: memoryEnabled must be a boolean')
    }
    const settings: MemorySettings = { version: 1, memoryEnabled: enabled }
    await writeFileAtomic(
      this.filePath(userId),
      `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 },
    )
    return settings
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}