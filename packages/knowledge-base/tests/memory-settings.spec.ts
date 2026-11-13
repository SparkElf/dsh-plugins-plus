import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTINGS_FILE,
  MemorySettingsStore,
} from '../src/memorySettings.ts'

const roots: string[] = []

async function tempUsersRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-settings-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemorySettingsStore', () => {
  it('defaults to paused for a user with no settings file', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(store.filePath('u1')).toBe(join(usersRoot, 'u1', MEMORY_SETTINGS_FILE))
    expect(await store.read('u1')).toEqual({ version: 1, memoryEnabled: false })
    expect(await store.read('u2')).toEqual({ ...DEFAULT_MEMORY_SETTINGS })
    expect(await store.isEnabled('u1')).toBe(false)
    // A read never creates a file.
    await expect(readFile(store.filePath('u1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips enable and pause atomically', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(await store.setEnabled('u1', true)).toEqual({ version: 1, memoryEnabled: true })
    expect(await store.read('u1')).toEqual({ version: 1, memoryEnabled: true })
    expect(await store.isEnabled('u1')).toBe(true)
    expect(JSON.parse(await readFile(store.filePath('u1'), 'utf8'))).toEqual({
      version: 1,
      memoryEnabled: true,
    })

    expect(await store.setEnabled('u1', false)).toEqual({ version: 1, memoryEnabled: false })
    expect(await store.isEnabled('u1')).toBe(false)
    expect(await readdir(join(usersRoot, 'u1'))).toEqual([MEMORY_SETTINGS_FILE])
  })

  it('treats malformed or shape-invalid files as paused, and repairs them on write', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)
    await mkdir(join(usersRoot, 'u1'), { recursive: true })

    await writeFile(store.filePath('u1'), '{not json', 'utf8')
    expect(await store.read('u1')).toEqual({ version: 1, memoryEnabled: false })

    await writeFile(store.filePath('u1'), '[]', 'utf8')
    expect(await store.isEnabled('u1')).toBe(false)

    await writeFile(store.filePath('u1'), '{"memoryEnabled":"yes"}', 'utf8')
    expect(await store.isEnabled('u1')).toBe(false)

    await store.setEnabled('u1', true)
    expect(await store.read('u1')).toEqual({ version: 1, memoryEnabled: true })
  })

  it('accepts a hand-written boolean without version but never silently enables on garbage', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)
    await mkdir(join(usersRoot, 'u1'), { recursive: true })

    await writeFile(store.filePath('u1'), '{"memoryEnabled":true}', 'utf8')
    expect(await store.isEnabled('u1')).toBe(true)

    await writeFile(store.filePath('u1'), '{"version":1,"memoryEnabled":false,"future":1}', 'utf8')
    expect(await store.isEnabled('u1')).toBe(false)
  })

  it('refuses unsafe user ids before touching the filesystem', async () => {
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)

    expect(() => store.filePath('../escape')).toThrow()
    await expect(store.read('../escape')).rejects.toThrow()
    await expect(store.setEnabled('../escape', true)).rejects.toThrow()
  })

  it('rejects an empty usersRoot and non-boolean values', async () => {
    expect(() => new MemorySettingsStore('')).toThrow()
    const usersRoot = await tempUsersRoot()
    const store = new MemorySettingsStore(usersRoot)
    await expect(store.setEnabled('u1', 'true' as never)).rejects.toThrow()
  })
})