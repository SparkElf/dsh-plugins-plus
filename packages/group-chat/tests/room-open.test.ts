import { describe, expect, it, vi } from 'vitest'
import { createRoomStore } from '../src/client/store.ts'
import { ROOM_SESSION_PREFIX } from '../src/session-id.ts'

const ROOM = 'room-1'

/** The store the sidebar drives, with the catalog replaced by spies. */
const storeWith = (options: { openSession?: (sessionId: string) => void } = {}) =>
  createRoomStore({ openSession: options.openSession ?? (() => {}) })

describe('selecting a room shows its session', () => {
  it('opens the room\'s deterministic session, which is what moves the main view', () => {
    const openSession = vi.fn()
    const store = storeWith({ openSession })

    store.open(ROOM)

    // A room has exactly one Session and its id is the room id with a known prefix; selecting
    // that Session is what makes the main column follow the sidebar highlight.
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith(`${ROOM_SESSION_PREFIX}${ROOM}`)
    expect(store.getState().activeRoomId).toBe(ROOM)
    expect(store.getState().openFailure).toBeUndefined()
  })

  it('reuses the same session on every open instead of minting another', () => {
    const openSession = vi.fn()
    const store = storeWith({ openSession })

    store.open(ROOM)
    store.open(ROOM)

    // Same id twice: the store never creates, so a reader who switches away and back cannot
    // grow a second Session for one room.
    expect(openSession.mock.calls.map(([id]) => id)).toEqual([
      `${ROOM_SESSION_PREFIX}${ROOM}`,
      `${ROOM_SESSION_PREFIX}${ROOM}`,
    ])
  })

  it('asks the catalog even for a room the loaded page does not name', () => {
    const openSession = vi.fn()
    const store = storeWith({ openSession })

    store.open(ROOM)

    // The Catalog pages its list, so a room whose Session exists can be absent from the page in
    // hand; a pre-flight check would have refused a room that is really there.
    expect(openSession).toHaveBeenCalledWith(`${ROOM_SESSION_PREFIX}${ROOM}`)
    expect(store.getState().openFailure).toBeUndefined()
  })

  it('surfaces a selection the catalog refuses', () => {
    const store = storeWith({
      openSession: () => { throw new Error('catalog refused the selection') },
    })

    store.open(ROOM)

    expect(store.getState().openFailure).toBe('roomOpenFailed')
  })

  it('clears the notice on the next successful selection', () => {
    let refuse = true
    const store = storeWith({
      openSession: () => { if (refuse) throw new Error('catalog refused the selection') },
    })

    store.open(ROOM)
    expect(store.getState().openFailure).toBe('roomOpenFailed')

    refuse = false
    store.open(ROOM)
    expect(store.getState().openFailure).toBeUndefined()
  })
})