import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { quoteBlock, quoteOf, previewOf, QUOTE_BLOCK_TYPE } from '../src/client/quote.ts'

/**
 * 引用回复：消息带上"在回复哪一条"，渲染层据此画引用条。
 *
 * 引用的载体是消息 content 里的一个块：官方 envelope 之外的字段会被丢掉，而块能穿过去，
 * 且后端块类型是开放的（`{ type: string; ... }`），未知类型不会被校验拒绝。
 */
describe('引用块的读写', () => {
  const message = (content: unknown): { content: unknown } => ({ content })

  it('读回写进去的引用', () => {
    const block = quoteBlock('111', '只回答两个字：收到', 'DataOps Admin')
    expect(quoteOf(message([block]))).toEqual({
      messageId: '111',
      preview: '只回答两个字：收到',
      authorName: 'DataOps Admin',
    })
  })

  it('没有引用返回 undefined（不是空对象）', () => {
    // 空引用会在气泡上方画出一条空条，看起来像渲染故障。
    expect(quoteOf(message([{ type: 'text', text: '你好' }]))).toBe(undefined)
    expect(quoteOf(undefined)).toBe(undefined)
  })

  it('缺 messageId 或 preview 的引用被丢弃', () => {
    expect(quoteOf(message([{ type: QUOTE_BLOCK_TYPE, preview: '有预览没 id' }]))).toBe(undefined)
    expect(quoteOf(message([{ type: QUOTE_BLOCK_TYPE, messageId: '1' }]))).toBe(undefined)
  })

  it('多行预览压成一行', () => {
    const block = quoteBlock('1', '第一行\n\n第二行   多空格')
    const quote = quoteOf(message([block]))
    expect(quote?.preview).toBe('第一行 第二行 多空格')
  })

  it('过长的预览被截断并加省略号', () => {
    const block = quoteBlock('1', 'x'.repeat(400))
    const quote = quoteOf(message([block]))
    expect(quote?.preview.length).toBeLessThanOrEqual(120)
    expect(quote?.preview.endsWith('…')).toBe(true)
  })

  it('没有作者名时不写这个字段', () => {
    const block = quoteBlock('1', '内容')
    expect('authorName' in block).toBe(false)
  })
})

describe('取可引用文本', () => {
  it('只取 text 块，跳过图片', () => {
    // 图片没有可引用的话；给它塞占位符会把作者没写过的字放进回复里。
    expect(previewOf({ content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', src: 'blob:x' },
    ] })).toBe('看这张图')
  })

  it('没有 text 块时为空串', () => {
    expect(previewOf({ content: [{ type: 'image', src: 'blob:x' }] })).toBe('')
    expect(previewOf(undefined)).toBe('')
  })
})

describe('块类型在宿主与客户端之间一致', () => {
  it('两处定义的字符串相同', () => {
    // 宿主 bundle 与客户端 bundle 分开求值，同一个字符串写了两遍。
    // 不一致的后果是引用发出去了但没人画 —— 静默失效。
    const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const match = /const QUOTE_BLOCK_TYPE = '([^']+)'/.exec(host)
    expect(match?.[1]).toBe(QUOTE_BLOCK_TYPE)
  })
})

describe('纯文本消息', () => {
  it('content 是字符串时也能取到预览', () => {
    // 官方 composer 提交的纯文本消息，content 是字符串而不是块数组。
    // 只读数组会让每条普通消息的预览为空，引用按钮因此全部消失。
    expect(previewOf({ content: '只回答两个字：收到' })).toBe('只回答两个字：收到')
  })

  it('字符串里的多行与多余空格被压成一行', () => {
    expect(previewOf({ content: '第一行\n\n第二行   多空格' })).toBe('第一行 第二行 多空格')
  })

  it('字符串消息里没有引用块', () => {
    expect(quoteOf({ content: '普通消息' })).toBe(undefined)
  })
})
