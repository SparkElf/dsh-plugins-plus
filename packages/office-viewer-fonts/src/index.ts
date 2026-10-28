import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
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
  { file: 'Calibri.ttf', path: '/office-viewer-fonts/Calibri.ttf' },
  { file: 'Calibri-Bold.ttf', path: '/office-viewer-fonts/Calibri-Bold.ttf' },
  { file: 'Calibri-Italic.ttf', path: '/office-viewer-fonts/Calibri-Italic.ttf' },
  { file: 'Calibri-BoldItalic.ttf', path: '/office-viewer-fonts/Calibri-BoldItalic.ttf' },
  { file: 'Calibri-Light.ttf', path: '/office-viewer-fonts/Calibri-Light.ttf' },
  { file: 'Calibri-LightItalic.ttf', path: '/office-viewer-fonts/Calibri-LightItalic.ttf' },
] as const

/**
 * Split a skill file into its frontmatter fields and body.
 *
 * The description is read here rather than kept as a constant: a copy in code drifts
 * from the file the model actually receives, and the panel would then show text that
 * no edit to SKILL.md can change. The body excludes the frontmatter so the model does
 * not receive YAML it was never meant to see.
 *
 * @param raw - the SKILL.md contents.
 * @returns the frontmatter block and the body below it; the block is empty without frontmatter.
 */
function splitFrontmatter(raw: string): { front: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) return { front: '', body: raw }
  return { front: match[1] ?? '', body: raw.slice(match[0].length) }
}

/**
 * Read one frontmatter field.
 *
 * @param front - the frontmatter block, without its delimiters.
 * @param key - the field name.
 * @returns the unquoted value, or undefined when absent.
 */
function frontmatterField(front: string, key: string): string | undefined {
  const line = new RegExp('^\\s*' + key + '\\s*:\\s*(.+?)\\s*$', 'mu').exec(front)
  return line?.[1]?.replace(/^['"]|['"]$/gu, '')
}

const description = frontmatterField(splitFrontmatter(readFileSync(SKILL_FILE, 'utf8')).front, 'description')
if (description === undefined) throw new Error('office-government-docs SKILL.md frontmatter has no description')

const candidate: SkillCandidate = {
  name: 'office-government-docs',
  description,
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
      content: splitFrontmatter(await readFile(SKILL_FILE, 'utf8')).body.trim(),
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
