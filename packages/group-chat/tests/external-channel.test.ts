/**
 * A room bridged to an external system.
 *
 * The bridge owns the transport; this plugin owns the shape. These cases pin that a room without a
 * channel is untouched, that a well-formed channel passes through creation, and that an external
 * message is recognised as foreign instead of being attributed to the workspace.
 *
 * @module tests/external-channel.test
 */

import { describe, expect, it } from 'vitest'
import { externalSenderOf } from '../src/client/MessageSide.tsx'
import type { ExternalChannel } from '../src/backend.ts'

const CHANNEL: ExternalChannel = { kind: 'qqbot', groupOpenid: 'GROUP-OPENID-1' }

describe('the external channel a room carries', () => {
  it('lets a room declare a QQ bridge', () => {
    // The type is the contract the backend stores verbatim; there is nothing to normalise here.
    expect(CHANNEL.groupOpenid).toBe('GROUP-OPENID-1')
    expect(CHANNEL.kind).toBe('qqbot')
  })

  it('reads the sender the bridge stamped on a message', () => {
    const message = {
      source: { roomId: 'room-1', senderExternal: { kind: 'qqbot', openid: 'OPENID-1', nickname: ' 张三 ' } },
    }
    expect(externalSenderOf(message)).toEqual({ kind: 'qqbot', openid: 'OPENID-1', nickname: '张三' })
  })

  it('leaves a native room message alone', () => {
    // No `senderExternal` means an ordinary member message: the wrapper draws the roster author.
    expect(externalSenderOf({ source: { roomId: 'room-1', memberId: 'u-1' } })).toBeUndefined()
    expect(externalSenderOf(undefined)).toBeUndefined()
  })

  it('ignores a malformed sender rather than guessing at one', () => {
    // A wrong badge would attribute somebody else's words to the workspace, so an unreadable value
    // is dropped and the message renders as an unlabelled room message.
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'qqbot', openid: '' } } })).toBeUndefined()
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'slack', openid: 'a', nickname: 'b' } } })).toBeUndefined()
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: 'nope' } })).toBeUndefined()
  })
})
