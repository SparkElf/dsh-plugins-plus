import { describe, expect, it } from 'vitest'
import { createExtractionQueue, MAX_CONCURRENT_EXTRACTIONS } from '../src/extractionQueue.ts'

/** A runner whose runs are settled by the test, so interleaving is explicit. */
function controlledRunner() {
  const calls: Array<{ relPath: string; mineruBaseUrl: string | undefined; resolve: (state: 'succeeded' | 'failed' | 'unsupported', extra?: Record<string, unknown>) => void }> = []
  const run = (relPath: string, mineruBaseUrl: string | undefined) => new Promise<{
    state: 'succeeded' | 'failed' | 'unsupported'
    markdown?: string
    via?: string
    reason?: string
  }>((resolve) => {
    calls.push({
      relPath,
      mineruBaseUrl,
      resolve: (state, extra) => { resolve({ state, ...(extra ?? {}) }) },
    })
  })
  return { calls, run }
}

/** Let queued microtasks run so the worker can pick up the next item. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('the extraction queue', () => {
  it('runs one extraction at a time', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: runner.run,
      isExtractable: () => true,
    })

    queue.enqueue('a.docx')
    queue.enqueue('b.docx')
    await settle()

    // Exactly one run is in flight: the second is waiting, not racing it.
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.relPath).toBe('a.docx')
    expect(queue.get('b.docx')?.state).toBe('pending')
    expect(MAX_CONCURRENT_EXTRACTIONS).toBe(1)

    runner.calls[0]!.resolve('succeeded', { markdown: 'a.docx.md', via: 'libreoffice' })
    await settle()

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]!.relPath).toBe('b.docx')
    runner.calls[1]!.resolve('succeeded', { markdown: 'b.docx.md' })
    await queue.drain()
  })

  it('moves a task through pending, running, then succeeded', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true })

    const accepted = queue.enqueue('report.pdf')
    // The upload that enqueued it has already answered; this is what it reports.
    expect(accepted.state).toBe('pending')

    await settle()
    expect(queue.get('report.pdf')?.state).toBe('running')

    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md', via: 'mineru' })
    await queue.drain()

    const done = queue.get('report.pdf')
    expect(done?.state).toBe('succeeded')
    expect(done?.markdown).toBe('report.pdf.md')
    expect(done?.via).toBe('mineru')
    expect(done?.finishedAt).toBeDefined()
  })

  it('records the extractor reason when a run fails', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true })

    queue.enqueue('scan.pdf')
    await settle()
    runner.calls[0]!.resolve('failed', { reason: 'no-extractor-succeeded: mineru,python,libreoffice' })
    await queue.drain()

    const task = queue.get('scan.pdf')
    expect(task?.state).toBe('failed')
    expect(task?.reason).toBe('no-extractor-succeeded: mineru,python,libreoffice')
  })

  it('answers an unsupported type immediately instead of spending the worker', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => false })

    const task = queue.enqueue('notes.md')
    expect(task.state).toBe('unsupported')
    expect(task.reason).toContain('no extractor')
    await settle()
    // Nothing was scheduled, so the single slot stayed free.
    expect(runner.calls).toHaveLength(0)
  })

  it('joins a duplicate instead of spending two parses on one document', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true })

    const first = queue.enqueue('report.pdf')
    const second = queue.enqueue('report.pdf')

    expect(second.queuedAt).toBe(first.queuedAt)
    await settle()
    expect(runner.calls).toHaveLength(1)

    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md' })
    await queue.drain()
    expect(runner.calls).toHaveLength(1)
    expect(queue.get('report.pdf')?.state).toBe('succeeded')
  })

  it('survives a runner that throws, recording it as a failed extraction', async () => {
    const queue = createExtractionQueue({
      run: async () => { throw new Error('spawn soffice ENOENT') },
      isExtractable: () => true,
    })

    queue.enqueue('legacy.doc')
    await queue.drain()

    const task = queue.get('legacy.doc')
    expect(task?.state).toBe('failed')
    expect(task?.reason).toContain('spawn soffice ENOENT')
  })

  it('reports what is running and what is waiting', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true })

    expect(queue.snapshot()).toEqual({ running: undefined, size: 0, tasks: [] })

    queue.enqueue('a.docx')
    queue.enqueue('b.docx')
    await settle()

    const busy = queue.snapshot()
    expect(busy.running).toBe('a.docx')
    // One running plus one waiting. The second has not reached the runner, because
    // this queue serializes: it is `pending`, not `running`.
    expect(busy.size).toBe(2)
    expect(busy.tasks.map(task => task.relPath)).toEqual(['a.docx', 'b.docx'])
    expect(queue.get('b.docx')?.state).toBe('pending')

    runner.calls[0]!.resolve('succeeded', { markdown: 'a.docx.md' })
    await settle()
    runner.calls[1]!.resolve('succeeded', { markdown: 'b.docx.md' })
    await queue.drain()
    expect(queue.snapshot().running).toBeUndefined()
  })

  it('passes the caller address through to the runner', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true })

    queue.enqueue('report.pdf', 'http://mineru.internal:8000')
    await settle()

    expect(runner.calls[0]!.mineruBaseUrl).toBe('http://mineru.internal:8000')
    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md' })
    await queue.drain()
  })

  it('resolves drain immediately on an idle queue', async () => {
    const queue = createExtractionQueue({ run: async () => ({ state: 'succeeded' }), isExtractable: () => true })
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})
