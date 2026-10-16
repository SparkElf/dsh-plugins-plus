/**
 * The wrapper's two silent failure modes, asserted by rendering it.
 *
 * `message-side.test.ts` covers the placement decision, and `client-ui.test.ts` covers the
 * shape of the registration source. Neither can catch the two defects this file exists for,
 * because both are invisible in the source and only appear when React actually renders:
 *
 * - The official view is a `React.memo` component, which compiles to a non-callable object.
 *   Calling it as a plain function throws at render time — every user message in every
 *   Session, including ordinary ones, becomes a crash face.
 * - The account id is fetched after the first paint. If it is captured when the renderer is
 *   registered rather than read as a snapshot, it stays `undefined` for the life of the page
 *   and no message is ever placed on the operator's side.
 *
 * Both are asserted here by rendering `MessageSide` for real, with `react-dom/server`.
 */
import { describe, expect, it } from 'vitest'
import { createElement, memo, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageSide, messageSide, type MessageSideProps } from '../src/client/MessageSide.tsx'

const SELF = 'user-self'

/**
 * Stand-in for the official `user` node view.
 *
 * `memo` is the load-bearing detail: it is what the real `UserMessageNodeView` is wrapped
 * in, and what makes a direct function call throw.
 */
const Official = memo(function Official({ t }: { t: (key: string) => string }): ReactNode {
  return createElement('div', { className: 'official-bubble' }, t('copy'))
})

/** A translator, standing in for the `chat` namespace seat. */
const t = (key: string): string => `T:${key}`

/** Render one node through the wrapper, with identity held in a mutable cell. */
const render = (options: {
  source?: unknown
  selfId?: string | undefined
}): string => {
  const props = {
    node: { data: { source: options.source } },
    Official,
    getSelfId: () => options.selfId,
    subscribeSelf: () => () => {},
    sided: true,
    t,
  } as unknown as MessageSideProps
  return renderToStaticMarkup(createElement(MessageSide, props))
}

describe('气泡分侧渲染', () => {
  it('渲染官方渲染器时创建元素，而不是把它当函数调用', () => {
    // A direct call would throw `Official is not a function`; rendering proves the wrapper
    // creates an element, which is also what preserves the official component's Hooks and
    // memoization.
    const html = render({ source: { roomId: 'room-1', memberId: SELF, authorKind: 'human' }, selfId: SELF })
    expect(html).toContain('official-bubble')
  })

  it('官方渲染器仍然收到 t', () => {
    // The seat supplies `t` from the namespace the registration declares. If the wrapper
    // dropped or shadowed it, the bubble would print raw keys.
    const html = render({ source: { roomId: 'room-1', memberId: SELF, authorKind: 'human' }, selfId: SELF })
    expect(html).toContain('T:copy')
  })

  it('普通会话的消息不加任何包裹元素', () => {
    // Acceptance criterion ④: an ordinary Session renders exactly the official markup, with
    // no placement wrapper and no data attribute.
    const html = render({ source: { kind: 'user', rpcId: 'rpc-1' }, selfId: SELF })
    expect(html).toContain('official-bubble')
    expect(html).not.toContain('data-group-chat-side')
  })

  it('自己的消息留在右侧（不包裹）', () => {
    const html = render({ source: { roomId: 'room-1', memberId: SELF, authorKind: 'human' }, selfId: SELF })
    expect(html).not.toContain('data-group-chat-side')
  })

  it('其他成员的消息包上分侧标记', () => {
    const html = render({ source: { roomId: 'room-1', memberId: 'someone-else', authorKind: 'human' }, selfId: SELF })
    expect(html).toContain('data-group-chat-side="other"')
    expect(html).toContain('official-bubble')
  })

  it('身份后到时仍按快照决定，而不是停在未知', () => {
    // The identity cell changes between the two renders below, exactly as the store does when
    // the fetch resolves. A captured value would produce `other` both times.
    const source = { roomId: 'room-1', memberId: SELF, authorKind: 'human' }
    expect(render({ source, selfId: undefined })).toContain('data-group-chat-side="other"')
    expect(render({ source, selfId: SELF })).not.toContain('data-group-chat-side')
  })

  it('官方渲染器不可用时渲染空，而不是抛错', () => {
    const props = {
      node: { data: { source: { roomId: 'room-1', memberId: 'x', authorKind: 'human' } } },
      Official: undefined,
      getSelfId: () => SELF,
      subscribeSelf: () => () => {},
      sided: true,
    } as unknown as MessageSideProps
    expect(renderToStaticMarkup(createElement(MessageSide, props))).toBe('')
  })
})

describe('messageSide 与渲染结果一致', () => {
  it('同一个判定既决定包裹，也决定朝向', () => {
    // The pure decision and the component must not drift: whatever `messageSide` says is
    // `other` is exactly what gets wrapped.
    const other = { roomId: 'room-1', memberId: 'someone-else', authorKind: 'human' }
    expect(messageSide({ source: other }, SELF)).toBe('other')
    expect(render({ source: other, selfId: SELF })).toContain('data-group-chat-side="other"')
  })
})
