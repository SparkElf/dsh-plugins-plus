import type { Context } from '@deepseek-ai/cordis'

interface ViewerFontResource {
  readonly family: string
  readonly source: string
}

declare global {
  interface Window {
    __DSH_UNIVER_VIEWER_FONTS__?: readonly ViewerFontResource[]
  }
}

const FONT_ASSET_VERSION = '0.1.6'

const FONTS = [
  { family: '方正小标宋简体', file: 'FZXiaoBiaoSong.ttf' },
  { family: 'FangSong_GB2312', file: 'FangSongGB2312.ttf' },
  { family: 'KaiTi_GB2312', file: 'KaiTiGB2312.ttf' },
  { family: 'SimHei', file: 'SimHei.ttf' },
] as const

export const name = 'univer-government-document-fonts'

/** Register bundled font resources before Office creates Viewer iframe URLs. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const previous = window.__DSH_UNIVER_VIEWER_FONTS__
    const fonts = FONTS.map(font => {
      const source = new URL('/univer-government-docs/fonts/' + font.file, window.location.origin)
      source.searchParams.set('v', FONT_ASSET_VERSION)
      return { family: font.family, source: source.href }
    })
    window.__DSH_UNIVER_VIEWER_FONTS__ = fonts
    return () => {
      if (window.__DSH_UNIVER_VIEWER_FONTS__ !== fonts) return
      if (previous === undefined) delete window.__DSH_UNIVER_VIEWER_FONTS__
      else window.__DSH_UNIVER_VIEWER_FONTS__ = previous
    }
  }, 'univer-government-documents: browser fonts')
}
