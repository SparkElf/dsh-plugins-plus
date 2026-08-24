import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as QueryResultAnalysis from '../src/index.ts'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function errorResponse(code: string, message: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }]
}

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: StreamChunk[][],
    private readonly policy?: ResolvedRetryPolicy,
  ) {
    super()
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.policy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('ScriptAdapter: script exhausted')
    yield * response
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(LlmRuntime).await()
  await ctx.plugin(QueryResultAnalysis).await()
  return ctx
}

function makeAgent(name: string): Agent {
  const session = Session.create(SessionId(name))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'model-a' } },
    reason: 'initial',
  })
  return { id: session.id, session } as Agent
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

async function withDshHome<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-query-analysis-'))
  process.env.DSH_HOME = home
  try {
    return await operation()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

function registerPagedResult(
  ctx: Context,
  cursors: Array<string | undefined>,
) {
  ctx.tools.register(defineTool({
    name: 'read_query_result',
    description: 'Test-only immutable result reader.',
    parameters: {
      resultRef: { type: 'string', required: true },
      cursor: { type: 'string' },
      limit: { type: 'integer' },
    },
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: 'page' }],
    },
    execute(args) {
      cursors.push(args.cursor)
      if (args.cursor === undefined) {
        return Promise.resolve({
          columns: ['id', 'amount'],
          items: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }],
          returnedCount: 2,
          totalCount: 3,
          hasMore: true,
          nextCursor: 'cursor-2',
        })
      }
      if (args.cursor === 'cursor-2') {
        return Promise.resolve({
          columns: ['id', 'amount'],
          items: [{ id: 3, amount: 30 }],
          returnedCount: 1,
          totalCount: 3,
          hasMore: false,
          nextCursor: null,
        })
      }
      throw new Error(`unexpected cursor ${String(args.cursor)}`)
    },
  }))
}

const FAST_SERVER_RETRY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: Object.freeze(['SERVER']),
  initialDelayMs: 1,
  maxDelayMs: 1,
  jitterRatio: 0,
})

describe.sequential('analyze_query_result', () => {
  it('analyzes all result pages, preserves row refs, reduces them, and reuses a completed checkpoint', async () => {
    await withDshHome(async () => {
      const ctx = await setup()
      try {
        const cursors: Array<string | undefined> = []
        registerPagedResult(ctx, cursors)
        const adapter = new ScriptAdapter([
          textResponse('batch-one'),
          textResponse('batch-two'),
          textResponse('final-summary'),
        ])
        ctx.llm.registerAdapter(['mock'], adapter)
        const agent = makeAgent('analysis-complete')

        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-call-1'),
          name: 'analyze_query_result',
          arguments: { resultRef: 'qr1_example', instruction: 'Find material patterns.' },
          agent,
        })

        expect(result.isError).toBe(false)
        if (result.isError) throw new Error(result.error.message)
        const value = result.value as {
          analysisRef: string
          summary: string
          rowCount: number
          batchCount: number
          resumed: boolean
        }
        expect(value.summary).toBe('final-summary')
        expect(value.rowCount).toBe(3)
        expect(value.batchCount).toBe(2)
        expect(value.resumed).toBe(false)
        expect(cursors).toEqual([undefined, 'cursor-2'])
        expect(adapter.requests).toHaveLength(3)
        expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('qr1_example#row-1')
        expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('qr1_example#row-2')
        expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('qr1_example#row-3')

        const resumed = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-call-2'),
          name: 'analyze_query_result',
          arguments: {
            resultRef: 'qr1_example',
            instruction: 'Find material patterns.',
            resumeAnalysisRef: value.analysisRef,
          },
          agent,
        })
        expect(resumed.isError).toBe(false)
        if (resumed.isError) throw new Error(resumed.error.message)
        expect(resumed.value).toMatchObject({
          analysisRef: value.analysisRef,
          summary: 'final-summary',
          rowCount: 3,
          batchCount: 2,
          resumed: true,
        })
        expect(cursors).toEqual([undefined, 'cursor-2'])
        expect(adapter.requests).toHaveLength(3)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('resumes from the last completed cursor without rereading an already analyzed page', async () => {
    await withDshHome(async () => {
      const ctx = await setup()
      try {
        const cursors: Array<string | undefined> = []
        registerPagedResult(ctx, cursors)
        const failing = new ScriptAdapter([
          textResponse('batch-one'),
          errorResponse('SERVER', 'temporary server failure'),
        ])
        const disposeFailing = ctx.llm.registerAdapter(['mock'], failing)
        const agent = makeAgent('analysis-resume')

        const failed = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-fail'),
          name: 'analyze_query_result',
          arguments: {
            resultRef: 'qr1_resume',
            instruction: 'Summarize all rows.',
            maxBatchRetries: 0,
          },
          agent,
        })
        expect(failed.isError).toBe(true)
        const match = text(failed).match(/resumeAnalysisRef=(qa1_[0-9a-f-]+)/iu)
        expect(match?.[1]).toBeDefined()
        const analysisRef = match?.[1]
        if (analysisRef === undefined) throw new Error('missing analysisRef in failure')
        expect(cursors).toEqual([undefined, 'cursor-2'])

        disposeFailing()
        const resumedAdapter = new ScriptAdapter([
          textResponse('batch-two'),
          textResponse('final-after-resume'),
        ])
        ctx.llm.registerAdapter(['mock'], resumedAdapter)

        const resumed = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-resume-call'),
          name: 'analyze_query_result',
          arguments: {
            resultRef: 'qr1_resume',
            instruction: 'Summarize all rows.',
            resumeAnalysisRef: analysisRef,
            maxBatchRetries: 0,
          },
          agent,
        })
        expect(resumed.isError).toBe(false)
        if (resumed.isError) throw new Error(resumed.error.message)
        expect(resumed.value).toMatchObject({
          analysisRef,
          summary: 'final-after-resume',
          rowCount: 3,
          batchCount: 2,
          resumed: true,
        })
        expect(cursors).toEqual([undefined, 'cursor-2', 'cursor-2'])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('retries only failures permitted by the provider policy and stays within the batch cap', async () => {
    await withDshHome(async () => {
      const ctx = await setup()
      try {
        ctx.tools.register(defineTool({
          name: 'read_query_result',
          description: 'One-page test result.',
          parameters: {
            resultRef: { type: 'string', required: true },
            cursor: { type: 'string' },
            limit: { type: 'integer' },
          },
          output: {
            schema: { type: 'json' },
            render: () => [{ type: 'text', text: 'page' }],
          },
          execute: () => Promise.resolve({
            columns: ['id'],
            items: [{ id: 1 }],
            returnedCount: 1,
            totalCount: 1,
            hasMore: false,
            nextCursor: null,
          }),
        }))
        const adapter = new ScriptAdapter([
          errorResponse('SERVER', 'retry me'),
          textResponse('recovered-summary'),
        ], FAST_SERVER_RETRY)
        ctx.llm.registerAdapter(['mock'], adapter)
        const agent = makeAgent('analysis-retry')

        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-retry-call'),
          name: 'analyze_query_result',
          arguments: {
            resultRef: 'qr1_retry',
            instruction: 'Analyze.',
            maxBatchRetries: 1,
          },
          agent,
        })
        expect(result.isError).toBe(false)
        if (result.isError) throw new Error(result.error.message)
        expect(result.value).toMatchObject({ summary: 'recovered-summary', rowCount: 1, batchCount: 1 })
        expect(adapter.requests).toHaveLength(2)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('does not retry a failure code excluded by the provider policy', async () => {
    await withDshHome(async () => {
      const ctx = await setup()
      try {
        ctx.tools.register(defineTool({
          name: 'read_query_result',
          description: 'One-page test result.',
          parameters: {
            resultRef: { type: 'string', required: true },
            cursor: { type: 'string' },
            limit: { type: 'integer' },
          },
          output: {
            schema: { type: 'json' },
            render: () => [{ type: 'text', text: 'page' }],
          },
          execute: () => Promise.resolve({
            columns: ['id'],
            items: [{ id: 1 }],
            returnedCount: 1,
            totalCount: 1,
            hasMore: false,
            nextCursor: null,
          }),
        }))
        const adapter = new ScriptAdapter([
          errorResponse('AUTH', 'bad credential'),
          textResponse('must-not-run'),
        ], FAST_SERVER_RETRY)
        ctx.llm.registerAdapter(['mock'], adapter)
        const agent = makeAgent('analysis-no-auth-retry')

        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('analysis-auth-call'),
          name: 'analyze_query_result',
          arguments: {
            resultRef: 'qr1_auth',
            instruction: 'Analyze.',
            maxBatchRetries: 3,
          },
          agent,
        })
        expect(result.isError).toBe(true)
        expect(text(result)).toContain('bad credential')
        expect(adapter.requests).toHaveLength(1)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })
})
