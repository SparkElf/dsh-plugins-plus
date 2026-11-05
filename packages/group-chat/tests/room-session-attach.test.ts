import { describe, expect, it, vi } from 'vitest'
import { attachRoomSession } from '../src/session-maintenance.ts'

const DIRECTORY = '/workspace/outputs'
const SESSION = 'group-room-room-1'

/** A registry whose single workspace owns {@link DIRECTORY}. */
const registryFor = (attachSession: (sessionId: string) => Promise<void>, found = true) => ({
  resolveByPath: vi.fn(async (path: string) => {
    expect(path).toBe(DIRECTORY)
    return found ? { attachSession } : undefined
  }),
})

describe('attaching a room session to its workspace', () => {
  it('registers the session against the workspace that owns the room directory', async () => {
    const attach = vi.fn(async () => {})
    const registry = registryFor(attach)

    await expect(attachRoomSession(registry, DIRECTORY, SESSION)).resolves.toEqual({ attached: true })

    expect(registry.resolveByPath).toHaveBeenCalledWith(DIRECTORY)
    expect(attach).toHaveBeenCalledWith(SESSION)
  })

  it('is safe to run on every open: the registry owns the idempotence', async () => {
    const attach = vi.fn(async () => {})
    const registry = registryFor(attach)
    const log = { warn: vi.fn() }

    const first = await attachRoomSession(registry, DIRECTORY, SESSION, log)
    const second = await attachRoomSession(registry, DIRECTORY, SESSION, log)

    // Same session both times and nothing reported: `attachSession` checks membership before it
    // writes, so the poll cannot grow a second row for one room.
    expect(first.attached).toBe(true)
    expect(second.attached).toBe(true)
    expect(attach.mock.calls).toEqual([[SESSION], [SESSION]])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reports a host with no workspace registry instead of failing the open', async () => {
    const log = { warn: vi.fn() }

    await expect(attachRoomSession(undefined, DIRECTORY, SESSION, log)).resolves.toEqual({
      attached: false,
      reason: 'registry-unavailable',
    })
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('reports a room directory no workspace owns', async () => {
    const attach = vi.fn(async () => {})
    const log = { warn: vi.fn() }

    await expect(attachRoomSession(registryFor(attach, false), DIRECTORY, SESSION, log)).resolves.toEqual({
      attached: false,
      reason: 'workspace-not-found',
    })
    expect(attach).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('swallows an attach failure so the room still opens', async () => {
    const attach = vi.fn(async () => { throw new Error('registry write failed') })
    const log = { warn: vi.fn() }

    // The Host route stays usable and only the main view cannot follow; a throw here would take
    // the whole discovery pass down with it.
    await expect(attachRoomSession(registryFor(attach), DIRECTORY, SESSION, log)).resolves.toEqual({
      attached: false,
      reason: 'attach-failed',
    })
    expect(log.warn).toHaveBeenCalledOnce()
  })
})