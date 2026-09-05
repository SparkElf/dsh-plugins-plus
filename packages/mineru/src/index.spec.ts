import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MinerU from './index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('mineru_parse_pdf', () => {
  it('sends the uploaded path to MinerU and returns its Markdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mineru-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'report.pdf')
    await writeFile(filePath, '%PDF fixture')
    const archive = zipSync({
      'report/report.md': new TextEncoder().encode('# Parsed report'),
      'report/report_content_list.json': new TextEncoder().encode('[{"type":"text"}]'),
      'report/images/page-1.png': new Uint8Array([1, 2, 3]),
    })
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('return_md')).toBe('true')
      expect((form.get('files') as File).name).toBe('report.pdf')
      return new Response(archive)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(MinerU, { endpoint: 'http://mineru.test/file_parse' }).await()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'mineru-1' as never,
      name: 'mineru_parse_pdf',
      arguments: { file_path: filePath },
    })

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      sourcePath: filePath,
      markdown: '# Parsed report',
      contentList: '[{"type":"text"}]',
      images: ['report/images/page-1.png'],
    })
    expect(result.content).toEqual([{ type: 'text', text: `MinerU parsed ${filePath}.\n\n# Parsed report` }])
    expect(fetchMock).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
