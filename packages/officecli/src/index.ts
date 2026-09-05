import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

const require = createRequire(import.meta.url)
const officecli = require('@officecli/officecli') as { binaryPath(): string }
const OFFICECLI_BINARY = officecli.binaryPath()

interface OfficeCliResult {
  stdout: string
  stderr: string
}

export const name = 'officecli'
export const inject = ['tools']

/** 在当前 Harness 进程世界执行官方 OfficeCLI argv，并保留其原始输出。 */
function runOfficeCli(command: string[], signal: AbortSignal): Promise<OfficeCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OFFICECLI_BINARY, command, {
      cwd: process.cwd(),
      env: process.env,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(`OfficeCLI exited with code ${String(code)}\n${stderr || stdout}`))
    })
  })
}

/** 注册单入口 OfficeCLI 工具；命令语义继续由官方二进制定义。 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'officecli',
    description: 'Run the official OfficeCLI binary to create, read, validate, and modify original DOCX, XLSX, or PPTX files. Pass a pre-split argv array without the leading officecli command. Before editing, call load_skill with word, excel, or pptx and use help for element schemas. Use absolute workspace file paths. Do not create HTML, PNG, PDF, or Univer preview copies. End a completed workflow with save and include each original file path in the final response.',
    parameters: {
      command: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'OfficeCLI argv, for example ["create", "/workspace/report.docx"] or ["validate", "/workspace/report.docx", "--json"].',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value.stdout, value.stderr].filter(Boolean).join('\n') || 'OfficeCLI completed.',
      }],
    },
    execute: async (args: { command: string[] }, exec: ToolRunContext) => {
      if (args.command.length === 0) throw new Error('officecli command requires at least one argv item')
      return await runOfficeCli(args.command, exec.signal)
    },
    presentCall: args => ({
      card: 'generic',
      title: 'OfficeCLI',
      kind: 'other',
      rawInput: { command: args.command },
    }),
  }))
}
