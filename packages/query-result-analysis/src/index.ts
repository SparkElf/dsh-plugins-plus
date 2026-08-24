/** Bounded, checkpointed batch analysis over a generic DSH `read_query_result` tool. */

import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createUserMessage,
  type FinishReason,
  type LlmCallConfig,
  type LlmFailure,
  type ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const PLUGIN_ID = '@sparkelf/dsh-query-result-analysis'
const READ_TOOL = 'read_query_result'
const ANALYSIS_REF_PREFIX = 'qa1_'
const ANALYSIS_REF_PATTERN = /^qa1_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
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
  batchIndex: number
  rowStart: number
  rowEnd: number
  nextCursor: string | null
  summary: string
  provider: string
  model: string
}

type CompleteCheckpoint = {
  rowCount: number
  batchCount: number
  summary: string
  provider: string
  model: string
}

type AnalysisCheckpoint = {
  version: 1
  analysisRef: string
  sourceResultRef: string
  instruction: string
  createdAt: string
  batches: BatchCheckpoint[]
  complete?: CompleteCheckpoint
}

class ModelAttemptError extends Error {
  constructor(
    message: string,
    readonly retryCandidate: boolean,
    readonly failure?: LlmFailure,
  ) {
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
    || (hasMore && nextCursor === null)
  ) {
    throw new Error(`${READ_TOOL} returned an incompatible result page`)
  }
  return {
    columns: columns as string[],
    items: items as ResultRow[],
    returnedCount,
    totalCount,
    hasMore,
    nextCursor,
  }
}

function parseBatch(value: unknown): BatchCheckpoint | null {
  if (!isRecord(value)) return null
  if (
    typeof value.batchIndex !== 'number'
    || typeof value.rowStart !== 'number'
    || typeof value.rowEnd !== 'number'
    || !(value.nextCursor === null || typeof value.nextCursor === 'string')
    || typeof value.summary !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.model !== 'string'
  ) return null
  return value as BatchCheckpoint
}

function parseComplete(value: unknown): CompleteCheckpoint | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.rowCount !== 'number'
    || typeof value.batchCount !== 'number'
    || typeof value.summary !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.model !== 'string'
  ) return undefined
  return value as CompleteCheckpoint
}

function parseCheckpoint(value: unknown): AnalysisCheckpoint {
  if (!isRecord(value)) throw new Error('analysis checkpoint is not an object')
  const batches = Array.isArray(value.batches) ? value.batches.map(parseBatch) : []
  if (
    value.version !== 1
    || typeof value.analysisRef !== 'string'
    || !ANALYSIS_REF_PATTERN.test(value.analysisRef)
    || typeof value.sourceResultRef !== 'string'
    || typeof value.instruction !== 'string'
    || typeof value.createdAt !== 'string'
    || batches.some(batch => batch === null)
  ) throw new Error('analysis checkpoint is incompatible')
  const complete = value.complete === undefined ? undefined : parseComplete(value.complete)
  if (value.complete !== undefined && complete === undefined) {
    throw new Error('analysis checkpoint completion is incompatible')
  }
  return {
    version: 1,
    analysisRef: value.analysisRef,
    sourceResultRef: value.sourceResultRef,
    instruction: value.instruction,
    createdAt: value.createdAt,
    batches: batches as BatchCheckpoint[],
    ...(complete === undefined ? {} : { complete }),
  }
}

function checkpointRoot(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  if (!dshHome) throw new Error('analyze_query_result requires DSH_HOME for durable checkpoints')
  return resolve(dshHome, 'query-result-analysis')
}

function sessionCheckpointDir(sessionId: SessionId): string {
  const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  return resolve(checkpointRoot(), sessionKey)
}

function checkpointPath(sessionId: SessionId, analysisRef: string): string {
  if (!ANALYSIS_REF_PATTERN.test(analysisRef)) throw new Error('resumeAnalysisRef is invalid')
  return resolve(sessionCheckpointDir(sessionId), `${analysisRef}.json`)
}

async function writeCheckpoint(sessionId: SessionId, checkpoint: AnalysisCheckpoint): Promise<void> {
  const path = checkpointPath(sessionId, checkpoint.analysisRef)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(checkpoint), 'utf8')
  await rename(temporary, path)
}

async function readCheckpoint(sessionId: SessionId, analysisRef: string): Promise<AnalysisCheckpoint> {
  const path = checkpointPath(sessionId, analysisRef)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`analysisRef ${analysisRef} does not exist for this session`)
  }
  try {
    return parseCheckpoint(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('analysis checkpoint')) throw error
    throw new Error('analysis checkpoint is incompatible')
  }
}

function finishFailure(reason: FinishReason | undefined): ModelAttemptError | null {
  if (reason === undefined) return new ModelAttemptError('model stream ended without a finish reason', false)
  switch (reason.kind) {
    case 'stop':
      return null
    case 'error':
      return new ModelAttemptError(reason.failure.message, true, reason.failure)
    case 'aborted':
      return new ModelAttemptError(reason.failure.message, false, reason.failure)
    case 'max-tokens':
      return new ModelAttemptError('analysis model output reached its token limit', false)
    case 'tool-calls':
      return new ModelAttemptError('analysis model unexpectedly requested tools', false)
    default:
      return new ModelAttemptError(`analysis model stopped with unsupported reason ${(reason as { kind: string }).kind}`, false)
  }
}

function localRetryDelay(policy: ResolvedRetryPolicy, retry: number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

function retryDelay(
  error: ModelAttemptError,
  policy: ResolvedRetryPolicy,
  retry: number,
): number | null {
  if (!error.retryCandidate || error.failure === undefined) return null
  if (policy.mode === 'normal' && !policy.retryableCodes.includes(error.failure.code)) return null
  const providerDelay = error.failure.providerRetryAfterMs
  if (providerDelay !== undefined && Number.isFinite(providerDelay) && providerDelay > 0) {
    if (providerDelay <= policy.maxDelayMs) return providerDelay
    if (policy.mode === 'normal') return null
  }
  return localRetryDelay(policy, retry)
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolveDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay(true)
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolveDelay(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function modelText(
  ctx: Context,
  config: LlmCallConfig,
  sessionId: SessionId,
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
    sessionId,
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
  sessionId: SessionId,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens: number,
  retryLimit: number,
): Promise<string> {
  const policy = ctx.llm.providerRetryPolicy(config.provider)
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new Error('analysis aborted')
    try {
      return await modelText(ctx, config, sessionId, system, prompt, signal, maxTokens)
    } catch (error) {
      if (!(error instanceof ModelAttemptError) || attempt >= retryLimit) throw error
      if (policy.mode === 'normal' && attempt >= policy.maxRetries) throw error
      const delayMs = retryDelay(error, policy, attempt + 1)
      if (delayMs === null) throw error
      if (!await cancellableDelay(delayMs, signal)) {
        throw signal.reason ?? new Error('analysis aborted')
      }
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
    callId: CallId(`${exec.callId}:query-analysis:${randomUUID()}`),
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
  sessionId: SessionId,
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

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'analyze_query_result',
    description: 'Analyze an entire immutable query result with bounded model batches. The tool repeatedly invokes the visible read_query_result capability under the same Agent, checkpoints each completed batch under DSH_HOME, follows the selected provider retry policy within a caller-bounded retry limit, and hierarchically reduces batch findings. Use resumeAnalysisRef to continue an interrupted analysis without rereading completed pages.',
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
        enum: [0, 1, 2, 3],
        description: 'Maximum retries for each bounded analysis/reduction model call. The provider retry policy still decides which failures are eligible. Defaults to 1.',
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
      const analysisRef = requestedResumeRef || `${ANALYSIS_REF_PREFIX}${randomUUID()}`

      let checkpoint: AnalysisCheckpoint
      if (resumed) {
        checkpoint = await readCheckpoint(agent.id, analysisRef)
        if (checkpoint.sourceResultRef !== resultRef || checkpoint.instruction !== instruction) {
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
      } else {
        checkpoint = {
          version: 1,
          analysisRef,
          sourceResultRef: resultRef,
          instruction,
          createdAt: new Date().toISOString(),
          batches: [],
        }
        await writeCheckpoint(agent.id, checkpoint)
      }

      const last = checkpoint.batches.at(-1)
      let cursor: string | null | undefined = last?.nextCursor
      let rowCount = last?.rowEnd ?? 0
      let batchIndex = last === undefined ? 0 : last.batchIndex + 1
      const summaries = checkpoint.batches.map(batch => batch.summary)

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
          const batch: BatchCheckpoint = {
            batchIndex,
            rowStart,
            rowEnd: rowCount,
            nextCursor: cursor ?? null,
            summary,
            provider: config.provider,
            model: config.model,
          }
          checkpoint.batches.push(batch)
          await writeCheckpoint(agent.id, checkpoint)
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
        checkpoint.complete = {
          rowCount,
          batchCount: summaries.length,
          summary,
          provider: config.provider,
          model: config.model,
        }
        await writeCheckpoint(agent.id, checkpoint)
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
