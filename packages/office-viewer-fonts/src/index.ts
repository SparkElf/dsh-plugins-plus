import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-host-webserver'

const PROVIDER_NAME = 'office-government-docs'
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SKILL_FILE = new URL('../skills/office-government-docs/SKILL.md', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const FONT_ROUTES = [
  { file: 'FZXiaoBiaoSong.ttf', path: '/office-viewer-fonts/FZXiaoBiaoSong.ttf' },
  { file: 'FangSongGB2312.ttf', path: '/office-viewer-fonts/FangSongGB2312.ttf' },
  { file: 'KaiTiGB2312.ttf', path: '/office-viewer-fonts/KaiTiGB2312.ttf' },
  { file: 'SimHei.ttf', path: '/office-viewer-fonts/SimHei.ttf' },
] as const

const candidate: SkillCandidate = {
  name: 'office-government-docs',
  description: 'Create and revise Chinese government DOCX, XLSX, and PPTX originals with OfficeCLI. Use for government-document hierarchy, page layout, redhead composition, official fonts, validation, and clickable original-file delivery.',
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: PACKAGE_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_FILE,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([candidate]),
  async get(): Promise<SkillDefinition> {
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      resourceBase: candidate.resourceBase,
      content: await readFile(SKILL_FILE, 'utf8'),
    }
  },
}

export const name = 'office-viewer-fonts'
export const inject = ['skills', 'webServer']

/** 注册 Office Viewer 字体资源与政务 OfficeCLI 工作流 Skill。 */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
  for (const font of FONT_ROUTES) {
    const file = fileURLToPath(new URL('../assets/fonts/' + font.file, import.meta.url))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: font.path,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET', 'content-length': '0' })
          response.end()
          return
        }
        const bytes = await readFile(file)
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': String(bytes.byteLength),
          'content-type': 'font/ttf',
        })
        response.end(bytes)
      },
    }), 'office-viewer-fonts: ' + font.file)
  }
}
