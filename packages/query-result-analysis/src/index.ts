/** Bounded, checkpointed batch analysis over a generic DSH `read_query_result` tool. */

import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createUserMessage,
  type FinishReason,
  type LlmCallConfig,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

const PLUGIN_ID = '@sparkelf/dsh-query-result-analysis'
const READ_TOOL = 'read_query_result'
const ANALYSIS_REF_PREFIX = 'qa1_'
const READ_PAGE_LIMIT = 2000
const BATCH_OUTPUT_MAX_TOKENS = 1200
const REDUCE_OUTPUT_MAX_TOKENS = 1600
const REDUCE_GROUP_SIZE = 8
const DEFAULT_BATCH_RETRIES = 1

export const name = 'query-result-analysis'
export const inject = ['tools', 'llm']

type ResultRow = Record<string, JsonValue>

type ResultPage = {
  columns: string[]
  items: ResultRow[]
  returnedCount: number
  totalCount: number
  hasMore: boolean
  nextCursor: string | null
}

type BatchCheckpoint = {
  analysisRef: string
  batchIndex: number
  rowStart: number
  rowEnd: number
  nextCursor: string | null
  summary: string
  provider: string
  model: string
}

type CompleteCheckpoint = {
  analysisRef: string
  sourceResultRef: string
  instruction: string
  rowCount: number
  batchCount: number
  summary: string
  provider: string
  model: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'query-analysis/start': {
      analysisRef: string
      sourceResultRef: string
      instruction: string
      provider: string
      model: string
    }
    'query-analysis/batch': BatchCheckpoint
    'query-analysis/complete': CompleteCheckpoint
  }
}

class ModelAttemptError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'ModelAttemptError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseResultPage(value: JsonValue): ResultPage {
  if (!isRecord(value)) throw new Error(`${READ_TOOL} returned a non-object value`)
  const columns = value.columns
  const items = value.items
  const returnedCount = value.returnedCount
  const totalCount = value.totalCount
  const hasMore = value.hasMore
  const nextCursor = value.nextCursor
  if (
    !Array.isArray(columns)
    || columns.some(column => typeof column !== 'string')
    || !Array.isArray(items)
    || items.some(item => !isRecord(item))
    || typeof returnedCount !== 'number'
    || typeof totalCount !== 'number'
    || typeof hasMore !== 'boolean'
    || !(nextCursor === null || typeof nextCursor === 'string')
  ) {
    throw new Error(`${READ_TOOL} returned an incompatible result page`)
  }
  return {
    columns,
    items: items as ResultRow[],
    returnedCount,
    totalCount,
    hasMore,
    nextCursor,
  }
}

function finishFailure(reason: FinishReason | undefined): ModelAttemptError | null {
  if (reason === undefined) return new ModelAttemptError('model stream ended without a finish reason', false)
  switch (reason.kind) {
    case 'stop':
      return null
    case 'error':
      return new ModelAttemptError(reason.failure.message, true)
    case 'aborted':
      return new ModelAttemptError(reason.failure.message, false)
    case 'max-tokens':
      return new ModelAttemptError('analysis model output reached its token limit', false)
    case 'tool-calls':
      return new ModelAttemptError('analysis model unexpectedly requested tools', false)
    default:
      return new ModelAttemptError(`analysis model stopped with unsupported reason ${(reason as { kind: string }).kind}`, false)
  }
}

async function modelText(
  ctx: Context,
  config: LlmCallConfig,
  sessionId: string,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of ctx.llm.stream({
    ...config,
    messages: [message],
    system,
    maxTokens: Math.min(config.maxTokens ?? maxTokens, maxTokens),
    signal,
    sessionId: sessionId as never,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  const failure = finishFailure(finish)
  if (failure !== null) throw failure
  const normalized = text.trim()
  if (normalized.length === 0) throw new ModelAttemptError('analysis model returned no text', false)
  return normalized
}

async function modelTextWithRetry(
  ctx: Context,
  config: LlmCallConfig,
  sessionId: string,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens: number,
  retryLimit: number,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new Error('analysis aborted')
    try {
      return await modelText(ctx, config, sessionId, system, prompt, signal, maxTokens)
    } catch (error) {
      if (!(error instanceof ModelAttemptError) || !error.retryable || attempt >= retryLimit) throw error
    }
  }
}

async function readPage(
  ctx: Context,
  exec: ToolRunContext,
  resultRef: string,
  cursor?: string | null,
): Promise<ResultPage> {
  const result = await ctx.tools.execute({
    callId: CallId(`${exec.callId}:query-analysis:${crypto.randomUUID()}`),
    rootCallId: exec.rootCallId,
    name: READ_TOOL,
    arguments: {
      resultRef,
      limit: READ_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    },
    agent: exec.agent,
    parent: exec.token,
    signal: exec.signal,
  })
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (result.isError) throw new Error(`${READ_TOOL} failed: ${result.error.message}`)
  return parseResultPage(result.value)
}

function batchPrompt(input: {
  sourceResultRef: string
  instruction: string
  batchIndex: number
  rowStart: number
  rows: ResultRow[]
}) {
  const rows = input.rows.map((row, index) => ({
    rowRef: `${input.sourceResultRef}#row-${input.rowStart + index}`,
    data: row,
  }))
  return JSON.stringify({
    task: input.instruction,
    sourceResultRef: input.sourceResultRef,
    batchIndex: input.batchIndex,
    rows,
  })
}

const BATCH_SYSTEM = [
  'Analyze only the supplied immutable query-result rows for the requested task.',
  'Return a concise batch finding in plain text.',
  'Cite the supplied rowRef values for specific evidence when useful.',
  'Do not claim facts about rows outside this batch.',
].join(' ')

const REDUCE_SYSTEM = [
  'Synthesize bounded batch analyses of one immutable query result into one final answer.',
  'Preserve important rowRef citations from the batch analyses.',
  'Resolve duplication across batches and state material patterns, exceptions, and limitations.',
  'Do not invent facts that are absent from the batch analyses.',
].join(' ')

async function reduceSummaries(
  ctx: Context,
  config: LlmCallConfig,
  sessionId: string,
  instruction: string,
  summaries: string[],
  signal: AbortSignal,
  retryLimit: number,
): Promise<string> {
  if (summaries.length === 0) return 'The query result contains no rows to analyze.'
  let layer = summaries.map((summary, index) => ({ id: `batch-${index + 1}`, summary }))
  while (layer.length > 1) {
    const next: Array<{ id: string; summary: string }> = []
    for (let offset = 0; offset < layer.length; offset += REDUCE_GROUP_SIZE) {
      const group = layer.slice(offset, offset + REDUCE_GROUP_SIZE)
      const summary = await modelTextWithRetry(
        ctx,
        config,
        sessionId,
        REDUCE_SYSTEM,
        JSON.stringify({ task: instruction, analyses: group }),
        signal,
        REDUCE_OUTPUT_MAX_TOKENS,
        retryLimit,
      )
      next.push({ id: `reduce-${Math.floor(offset / REDUCE_GROUP_SIZE) + 1}`, summary })
    }
    layer = next
  }
  return layer[0]!.summary
}

function loadResume(agent: NonNullable<ToolRunContext['agent']>, analysisRef: string) {
  const starts = agent.session.events.filter(event =>
    event.type === 'query-analysis/start' && event.data.analysisRef === analysisRef)
  const start = starts.at(-1)
  if (start === undefined || start.type !== 'query-analysis/start') {
    throw new Error(`analysisRef ${analysisRef} does not exist in this session`)
  }
  const batches = agent.session.events
    .filter(event => event.type === 'query-analysis/batch' && event.data.analysisRef === analysisRef)
    .map(event => event.type === 'query-analysis/batch' ? event.data : null)
    .filter((event): event is BatchCheckpoint => event !== null)
  const complete = agent.session.events
    .filter(event => event.type === 'query-analysis/complete' && event.data.analysisRef === analysisRef)
    .at(-1)
  return {
    start: start.data,
    batches,
    complete: complete?.type === 'query-analysis/complete' ? complete.data : undefined,
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'analyze_query_result',
    description: 'Analyze an entire immutable query result with bounded model batches. The tool repeatedly invokes the visible read_query_result capability under the same Agent, checkpoints each completed batch in the DSH session, retries provider/model failures within the configured limit, and hierarchically reduces batch findings. Use resumeAnalysisRef to continue an interrupted analysis without rereading completed pages.',
    parameters: {
      resultRef: {
        type: 'string',
        required: true,
        description: 'Opaque immutable query result reference to analyze completely.',
      },
      instruction: {
        type: 'string',
        required: true,
        description: 'The business or analytical question to answer across all result rows.',
      },
      resumeAnalysisRef: {
        type: 'string',
        description: 'Optional analysisRef from an interrupted prior call in this same DSH session.',
      },
      maxBatchRetries: {
        type: 'integer',
        minimum: 0,
        maximum: 3,
        description: 'Retries for a provider/model error on each bounded analysis or reduction call. Defaults to 1.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          analysisRef: { type: 'string', required: true },
          sourceResultRef: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          rowCount: { type: 'integer', required: true },
          batchCount: { type: 'integer', required: true },
          resumed: { type: 'boolean', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('analyze_query_result requires an Agent-owned tool execution')
      const resultRef = args.resultRef.trim()
      const instruction = args.instruction.trim()
      if (resultRef.length === 0) throw new Error('resultRef must be non-empty')
      if (instruction.length === 0) throw new Error('instruction must be non-empty')
      const retryLimit = args.maxBatchRetries ?? DEFAULT_BATCH_RETRIES
      const header = agent.session.requestHeader()
      if (header === undefined) throw new Error('analyze_query_result requires an active model request header')
      const config = header.config
      const requestedResumeRef = args.resumeAnalysisRef?.trim()
      const resumed = Boolean(requestedResumeRef)
      const analysisRef = requestedResumeRef || `${ANALYSIS_REF_PREFIX}${crypto.randomUUID()}`

      let cursor: string | null | undefined
      let rowCount = 0
      let batchIndex = 0
      let summaries: string[] = []

      if (resumed) {
        const checkpoint = loadResume(agent, analysisRef)
        if (checkpoint.start.sourceResultRef !== resultRef || checkpoint.start.instruction !== instruction) {
          throw new Error('resumeAnalysisRef belongs to a different resultRef or instruction')
        }
        if (checkpoint.complete !== undefined) {
          return {
            analysisRef,
            sourceResultRef: resultRef,
            summary: checkpoint.complete.summary,
            rowCount: checkpoint.complete.rowCount,
            batchCount: checkpoint.complete.batchCount,
            resumed: true,
            provider: checkpoint.complete.provider,
            model: checkpoint.complete.model,
          }
        }
        summaries = checkpoint.batches.map(batch => batch.summary)
        const last = checkpoint.batches.at(-1)
        if (last !== undefined) {
          cursor = last.nextCursor
          rowCount = last.rowEnd
          batchIndex = last.batchIndex + 1
        }
      } else {
        agent.session.append('query-analysis/start', {
          analysisRef,
          sourceResultRef: resultRef,
          instruction,
          provider: config.provider,
          model: config.model,
        })
      }

      try {
        while (cursor !== null) {
          const page = await readPage(ctx, exec, resultRef, cursor)
          if (page.items.length === 0 && !page.hasMore) {
            cursor = null
            break
          }
          const rowStart = rowCount + 1
          const summary = await modelTextWithRetry(
            ctx,
            config,
            agent.id,
            BATCH_SYSTEM,
            batchPrompt({
              sourceResultRef: resultRef,
              instruction,
              batchIndex,
              rowStart,
              rows: page.items,
            }),
            exec.signal,
            BATCH_OUTPUT_MAX_TOKENS,
            retryLimit,
          )
          rowCount += page.items.length
          cursor = page.hasMore ? page.nextCursor : null
          const checkpoint: BatchCheckpoint = {
            analysisRef,
            batchIndex,
            rowStart,
            rowEnd: rowCount,
            nextCursor: cursor ?? null,
            summary,
            provider: config.provider,
            model: config.model,
          }
          agent.session.append('query-analysis/batch', checkpoint)
          summaries.push(summary)
          batchIndex += 1
        }

        const summary = await reduceSummaries(
          ctx,
          config,
          agent.id,
          instruction,
          summaries,
          exec.signal,
          retryLimit,
        )
        const completed: CompleteCheckpoint = {
          analysisRef,
          sourceResultRef: resultRef,
          instruction,
          rowCount,
          batchCount: summaries.length,
          summary,
          provider: config.provider,
          model: config.model,
        }
        agent.session.append('query-analysis/complete', completed)
        return {
          analysisRef,
          sourceResultRef: resultRef,
          summary,
          rowCount,
          batchCount: summaries.length,
          resumed,
          provider: config.provider,
          model: config.model,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}. Resume with resumeAnalysisRef=${analysisRef}`)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Analyze complete query result',
      kind: 'other',
      rawInput: {
        resultRef: args.resultRef,
        ...(args.resumeAnalysisRef ? { resumeAnalysisRef: args.resumeAnalysisRef } : {}),
      },
    }),
  }))
}
