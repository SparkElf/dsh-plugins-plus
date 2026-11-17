import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<{ stdout: string; stderr: string }>
}

const tools = new Map<string, RegisteredTool>()
const exec = { signal: new AbortController().signal }
let root = ''
let previousPacksDir: string | undefined

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'officecli-style-packs-test-'))
  for (const [name, bytes] of [['gbt9704-2012', 'GBT'], ['red-header', 'RED']] as const) {
    await mkdir(path.join(root, 'style-packs', name), { recursive: true })
    await writeFile(path.join(root, 'style-packs', name, 'template.docx'), bytes)
    await writeFile(path.join(root, 'style-packs', name, 'pack.json'), JSON.stringify({ title: name }))
  }
  previousPacksDir = process.env.OFFICECLI_STYLE_PACKS_DIR
  process.env.OFFICECLI_STYLE_PACKS_DIR = path.join(root, 'style-packs')
  apply({
    tools: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
      },
    },
  } as never)
})

afterAll(async () => {
  if (previousPacksDir === undefined) delete process.env.OFFICECLI_STYLE_PACKS_DIR
  else process.env.OFFICECLI_STYLE_PACKS_DIR = previousPacksDir
  await rm(root, { recursive: true, force: true })
})

describe('officecli-create style packs', () => {
  it('registers both tools', () => {
    expect([...tools.keys()].sort()).toEqual(['officecli', 'officecli-create'])
  })

  it('defaults to gbt9704-2012', async () => {
    const file = path.join(root, 'default.docx')
    const result = await tools.get('officecli-create')!.execute({ file }, exec)
    expect(result.stdout).toContain('style-pack: gbt9704-2012')
    expect(await readFile(file, 'utf8')).toBe('GBT')
  })

  it('switches pack with --style-pack', async () => {
    const file = path.join(root, 'red.docx')
    const result = await tools.get('officecli-create')!.execute({ file, style_pack: 'red-header' }, exec)
    expect(result.stdout).toContain('style-pack: red-header')
    expect(await readFile(file, 'utf8')).toBe('RED')
  })

  it('refuses to overwrite without force', async () => {
    const file = path.join(root, 'exists.docx')
    await writeFile(file, 'OLD')
    await expect(tools.get('officecli-create')!.execute({ file }, exec)).rejects.toThrow(/file exists/)
    expect(await readFile(file, 'utf8')).toBe('OLD')
  })

  it('overwrites with force', async () => {
    const file = path.join(root, 'force.docx')
    await writeFile(file, 'OLD')
    await tools.get('officecli-create')!.execute({ file, force: true }, exec)
    expect(await readFile(file, 'utf8')).toBe('GBT')
  })

  it('officecli create --force overwrites the default template', async () => {
    const file = path.join(root, 'tool-force.docx')
    await writeFile(file, 'OLD')
    await tools.get('officecli')!.execute({ command: ['create', file, '--force'] }, exec)
    expect(await readFile(file, 'utf8')).toBe('GBT')
  })

  it('rejects an unknown pack', async () => {
    await expect(tools.get('officecli-create')!.execute({ file: path.join(root, 'bad.docx'), style_pack: 'nope' }, exec))
      .rejects.toThrow(/unknown style pack/)
  })

  it('routes officecli create through the same default pack', async () => {
    const file = path.join(root, 'via-officecli.docx')
    const result = await tools.get('officecli')!.execute({ command: ['create', file] }, exec)
    expect(result.stdout).toContain('style-pack: gbt9704-2012')
    expect(await readFile(file, 'utf8')).toBe('GBT')
  })

  it('rejects --style-pack for non-docx output', async () => {
    await expect(tools.get('officecli')!.execute({ command: ['create', path.join(root, 'book.xlsx'), '--style-pack', 'gbt9704-2012'] }, exec))
      .rejects.toThrow(/only to \.docx/)
  })

  it('rejects --style-pack without a value', async () => {
    await expect(tools.get('officecli')!.execute({ command: ['create', path.join(root, 'novalue.docx'), '--style-pack'] }, exec))
      .rejects.toThrow(/requires a style pack name/)
  })

  it('lists installed style packs', async () => {
    const result = await tools.get('officecli-create')!.execute({ list: true }, exec)
    expect(result.stdout).toContain('gbt9704-2012')
    expect(result.stdout).toContain('red-header')
  })

  it('skips a pack directory without a template', async () => {
    await mkdir(path.join(root, 'style-packs', 'incomplete'), { recursive: true })
    const result = await tools.get('officecli-create')!.execute({ list: true }, exec)
    expect(result.stdout).not.toContain('incomplete')
  })
})