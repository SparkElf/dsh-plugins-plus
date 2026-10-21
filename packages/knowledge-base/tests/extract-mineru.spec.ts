import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractDocument } from '../src/extract.ts'

/**
 * These tests pin the request MinerU actually receives.
 *
 * The shape is not cosmetic: MinerU 4.x parses the multipart body with
 * `max_fields=0`, so any form field beyond `files` is rejected with
 * "Too many fields. Maximum number of fields is 0.", and it reads every option from
 * the query string. A regression here does not throw -- the extractor degrades to
 * "no text" and every uploaded PDF silently stops being searchable -- which is
 * exactly why the field names are asserted rather than the extracted string alone.
 */

const scratchDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(scratchDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Write a tiny file and return its absolute path. */
async function fixture(name: string, bytes: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-extract-'))
  scratchDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, bytes)
  return path
}

type Captured = { url: URL; init: RequestInit }

/** A 4.x synchronous result carrying the text inline. */
function mineruResult(markdown: string): Response {
  return new Response(JSON.stringify({
    task_id: 'job-1',
    status: 'completed',
    tier: 'basic',
    files: [{
      name: 'report.pdf',
      status: 'completed',
      parse: { duration_ms: 2026, parser_version: '4.0.12' },
      output_files: { markdown: { bytes: markdown.length } },
      content: { markdown },
    }],
  }), { headers: { 'content-type': 'application/json' } })
}

/** Run the extractor against a stubbed MinerU and capture what it sent. */
async function extractWithStub(respond: (url: URL) => Response): Promise<{ markdown: string | undefined; via: string | undefined; requests: Captured[] }> {
  const requests: Captured[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, init: init ?? {} })
    return respond(url)
  }))
  const path = await fixture('report.pdf', '%PDF fixture')
  const result = await extractDocument(path, 'report.pdf', { mineruUrl: 'http://mineru.test:8000' })
  return { markdown: result.markdown, via: result.via, requests }
}

describe('the MinerU extractor request contract', () => {
  it('sends exactly one multipart field named files', async () => {
    const { requests } = await extractWithStub(() => mineruResult('本报告说明值班流程与故障上报路径。'))

    const [request] = requests
    const form = request!.init.body as FormData
    // The whole point: `files`, and nothing else. A second field makes MinerU 4.x
    // answer 400 "Too many fields. Maximum number of fields is 0."
    expect([...form.keys()]).toEqual(['files'])
    expect((form.get('files') as File).name).toBe('report.pdf')
  })

  it('carries tier and output_formats as query parameters', async () => {
    const { requests } = await extractWithStub(() => mineruResult('本报告说明值班流程与故障上报路径。'))

    const [request] = requests
    // Named explicitly: an unnamed tier lets the server resolve `standard`, which
    // measured 17.8 s against 2.0 s for `basic` on the same one-page PDF.
    expect(request!.url.searchParams.get('tier')).toBe('basic')
    // `output_formats` has no server default, so a request without it is rejected.
    expect(request!.url.searchParams.getAll('output_formats')).toEqual(['markdown'])
    // `ocr_mode` replaced 3.4.x's `parse_method` form field.
    expect(request!.url.searchParams.get('ocr_mode')).toBe('auto')
  })

  it('posts to the 4.x /v1/file_parse route', async () => {
    const { requests } = await extractWithStub(() => mineruResult('本报告说明值班流程与故障上报路径。'))

    // 4.x mounts its routes on an APIRouter with prefix="/v1"; the root-level
    // /file_parse belongs to 3.4.x and cannot read this request.
    expect(requests[0]!.url.pathname).toBe('/v1/file_parse')
  })

  it('reads the text out of files[0].content.markdown', async () => {
    const { markdown, via } = await extractWithStub(() => mineruResult('本报告说明值班流程与故障上报路径，值班人员应在交接前完成巡检。'))

    expect(via).toBe('mineru')
    expect(markdown).toContain('值班人员应在交接前完成巡检')
  })

  it('asks for OCR on the retry, still through the query string', async () => {
    // A header-only first answer is what a mis-classified scan looks like; the
    // retry must differ ONLY in ocr_mode, not by adding a form field.
    let call = 0
    const { requests } = await extractWithStub(() => {
      call += 1
      return call === 1
        ? mineruResult('# 合同\n\n- 1 -')
        : mineruResult('合同正文：甲方向乙方采购设备，交付期为三十日。')
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]!.url.searchParams.get('ocr_mode')).toBe('auto')
    expect(requests[1]!.url.searchParams.get('ocr_mode')).toBe('ocr')
    for (const request of requests) expect([...(request.init.body as FormData).keys()]).toEqual(['files'])
  })

  it('degrades to the next authority when the server rejects the request', async () => {
    const { requests } = await extractWithStub(() => new Response(JSON.stringify({
      error: { code: 'invalid_request', message: 'Too many fields. Maximum number of fields is 0.' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))

    // A refused parse must not fail the upload: the extractor falls through to the
    // next authority (LibreOffice, then Python) and the original bytes stay the
    // deliverable. What matters here is that the MinerU rejection did not throw and
    // did not stop the chain -- there is exactly one MinerU attempt, then the
    // fallback takes over.
    expect(requests.filter(request => request.url.pathname === '/v1/file_parse')).toHaveLength(1)
  })
})
