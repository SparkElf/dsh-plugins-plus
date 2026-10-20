/**
 * Convert an uploaded document into Markdown so its text becomes greppable.
 *
 * The knowledge tree doubles as a document store and as what an agent greps. A
 * `.docx` on disk is neither: its bytes answer no query. Every upload therefore
 * lands twice — the original, byte for byte, plus a `.md` sibling holding the
 * extracted text — so a reader can still open the real file while a search sees
 * the words inside it.
 *
 * Extraction is delegated rather than implemented here. Three authorities
 * already exist in this deployment and each owns one format family:
 *
 * - MinerU (`/file_parse`) parses PDF and office documents with layout models.
 *   It is the best answer for a scanned PDF and the one authority that can
 *   recognise tables inside one.
 * - LibreOffice converts the legacy binary formats (`.doc`, `.xls`, `.ppt`) that
 *   MinerU and the Python readers refuse.
 * - `python-docx` / `openpyxl` / `python-pptx` / `pypdf` read the modern formats
 *   directly, without a service round trip.
 *
 * None of them is reimplemented in TypeScript: a `.docx` is a ZIP of XML and a
 * second parser would only disagree with the first. This module decides WHICH
 * authority to ask and what to do when it cannot answer, which is the part that
 * is specific to this plugin.
 *
 * A failed extraction never fails the upload. The original is already written and
 * remains the source of truth; the caller learns that no `.md` was produced, and
 * the file stays readable through the original.
 *
 * @module @sparkelf/dsh-knowledge-base/extract
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** Formats whose text this module knows how to extract. */
export const EXTRACTABLE_EXTENSIONS = [
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx',
  '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
  '.rtf',
] as const

/** One extractable extension. */
export type ExtractableExtension = typeof EXTRACTABLE_EXTENSIONS[number]

/** How one request to the extraction authorities ended. */
export interface ExtractResult {
  /** Markdown text, when extraction produced any. */
  markdown?: string
  /** Which authority answered. Reported so a bad conversion can be traced. */
  via?: 'mineru' | 'libreoffice' | 'python' | 'native'
  /** Why no markdown was produced. Present whenever {@link markdown} is absent. */
  reason?: string
}

/** Time one extraction may take before it is abandoned. */
const EXTRACT_TIMEOUT_MS = 180_000

/**
 * Whether this path names a document worth extracting.
 *
 * Compared case-insensitively because a browser reports the extension as the
 * user typed it, and a `.PDF` is the same format as a `.pdf`.
 *
 * @param relPath - the uploaded path, relative to the knowledge root.
 * @returns true when {@link extractDocument} has an authority for it.
 */
export function isExtractable(relPath: string): boolean {
  const ext = extname(relPath).toLowerCase()
  return (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * The Markdown sibling an extracted document lands beside.
 *
 * Appending rather than replacing the extension keeps two same-named uploads
 * from colliding: `报告.docx` becomes `报告.docx.md`, so it cannot overwrite a
 * `报告.md` the user wrote by hand.
 *
 * @param relPath - the uploaded document's path.
 * @returns the markdown path to write.
 */
export function markdownSiblingOf(relPath: string): string {
  return relPath + '.md'
}

/**
 * Whether MinerU should be asked before the local readers.
 *
 * PDF only: a PDF carries no recoverable structure beyond its layout, which is
 * exactly what MinerU models. An office document still has its XML, and the
 * direct readers keep more of it (a spreadsheet's cell grid survives
 * `openpyxl` and is flattened by a layout parser).
 *
 * @param ext - lowercased extension including the dot.
 * @returns true when the remote parser is the better authority.
 */
export function prefersRemoteParser(ext: string): boolean {
  return ext === '.pdf'
}

/** Run one command and collect its stdout. */
function run(command: string, args: readonly string[], timeoutMs = EXTRACT_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: 'spawn failed' }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
  })
}

/** Trim trailing blank lines so a trailing newline is not counted as content. */
function tidy(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Wrap a converted document body in a heading that names its origin. */
function withHeader(title: string, body: string, via: ExtractResult['via']): string {
  const source = via === undefined ? '' : `\n\n<!-- extracted via ${via} -->`
  return `# ${title}\n\n${body}${source}\n`
}

/**
 * Ask MinerU to parse one file and return its Markdown.
 *
 * The service answers with a task handle for large files and the body directly
 * for small ones, so both shapes are accepted. A non-200 answer is a miss, not
 * a failure of the upload.
 *
 * @param baseUrl - MinerU service base URL, without a trailing slash.
 * @param fullPath - absolute path of the document on this host.
 * @param fileName - name to report to the service.
 * @returns the Markdown, or undefined when the service could not parse it.
 */
async function viaMineru(baseUrl: string, fullPath: string, fileName: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(fullPath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName)
    const response = await fetch(baseUrl + '/file_parse', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = await response.json() as Record<string, unknown>
    // Direct answer: { markdown: "…" } or { md_content: "…" }.
    for (const key of ['markdown', 'md_content', 'mdContent']) {
      const value = body[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    // Task answer: poll the result route.
    const taskId = typeof body.task_id === 'string' ? body.task_id
      : (typeof body.taskId === 'string' ? body.taskId : undefined)
    if (taskId === undefined) return undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const poll = await fetch(baseUrl + '/tasks/' + encodeURIComponent(taskId) + '/result', {
        signal: AbortSignal.timeout(30_000),
      })
      if (!poll.ok) continue
      const result = await poll.json() as Record<string, unknown>
      for (const key of ['markdown', 'md_content', 'mdContent', 'content']) {
        const value = result[key]
        if (typeof value === 'string' && value.trim() !== '') return value
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Convert an office document to text with LibreOffice, for the legacy formats. */
async function viaLibreOffice(fullPath: string, ext: string, scratch: string): Promise<string | undefined> {
  // `--convert-to txt` covers writer/calc/impress documents; the filter name is
  // version-dependent, so the plain format word is what is asked for.
  const converted = await run('soffice', [
    '--headless', '--norestore', '--invisible',
    '--convert-to', 'txt:Text (encoded):UTF8',
    '--outdir', scratch, fullPath,
  ])
  if (converted.code !== 0) {
    // Calc and Impress need their own filter; retry with the generic name.
    const retry = await run('soffice', ['--headless', '--norestore', '--convert-to', 'txt', '--outdir', scratch, fullPath])
    if (retry.code !== 0) return undefined
  }
  const produced = basename(fullPath, ext) + '.txt'
  try {
    const text = await readFile(join(scratch, produced), 'utf8')
    return text.trim() === '' ? undefined : text
  } catch {
    // LibreOffice sometimes writes a different extension; take the only file.
    const entries = await readdir(scratch).catch(() => [] as string[])
    if (entries.length !== 1) return undefined
    const text = await readFile(join(scratch, entries[0] as string), 'utf8').catch(() => '')
    return text.trim() === '' ? undefined : text
  }
}

/** Read the modern formats directly, without a service round trip. */
async function viaPython(fullPath: string, ext: string): Promise<string | undefined> {
  const script = PYTHON_READERS[ext]
  if (script === undefined) return undefined
  const result = await run('python3', ['-c', script, fullPath])
  if (result.code !== 0) return undefined
  const text = result.stdout.trim()
  return text === '' ? undefined : text
}

/**
 * One reader per modern format, as a `python3 -c` program.
 *
 * Each takes the file path as argv[1] and prints Markdown. They are kept tiny and
 * separate so a missing library only disables its own format.
 */
const PYTHON_READERS: Readonly<Record<string, string>> = {
  '.docx': `import sys, docx
d = docx.Document(sys.argv[1])
out = []
for p in d.paragraphs:
    t = p.text.strip()
    if t:
        style = (p.style.name or '').lower()
        if style.startswith('heading'):
            level = ''.join(ch for ch in style if ch.isdigit()) or '2'
            out.append('#' * min(int(level) + 1, 6) + ' ' + t)
        else:
            out.append(t)
for i, table in enumerate(d.tables):
    out.append('')
    for row in table.rows:
        cells = [c.text.strip().replace('\\n', ' ') for c in row.cells]
        out.append('| ' + ' | '.join(cells) + ' |')
        if row is table.rows[0]:
            out.append('|' + '---|' * len(cells))
print('\\n'.join(out))`,
  '.xlsx': `import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
out = []
for ws in wb.worksheets:
    out.append('## ' + ws.title)
    out.append('')
    for row in ws.iter_rows(values_only=True):
        cells = ['' if c is None else str(c) for c in row]
        if any(c.strip() for c in cells):
            out.append('| ' + ' | '.join(cells) + ' |')
    out.append('')
print('\\n'.join(out))`,
  '.pptx': `import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
out = []
for i, slide in enumerate(prs.slides, 1):
    out.append('## Slide ' + str(i))
    out.append('')
    for shape in slide.shapes:
        if shape.has_text_frame:
            t = shape.text_frame.text.strip()
            if t:
                out.append(t)
    out.append('')
print('\\n'.join(out))`,
  '.pdf': `import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
out = []
for i, page in enumerate(reader.pages, 1):
    t = (page.extract_text() or '').strip()
    if t:
        out.append('<!-- page ' + str(i) + ' -->')
        out.append(t)
        out.append('')
print('\\n'.join(out))`,
}

/** Services and commands extraction may use, as configured for this deployment. */
export interface ExtractOptions {
  /** MinerU base URL. Empty disables the remote parser. */
  mineruUrl?: string
}

/**
 * Extract one document to Markdown.
 *
 * Authorities are tried in an order that puts the best answer first for each
 * format, and every step degrades to the next rather than failing: a PDF whose
 * MinerU call times out still gets `pypdf`'s text layer.
 *
 * @param fullPath - absolute path of the written document.
 * @param relPath - the same document's knowledge-relative path, for the title.
 * @param options - services this deployment exposes.
 * @returns the Markdown and the authority that produced it, or the reason none did.
 */
export async function extractDocument(fullPath: string, relPath: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const ext = extname(relPath).toLowerCase()
  if (!isExtractable(relPath)) return { reason: 'unsupported-extension' }
  const attempts: string[] = []
  const title = basename(relPath)

  // The remote parser first where it is the better authority, but only when a
  // service is configured: an unreachable one must not delay every upload.
  if (prefersRemoteParser(ext) && options.mineruUrl !== undefined && options.mineruUrl !== '') {
    const remote = await viaMineru(options.mineruUrl, fullPath, title)
    if (remote !== undefined) return { markdown: withHeader(title, tidy(remote), 'mineru'), via: 'mineru' }
    attempts.push('mineru')
  }

  // The legacy binary formats have no Python reader, and a text converter is the
  // only thing that understands them.
  if (LEGACY_EXTENSIONS.has(ext)) {
    const scratch = await mkdtemp(join(tmpdir(), 'kb-extract-'))
    try {
      const text = await viaLibreOffice(fullPath, ext, scratch)
      if (text !== undefined) return { markdown: withHeader(title, tidy(text), 'libreoffice'), via: 'libreoffice' }
      attempts.push('libreoffice')
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  } else {
    const direct = await viaPython(fullPath, ext)
    if (direct !== undefined) return { markdown: withHeader(title, tidy(direct), 'python'), via: 'python' }
    attempts.push('python')
    // A modern format the direct reader could not open still has LibreOffice as a
    // fallback: a corrupt-but-openable file is better read than skipped.
    const scratch = await mkdtemp(join(tmpdir(), 'kb-extract-'))
    try {
      const text = await viaLibreOffice(fullPath, ext, scratch)
      if (text !== undefined) return { markdown: withHeader(title, tidy(text), 'libreoffice'), via: 'libreoffice' }
      attempts.push('libreoffice')
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { reason: 'no-extractor-succeeded: ' + attempts.join(',') }
}

/** Formats with no modern reader, which LibreOffice is the only authority for. */
const LEGACY_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.rtf', '.odt', '.ods', '.odp'])

/**
 * Whether a file exists and is a regular file.
 *
 * @param path - absolute path to test.
 * @returns true when it is there.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Write extracted markdown beside its document.
 *
 * Kept separate from {@link extractDocument} so the write is testable without an
 * extraction service.
 *
 * @param markdownPath - absolute path of the `.md` sibling.
 * @param markdown - the text to write.
 */
export async function writeExtractedMarkdown(markdownPath: string, markdown: string): Promise<void> {
  await writeFile(markdownPath, markdown, 'utf8')
}
