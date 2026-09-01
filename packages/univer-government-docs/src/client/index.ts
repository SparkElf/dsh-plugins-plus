import type { Context } from '@deepseek-ai/cordis'

const MESSAGE_TYPE = 'dsh-univer/register-fonts'
const FONTS = [
  { family: '方正小标宋简体', file: 'FZXiaoBiaoSong.ttf' },
  { family: 'FangSong_GB2312', file: 'FangSongGB2312.ttf' },
  { family: 'KaiTi_GB2312', file: 'KaiTiGB2312.ttf' },
  { family: 'SimHei', file: 'SimHei.ttf' },
] as const

export const name = 'univer-government-document-fonts'

/** Send bundled font resources to each Office viewer as it loads. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const frames = new Map<HTMLIFrameElement, () => void>()
    const notify = (frame: HTMLIFrameElement) => {
      const target = frame.contentWindow
      if (target === null || frame.src === '') return
      target.postMessage({
        type: MESSAGE_TYPE,
        fonts: FONTS.map(font => ({
          family: font.family,
          source: new URL('/univer-government-docs/fonts/' + font.file, window.location.origin).href,
        })),
      }, new URL(frame.src).origin)
    }
    const attach = (frame: HTMLIFrameElement) => {
      if (frames.has(frame)) return
      const listener = () => notify(frame)
      frames.set(frame, listener)
      frame.addEventListener('load', listener)
      notify(frame)
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
