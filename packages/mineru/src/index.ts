/** Model-facing MinerU PDF parser. */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { unzipSync } from 'fflate'

interface MinerUResult {
  sourcePath: string
  markdown: string
  contentList: string
  images: string[]
}

/** MinerU HTTP endpoint selected by the deployment. */
export interface Config {
  endpoint: string
}

/** MinerU configuration schema. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
})

/** Cordis plugin name. */
export const name = 'mineru'
/** The tool registry must exist before MinerU registers. */
export const inject = ['tools']

function parseArchive(sourcePath: string, archive: Uint8Array): MinerUResult {
  const entries = Object.entries(unzipSync(archive)).filter(([entry]) => !entry.endsWith('/'))
  const markdown = entries.find(([entry]) => entry.toLowerCase().endsWith('.md'))
  const contentList = entries.find(([entry]) => entry.toLowerCase().endsWith('_content_list.json'))
  if (markdown === undefined || contentList === undefined) {
    throw new Error('MinerU response does not contain Markdown and content-list output')
  }
  return {
    sourcePath,
    markdown: new TextDecoder().decode(markdown[1]),
    contentList: new TextDecoder().decode(contentList[1]),
    images: entries
      .filter(([entry]) => entry.split('/').includes('images'))
      .map(([entry]) => entry),
  }
}

async function parsePdf(endpoint: string, filePath: string, signal: AbortSignal): Promise<MinerUResult> {
  const data = await readFile(filePath, { signal })
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), basename(filePath))
  form.append('return_md', 'true')
  form.append('return_middle_json', 'false')
  form.append('return_model_output', 'false')
  form.append('return_content_list', 'true')
  form.append('return_images', 'true')
  form.append('response_format_zip', 'true')
  form.append('return_original_file', 'false')
  const response = await fetch(endpoint, { method: 'POST', body: form, signal })
  if (!response.ok) throw new Error(`MinerU returned HTTP ${response.status}`)
  return parseArchive(filePath, new Uint8Array(await response.arrayBuffer()))
}

/** Register the direct MinerU PDF parsing tool. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'mineru_parse_pdf',
    description: 'Parse a PDF with MinerU. Pass the exact read-only file path shown in the uploaded-file message. Use this for PDF text, tables, reading order, and OCR; use OfficeCLI for DOCX, XLSX, and PPTX files.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Exact PDF path from the uploaded-file message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourcePath: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
          contentList: { type: 'string', required: true },
          images: {
            type: 'array',
            items: { type: 'string' },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `MinerU parsed ${value.sourcePath}.\n\n${value.markdown}`,
      }],
    },
    isConcurrencySafe: () => true,
    execute: (args: { file_path: string }, exec: ToolRunContext) =>
      parsePdf(config.endpoint, args.file_path, exec.signal),
    presentCall: args => ({
      card: 'generic',
      title: `Parse ${basename(args.file_path)}`,
      kind: 'read',
      locations: [{ path: args.file_path }],
    }),
  }))
}
