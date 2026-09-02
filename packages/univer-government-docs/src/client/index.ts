import type { Context } from '@deepseek-ai/cordis'

const FONT_QUERY = 'dshFonts'
const FONTS = [
  { family: '方正小标宋简体', file: 'FZXiaoBiaoSong.ttf' },
  { family: 'FangSong_GB2312', file: 'FangSongGB2312.ttf' },
  { family: 'KaiTi_GB2312', file: 'KaiTiGB2312.ttf' },
  { family: 'SimHei', file: 'SimHei.ttf' },
] as const

export const name = 'univer-government-document-fonts'

/** Add bundled font resources to each Office viewer URL before its first layout. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const frames = new Map<HTMLIFrameElement, () => void>()
    const prepare = (frame: HTMLIFrameElement) => {
      if (frame.src === '') return
      const url = new URL(frame.src)
      if (!url.searchParams.has('file') || url.searchParams.has(FONT_QUERY)) return
      url.searchParams.set(FONT_QUERY, JSON.stringify(FONTS.map(font => ({
        family: font.family,
        source: new URL('/univer-government-docs/fonts/' + font.file, window.location.origin).href,
      }))))
      frame.src = url.href
    }
    const attach = (frame: HTMLIFrameElement) => {
      if (frames.has(frame)) return
      const listener = () => prepare(frame)
      frames.set(frame, listener)
      frame.addEventListener('load', listener)
      prepare(frame)
    }
    const visit = (node: Node) => {
      if (!(node instanceof Element)) return
      if (node instanceof HTMLIFrameElement) attach(node)
      for (const frame of node.querySelectorAll('iframe')) attach(frame)
    }

    for (const frame of document.querySelectorAll('iframe')) attach(frame)
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) visit(node)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      for (const [frame, listener] of frames) frame.removeEventListener('load', listener)
    }
  }, 'univer-government-documents: browser fonts')
}
