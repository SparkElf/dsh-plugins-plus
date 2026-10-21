import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 待发送引用的本地状态。
 *
 * 关键区分：`clear` 同时清宿主（用户取消），`clearLocal` 只清本地（已提交，宿主还要用）。
 * 两者混淆过一次：提交时发了 DELETE，宿主在消息发布前就把引用删了，那条回复发出去没有引用。
 */
vi.mock('../src/client/api.ts', () => ({
  registerQuote: vi.fn(() => Promise.resolve({ ok: true })),
  clearQuote: vi.fn(() => Promise.resolve({ ok: true })),
}))

const { createQuoteStore } = await import('../src/client/quote.ts')
const api = await import('../src/client/api.ts')

const aQuote = (roomId: string) => ({ roomId, messageId: 'm-1', preview: '内容', authorName: '张三' })

describe('引用 store', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('登记后能读回，并通知订阅者', () => {
    const store = createQuoteStore()
    const seen = vi.fn()
    store.subscribe(seen)
    store.start(aQuote('r-1'))
    expect(store.getQuote('r-1')?.messageId).toBe('m-1')
    expect(seen).toHaveBeenCalled()
  })

  it('登记时把引用发给宿主（宿主才是挂载引用的一方）', () => {
    const store = createQuoteStore()
    store.start(aQuote('r-1'))
    expect(api.registerQuote).toHaveBeenCalledTimes(1)
  })

  it('按房间隔离：另一个房间读不到', () => {
    const store = createQuoteStore()
    store.start(aQuote('r-1'))
    expect(store.getQuote('r-2')).toBe(undefined)
  })

  it('clear 会通知宿主删除', () => {
    const store = createQuoteStore()
    store.start(aQuote('r-1'))
    store.clear('r-1')
    expect(store.getQuote('r-1')).toBe(undefined)
    expect(api.clearQuote).toHaveBeenCalledWith('r-1')
  })

  it('clearLocal 只清本地，不碰宿主', () => {
    // 提交时宿主还要用这份引用去挂载消息，删了它回复就是裸的。
    const store = createQuoteStore()
    store.start(aQuote('r-1'))
    vi.clearAllMocks()
    store.clearLocal('r-1')
    expect(store.getQuote('r-1')).toBe(undefined)
    expect(api.clearQuote).not.toHaveBeenCalled()
  })

  it('清不存在或已清的房间不报错也不发请求', () => {
    const store = createQuoteStore()
    store.clearLocal('nothing')
    store.clear('nothing')
    expect(api.clearQuote).not.toHaveBeenCalled()
  })
})
