/**
 * 拖放上传的判定逻辑。
 *
 * 这些用例只覆盖纯函数：目标行是否可接收、拖放落到哪个目录、路径怎么拼、重复目标怎么
 * 收敛、部分失败怎么说给用户听。它们能在没有 DOM 的 runner 里跑，因为模块本身不碰
 * `DataTransfer` / `FileList` / `document`（实测这三个在测试环境里都是 undefined）。
 *
 * 组件接线（真实 `dragover` / `drop` 事件）由 Playwright 在真机上验证，不在这一层。
 */
import { describe, expect, it } from 'vitest'
import {
  acceptsDrop,
  dedupeDropped,
  dropTargetPath,
  normalizeDropPath,
  planDrop,
  summarizeDrop,
  type DroppedFile,
  type DropTargetLike,
} from '../src/client/useFileDrop.ts'
import { canRetryExtraction, failureReason, shouldFoldStrip } from '../src/client/progressRules.ts'

/** A folder row that accepts drops. */
const dir = (relativePath: string, overrides: Partial<DropTargetLike> = {}): DropTargetLike => ({
  relativePath,
  isDirectory: true,
  drops: true,
  ...overrides,
})

/** One pending file; the byte source is irrelevant to the decisions under test. */
const entry = (relativePath: string): DroppedFile => ({ file: { name: relativePath }, relativePath })

/** A drop event carrying these files. */
const dropOf = (...paths: string[]): { hasFiles: boolean; files: DroppedFile[] } => ({
  hasFiles: paths.length > 0,
  files: paths.map(entry),
})

describe('a drop is accepted only by a folder that is open for drops', () => {
  it('accepts a folder row', () => {
    expect(acceptsDrop(dir('global'))).toBe(true)
    expect(acceptsDrop(dir(''))).toBe(true)
  })

  it('refuses a document row', () => {
    // Dropping onto a file has no destination. Accepting it and then picking a
    // directory on the reader's behalf would put the bytes somewhere they never
    // pointed at, so the row must refuse and say so.
    expect(acceptsDrop(dir('global/a.md', { isDirectory: false }))).toBe(false)
  })

  it('refuses while the surface is not accepting drops', () => {
    // An upload already running, or a caller without write access.
    expect(acceptsDrop(dir('global', { drops: false }))).toBe(false)
    // And a disabled document row is refused for both reasons.
    expect(acceptsDrop(dir('a.md', { isDirectory: false, drops: false }))).toBe(false)
  })

  it('refuses when the pointer is outside any row', () => {
    expect(acceptsDrop(undefined)).toBe(false)
  })
})

describe('a plan says what to upload, or exactly why nothing happens', () => {
  it('uploads into the folder under the pointer', () => {
    const plan = planDrop(dir('global/specs'), dropOf('a.md', 'b.md'))
    expect(plan).toEqual({
      kind: 'upload',
      directory: 'global/specs',
      files: [entry('a.md'), entry('b.md')],
    })
  })

  it('uploads into the root when the row is the knowledge root itself', () => {
    // The root row's path is `''`; joining it must not produce a leading separator,
    // which the server would reject as escaping the root.
    const plan = planDrop(dir(''), dropOf('a.md'))
    expect(plan).toEqual({ kind: 'upload', directory: '', files: [entry('a.md')] })
  })

  it('distinguishes "dropped on a document" from "dragged no files"', () => {
    // The two need different sentences, so they are different reasons rather than one
    // shared `undefined`.
    expect(planDrop(dir('global/a.md', { isDirectory: false }), dropOf('b.md')))
      .toEqual({ kind: 'refuse', reason: 'not-a-directory' })
    expect(planDrop(undefined, dropOf('b.md')))
      .toEqual({ kind: 'refuse', reason: 'not-a-directory' })
    expect(planDrop(dir('global'), { hasFiles: false, files: undefined }))
      .toEqual({ kind: 'refuse', reason: 'no-files' })
    expect(planDrop(dir('global'), { hasFiles: true, files: [] }))
      .toEqual({ kind: 'refuse', reason: 'no-files' })
  })

  it('refuses a disabled target even when files are present', () => {
    // A read-only caller dragging onto a folder is the common case here: the refusal is
    // about permission, not about the payload.
    expect(planDrop(dir('global', { drops: false }), dropOf('a.md')))
      .toEqual({ kind: 'refuse', reason: 'disabled' })
  })

  it('does not mutate the caller\'s list', () => {
    const files = [entry('a.md')]
    const plan = planDrop(dir('global'), { hasFiles: true, files })
    expect(plan.kind).toBe('upload')
    if (plan.kind !== 'upload') throw new Error('unreachable')
    plan.files.push(entry('b.md'))
    expect(files).toEqual([entry('a.md')])
  })
})

describe('a dropped folder keeps its shape', () => {
  it('normalises either separator and strips a leading one', () => {
    // Windows reports backslashes through the File API; `webkitRelativePath` uses
    // forward slashes. Both must reach the server in one form.
    expect(normalizeDropPath('specs\\2026\\api.md')).toBe('specs/2026/api.md')
    expect(normalizeDropPath('/specs/api.md')).toBe('specs/api.md')
    expect(normalizeDropPath('specs/api.md')).toBe('specs/api.md')
  })

  it('joins the target and the file path without doubling separators', () => {
    expect(dropTargetPath('global/specs', 'a.md')).toBe('global/specs/a.md')
    expect(dropTargetPath('global/specs/', 'a.md')).toBe('global/specs/a.md')
    expect(dropTargetPath('global', 'nested/deep/a.md')).toBe('global/nested/deep/a.md')
    // The root case is the one that would otherwise gain a leading slash.
    expect(dropTargetPath('', 'a.md')).toBe('a.md')
  })
})

describe('the same destination is not uploaded twice', () => {
  it('keeps the first occurrence of each path', () => {
    const deduped = dedupeDropped([entry('a.md'), entry('b.md'), entry('a.md')])
    expect(deduped.map(item => item.relativePath)).toEqual(['a.md', 'b.md'])
  })

  it('treats the two separator spellings as one destination', () => {
    // Otherwise a Windows drop would attempt `nested\a.md` and `nested/a.md`, and the
    // second would be refused as "already exists" -- showing a failure for a file that
    // is actually there.
    const deduped = dedupeDropped([entry('nested\\a.md'), entry('nested/a.md')])
    expect(deduped.map(item => item.relativePath)).toEqual(['nested/a.md'])
  })

  it('drops an empty path rather than uploading to the directory itself', () => {
    expect(dedupeDropped([entry(''), entry('a.md')]).map(item => item.relativePath)).toEqual(['a.md'])
  })

  it('preserves order so the first drop wins', () => {
    const deduped = dedupeDropped([entry('z.md'), entry('a.md'), entry('z.md')])
    expect(deduped.map(item => item.relativePath)).toEqual(['z.md', 'a.md'])
  })
})

describe('a partial drop tells the reader which files failed', () => {
  it('says nothing when everything landed', () => {
    // Silence is the correct outcome for a clean drop: a "3 files uploaded" banner on
    // every drop is noise the reader learns to ignore.
    expect(summarizeDrop([
      { relativePath: 'a.md', ok: true },
      { relativePath: 'b.md', ok: true },
    ])).toBeUndefined()
  })

  it('names the failing files and counts the successes', () => {
    // "Some failed" is not actionable; WHICH one failed decides whether the reader
    // retries, renames, or asks for access.
    expect(summarizeDrop([
      { relativePath: 'a.md', ok: true },
      { relativePath: 'b.md', ok: false },
    ])).toEqual({ ok: 1, failed: ['b.md'] })
  })

  it('summarises past a few names instead of listing everything', () => {
    const results = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(relativePath => ({ relativePath, ok: false }))
    expect(summarizeDrop(results, 3)).toEqual({ ok: 0, failed: ['a.md', 'b.md', 'c.md', '…'] })
  })

  it('reports every failure when there are few enough to name', () => {
    expect(summarizeDrop([
      { relativePath: 'a.md', ok: false },
      { relativePath: 'b.md', ok: false },
    ])).toEqual({ ok: 0, failed: ['a.md', 'b.md'] })
  })
})

describe('the progress strip folds only once per settled batch', () => {
  /**
   * The strip is a resident surface, so its fold rule is the difference between "it
   * gets out of the way when done" and "it is in the way forever". The decision is
   * imported from the component rather than restated here: a copy in the test would
   * keep passing after the component's rule changed.
   */
  it('stays open while an upload is still in flight', () => {
    expect(shouldFoldStrip([{ state: 'uploading' }], [], false)).toBe(false)
    expect(shouldFoldStrip([{ state: 'waiting' }], [], false)).toBe(false)
  })

  it('stays open while an extraction is queued or running', () => {
    expect(shouldFoldStrip([], [{ state: 'pending' }], false)).toBe(false)
    expect(shouldFoldStrip([], [{ state: 'running' }], false)).toBe(false)
  })

  it('folds once the batch has settled', () => {
    expect(shouldFoldStrip([{ state: 'done' }, { state: 'failed' }], [{ state: 'succeeded' }], false)).toBe(true)
  })

  it('does not fold again after the reader opened it', () => {
    // The reader expanded a finished batch to read which file failed; folding it back
    // would take away the answer they just asked for.
    expect(shouldFoldStrip([{ state: 'failed' }], [], true)).toBe(false)
  })

  it('treats an unsupported extraction as settled', () => {
    // No extractor exists for that type, so it will never change: waiting on it would
    // keep the strip open forever.
    expect(shouldFoldStrip([], [{ state: 'unsupported' }], false)).toBe(true)
  })
})

describe('an extraction row says what happened and whether retrying helps', () => {
  /**
   * The five states are not interchangeable to a reader: "queued" means wait, "failed"
   * means act, "unsupported" means stop trying. Offering a retry on a type that has no
   * extractor is the specific mistake this pins.
   */
  it('offers a retry only for a failure', () => {
    expect(canRetryExtraction('failed')).toBe(true)
    expect(canRetryExtraction('pending')).toBe(false)
    expect(canRetryExtraction('running')).toBe(false)
    expect(canRetryExtraction('succeeded')).toBe(false)
    expect(canRetryExtraction('unsupported')).toBe(false)
  })
})

describe('a failure reason survives a response that is not JSON', () => {
  /**
   * A gateway answering 502 sends HTML, not the Host's `{error}` object. If reading the
   * body threw, the progress row would say "failed" with no reason at all -- the exact
   * silence the strip exists to remove. These pin the fallback that turns a status code
   * into something the reader can act on.
   */
  it('uses the Host\'s own message when the body parsed', () => {
    expect(failureReason({ error: 'a file already exists at global/a.md' }, 409))
      .toBe('a file already exists at global/a.md')
  })

  it('falls back to a size sentence for the limit response', () => {
    // The route answers `{code:'too-large', limitBytes}`; the reader needs to know the
    // file was too big, not the status number.
    expect(failureReason({ code: 'too-large', limitBytes: 26214400 }, 413)).toBe('file is too large')
    // Same answer when only the status arrived (a proxy in front of the route).
    expect(failureReason(undefined, 413)).toBe('file is too large')
  })

  it('names the permission problem when the body is missing', () => {
    expect(failureReason(undefined, 403)).toBe('write access is required here')
  })

  it('separates "the server broke" from "the request was refused"', () => {
    // The distinction decides the reader's next action: wait and retry, or change the
    // request. A blank reason makes the two indistinguishable.
    expect(failureReason(undefined, 502)).toMatch(/server failed/u)
    expect(failureReason(undefined, 502)).toMatch(/502/u)
    expect(failureReason(undefined, 400)).toMatch(/refused/u)
  })

  it('reports the status code it actually saw', () => {
    // A coded answer is what lets an operator correlate the row with a gateway log.
    expect(failureReason(undefined, 504)).toMatch(/504/u)
  })

  it('treats an empty error string as absent', () => {
    // A body of `{error: ''}` must not produce an empty reason.
    expect(failureReason({ error: '' }, 500)).toMatch(/server failed/u)
  })
})
