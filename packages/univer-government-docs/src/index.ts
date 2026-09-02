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

// Remove this narrow compile bridge when registerTemplateRoot ships in the Office public types.
interface UniverTemplateRootService {
  registerTemplateRoot(registration: { readonly root: string }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    univer: UniverTemplateRootService
  }
}

const PROVIDER_NAME = 'univer-government-docs'
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TEMPLATE_ROOT = fileURLToPath(new URL('../assets/templates/', import.meta.url))
const SKILL_FILE = new URL('../skills/univer-government-docs/SKILL.md', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const FONT_ROUTES = [
  { file: 'FZXiaoBiaoSong.ttf', path: '/univer-government-docs/fonts/FZXiaoBiaoSong.ttf' },
  { file: 'FangSongGB2312.ttf', path: '/univer-government-docs/fonts/FangSongGB2312.ttf' },
  { file: 'KaiTiGB2312.ttf', path: '/univer-government-docs/fonts/KaiTiGB2312.ttf' },
  { file: 'SimHei.ttf', path: '/univer-government-docs/fonts/SimHei.ttf' },
] as const

const candidate: SkillCandidate = {
  name: 'univer-government-docs',
  description: 'Create and edit native Traditional Chinese government documents from bundled general-government and official redhead Univer templates. Load univer and univer-doc first; use this Skill for government document structure, style roles, redhead anchors, fonts, pagination, screenshots, and DOCX export.',
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

export const name = 'univer-government-documents'
export const inject = ['univer', 'skills', 'webServer']

/** Register templates, exact font assets, and their model instructions for this plugin fiber. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.univer.registerTemplateRoot({ root: TEMPLATE_ROOT }),
    'univer-government-documents: template root',
  )
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
    }), 'univer-government-documents: ' + font.file)
  }
}
