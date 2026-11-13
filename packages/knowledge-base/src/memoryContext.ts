/**
 * Runtime memory context: what the model may see from one user's personal graph.
 *
 * The personal graph is a projection, not a second copy:
 *
 * - a `subscribe` binding is resolved LIVE from the current department/global
 *   graph. The resolver reads the document body from disk on every call and
 *   prefers the live frontmatter, so a published change reaches the model
 *   without waiting for the guardian or for a binding refresh;
 * - an `internalize` binding is read from the user's own branch at
 *   `<usersRoot>/<userId>/memory/<graphId>/<sourceId>.md`. That branch does not
 *   follow the source; `stale` / `revoked` come from the binding so the runtime
 *   can down-rank or hide it;
 * - visibility is decided per graph through `canViewGraph`. A graph, node or
 *   edge the viewer cannot see is omitted, never partially projected;
 * - redlines are marked `nonOverridable` with an explicit marker. The character
 *   budget drops advisory material first and never drops a redline.
 *
 * Ordering is deterministic (priority tier, graph id, source type, source id),
 * so two identical inputs produce the same prompt prefix.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-context
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GraphManifest, LoadedGraph, MemoryAuthority, MemoryOrigin, MemoryReviewStatus } from './graphModel.ts'
import { canViewGraph, type GraphScopeDescriptor, type GraphViewer } from './graphPolicy.ts'
import {
  BindingStore,
  memoryFilePath,
  parseSimpleYaml,
  type BindingSourceType,
  type BindingStatus,
  type PersonalBinding,
} from './memoryBindings.ts'
import { splitFrontMatter } from './memoryGuardian.ts'

/** Default prompt budget for the resolved context. */
export const DEFAULT_MEMORY_CONTEXT_MAX_CHARS = 8000

/** Marker the runtime must treat as above personal memory and preferences. */
export const SYSTEM_POLICY_MARKER = 'system policy overrides personal memory'

/** How a memory entry reaches the personal graph. */
export type MemoryContextMode = 'subscribe' | 'internalize'

/** One resolved node/edge the runtime may inject. */
export interface MemoryContextEntry {
  mode: MemoryContextMode
  graphId: string
  sourceType: BindingSourceType
  sourceId: string
  title: string
  /** Node type or relation type. */
  type: string
  authority: MemoryAuthority
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  /** True for a redline (direct or inherited): personal memory must not override it. */
  nonOverridable: boolean
  /** Set together with `nonOverridable`. */
  policyNote?: string
  status: BindingStatus
  sourceVersion: number
  sourceCommit?: string
  /** Live source path for a proxy; personal branch path for an internalized copy. */
  path?: string
  /** Relation endpoints, when the source is an edge. */
  from?: string
  to?: string
  body: string
  /** Budget cost used by this resolver (title + body + fixed metadata overhead). */
  chars: number
}

/** One entry omitted only because the character budget ran out. */
export interface MemoryContextDrop {
  graphId: string
  sourceType: BindingSourceType
  sourceId: string
  mode: MemoryContextMode
  chars: number
  reason: 'budget'
}

/** The resolver output. */
export interface MemoryContextResult {
  userId: string
  entries: MemoryContextEntry[]
  dropped: MemoryContextDrop[]
  charCount: number
  maxChars: number
  redlineCount: number
  /** Non-empty when at least one redline is present. */
  systemPolicy: string
}

/** Resolver input. All roots and graphs are injected; no global config is read. */
export interface MemoryContextInput {
  viewer: GraphViewer
  usersRoot: string
  userId: string
  graphs: LoadedGraph[]
  /** Pre-read bindings, for callers that already listed them. Omit to rebuild from disk. */
  bindings?: PersonalBinding[]
  /** Prompt budget; defaults to {@link DEFAULT_MEMORY_CONTEXT_MAX_CHARS}. */
  maxChars?: number
}

interface DocumentText {
  frontMatter: string | null
  body: string
}

interface DocumentAttributes {
  title?: string
  type?: string
  authority?: MemoryAuthority
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
}

/** The fixed per-entry metadata overhead included in `chars`. */
const ENTRY_METADATA_CHARS = 32
const AUTHORITY_RANK: Record<MemoryAuthority, number> = { advisory: 0, canonical: 1, redline: 2 }
const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']

/**
 * Adapt a loaded graph manifest to the visibility descriptor `canViewGraph`
 * expects. `scope` is the machine scope (`global`, `department:<code>`,
 * `personal:<uid>`); `owner` is the private-graph owner when present.
 */
export function graphScopeDescriptor(manifest: GraphManifest): GraphScopeDescriptor {
  const scope = manifest.scope ?? ''
  const departmentPrefix = 'department:'
  const personalPrefix = 'personal:'
  const departmentCode = scope.startsWith(departmentPrefix) ? scope.slice(departmentPrefix.length) : undefined
  const ownerId = manifest.visibility === 'private'
    ? manifest.owner ?? (scope.startsWith(personalPrefix) ? scope.slice(personalPrefix.length) : undefined)
    : undefined
  return { visibility: manifest.visibility, ownerId, departmentCode }
}

/**
 * Resolve the caller's personal memory context.
 *
 * @param input - viewer, roots, user id, loaded graphs and optional budget.
 * @returns Priority-ordered entries, budget drops and redline counters.
 */
export async function resolveMemoryContext(input: MemoryContextInput): Promise<MemoryContextResult> {
  const maxChars = normalizeMaxChars(input.maxChars)
  const graphById = new Map<string, LoadedGraph>()
  for (const graph of input.graphs) {
    if (!graphById.has(graph.manifest.id)) graphById.set(graph.manifest.id, graph)
  }

  const bindings = input.bindings ?? await new BindingStore(input.usersRoot).list(input.userId)
  const entries: MemoryContextEntry[] = []

  for (const binding of bindings) {
    if (binding.userId !== input.userId) continue
    if (binding.mode !== 'subscribe' && binding.mode !== 'internalize') continue
    const graph = graphById.get(binding.graphId)
    if (graph === undefined) continue
    // Fail closed: an invisible graph contributes nothing, even if a binding exists.
    if (!canViewGraph(input.viewer, graphScopeDescriptor(graph.manifest))) continue

    const entry = binding.mode === 'subscribe'
      ? await resolveSubscribedEntry(binding, graph)
      : await resolveInternalizedEntry(binding, graph, input.usersRoot)
    if (entry !== undefined) entries.push(entry)
  }

  entries.sort(compareEntries)
  const selected: MemoryContextEntry[] = []
  const dropped: MemoryContextDrop[] = []
  let charCount = 0

  for (const entry of entries) {
    // A redline is never dropped. It may exceed the budget; correctness beats size.
    const protectedEntry = entry.nonOverridable || entry.authority === 'redline'
    if (!protectedEntry && charCount + entry.chars > maxChars) {
      dropped.push({
        graphId: entry.graphId,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        mode: entry.mode,
        chars: entry.chars,
        reason: 'budget',
      })
      continue
    }
    selected.push(entry)
    charCount += entry.chars
  }

  const redlineCount = selected.filter(entry => entry.nonOverridable).length
  return {
    userId: input.userId,
    entries: selected,
    dropped,
    charCount,
    maxChars,
    redlineCount,
    systemPolicy: redlineCount > 0 ? SYSTEM_POLICY_MARKER : '',
  }
}

/** Render a resolved context for a model-facing text tool result. */
export function renderMemoryContextMarkdown(result: MemoryContextResult): string {
  const lines: string[] = [
    `# Memory context (${result.userId})`,
    '',
    `- entries: ${result.entries.length}; chars: ${result.charCount}/${result.maxChars}; redlines: ${result.redlineCount}`,
  ]
  if (result.systemPolicy !== '') lines.push(`- ${result.systemPolicy}`)

  for (const entry of result.entries) {
    lines.push('', `## ${entry.nonOverridable ? '[REDLINE] ' : ''}${entry.title}`, '')
    lines.push(`- mode: ${entry.mode}; source: ${entry.sourceType} \`${entry.sourceId}\` in graph \`${entry.graphId}\``)
    lines.push(`- status: ${entry.status}; authority: ${entry.authority}; origin: ${entry.origin}; review: ${entry.reviewStatus}`)
    lines.push(`- source version: ${entry.sourceVersion}${entry.sourceCommit === undefined ? '' : ` (${entry.sourceCommit})`}`)
    if (entry.path !== undefined) lines.push(`- path: ${entry.path}`)
    if (entry.from !== undefined && entry.to !== undefined) lines.push(`- relation: ${entry.from} -> ${entry.to}`)
    if (entry.nonOverridable) lines.push(`- ${SYSTEM_POLICY_MARKER}`)
    lines.push('', entry.body)
  }

  if (result.dropped.length > 0) {
    lines.push('', '## Dropped by budget')
    for (const drop of result.dropped) {
      lines.push(`- ${drop.mode} ${drop.sourceType} \`${drop.sourceId}\` in graph \`${drop.graphId}\` (${drop.chars} chars)`)
    }
  }

  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Entry resolution
// ---------------------------------------------------------------------------

async function resolveSubscribedEntry(
  binding: PersonalBinding,
  graph: LoadedGraph,
): Promise<MemoryContextEntry | undefined> {
  const graphId = graph.manifest.id
  const sourceVersion = graph.manifest.version
  const sourceCommit = graphCommit(graph) ?? binding.sourceCommit

  if (binding.sourceType === 'node') {
    const node = graph.nodes.find(candidate => candidate.id === binding.sourceId)
    if (node === undefined || node.missing) return undefined
    const document = await readGraphDocument(graph.root, node.path)
    if (document === undefined) return undefined
    const live = readDocumentAttributes(document.frontMatter)
    const title = live.title ?? node.title ?? node.id
    const body = document.body.trim()
    return finalizeEntry({
      mode: 'subscribe',
      graphId,
      sourceType: 'node',
      sourceId: node.id,
      title,
      type: live.type ?? node.type,
      authority: live.authority ?? node.authority,
      origin: live.origin ?? node.origin,
      reviewStatus: live.reviewStatus ?? node.reviewStatus,
      status: binding.status,
      sourceVersion,
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      path: node.path,
      body,
    })
  }

  const edge = graph.edges.find(candidate => candidate.id === binding.sourceId)
  if (edge === undefined || edge.missing) return undefined
  const from = graph.nodes.find(node => node.id === edge.from)
  const to = graph.nodes.find(node => node.id === edge.to)
  if (from === undefined || to === undefined) return undefined
  const document = await readGraphDocument(graph.root, edge.docPath)
  if (document === undefined) return undefined
  const live = readDocumentAttributes(document.frontMatter)
  // A relation inherits the stricter endpoint policy. The live frontmatter may
  // not downgrade an endpoint redline.
  const authority = strictestAuthority(live.authority ?? edge.authority, from.authority, to.authority)
  const body = document.body.trim()
  return finalizeEntry({
    mode: 'subscribe',
    graphId,
    sourceType: 'edge',
    sourceId: edge.id,
    title: live.title ?? edge.title ?? edge.id,
    type: live.type ?? edge.type,
    authority,
    origin: live.origin ?? edge.origin,
    reviewStatus: live.reviewStatus ?? edge.reviewStatus,
    status: binding.status,
    sourceVersion,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    ...(edge.docPath === undefined ? {} : { path: edge.docPath }),
    from: edge.from,
    to: edge.to,
    body,
  })
}

async function resolveInternalizedEntry(
  binding: PersonalBinding,
  graph: LoadedGraph,
  usersRoot: string,
): Promise<MemoryContextEntry | undefined> {
  let source: string
  try {
    source = await readFile(memoryFilePath(usersRoot, binding.userId, binding.graphId, binding.sourceId), 'utf8')
  } catch {
    // The binding points at a branch that is not on disk: fail closed.
    return undefined
  }

  const document = splitFrontMatter(source)
  const local = readDocumentAttributes(document.frontMatter)
  const current = currentSourcePolicy(binding, graph)

  // The branch content is the user's; its policy is the source's. A source that
  // became redline after the fork still makes every copy non-overridable.
  const authority = strictestAuthority(local.authority ?? 'advisory', current.authority)
  const body = document.body.trim()
  return finalizeEntry({
    mode: 'internalize',
    graphId: binding.graphId,
    sourceType: binding.sourceType,
    sourceId: binding.sourceId,
    title: local.title ?? current.title ?? binding.sourceId,
    type: local.type ?? current.type,
    authority,
    origin: local.origin ?? current.origin,
    reviewStatus: local.reviewStatus ?? current.reviewStatus,
    status: binding.status,
    sourceVersion: binding.sourceVersion,
    ...(binding.sourceCommit === undefined ? {} : { sourceCommit: binding.sourceCommit }),
    path: binding.localPath ?? `memory/${binding.graphId}/${binding.sourceId}.md`,
    ...(current.from === undefined ? {} : { from: current.from }),
    ...(current.to === undefined ? {} : { to: current.to }),
    body,
    nonOverridable: current.authority === 'redline',
  })
}

interface CurrentSourcePolicy {
  authority: MemoryAuthority
  title?: string
  type: string
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  from?: string
  to?: string
}

/** Current graph-side policy for a binding's source; absent source falls back to advisory. */
function currentSourcePolicy(binding: PersonalBinding, graph: LoadedGraph): CurrentSourcePolicy {
  if (binding.sourceType === 'node') {
    const node = graph.nodes.find(candidate => candidate.id === binding.sourceId)
    if (node === undefined) {
      return { authority: 'advisory', type: 'fact', origin: 'human', reviewStatus: 'draft' }
    }
    return {
      authority: node.authority,
      title: node.title,
      type: node.type,
      origin: node.origin,
      reviewStatus: node.reviewStatus,
    }
  }
  const edge = graph.edges.find(candidate => candidate.id === binding.sourceId)
  if (edge === undefined) {
    return { authority: 'advisory', type: 'relates_to', origin: 'human', reviewStatus: 'draft' }
  }
  const from = graph.nodes.find(node => node.id === edge.from)
  const to = graph.nodes.find(node => node.id === edge.to)
  return {
    authority: strictestAuthority(edge.authority, from?.authority, to?.authority),
    title: edge.title,
    type: edge.type,
    origin: edge.origin,
    reviewStatus: edge.reviewStatus,
    from: edge.from,
    to: edge.to,
  }
}

function finalizeEntry(input: {
  mode: MemoryContextMode
  graphId: string
  sourceType: BindingSourceType
  sourceId: string
  title: string
  type: string
  authority: MemoryAuthority
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  status: BindingStatus
  sourceVersion: number
  sourceCommit?: string
  path?: string
  from?: string
  to?: string
  body: string
  nonOverridable?: boolean
}): MemoryContextEntry {
  const nonOverridable = input.nonOverridable ?? input.authority === 'redline'
  return {
    ...input,
    nonOverridable,
    ...(nonOverridable ? { policyNote: SYSTEM_POLICY_MARKER } : {}),
    chars: input.title.length + input.body.length + ENTRY_METADATA_CHARS,
  }
}

// ---------------------------------------------------------------------------
// Document reading
// ---------------------------------------------------------------------------

/** Read a graph-relative document body and frontmatter; missing bodies fail closed. */
async function readGraphDocument(root: string, relPath: string | undefined): Promise<DocumentText | undefined> {
  // A topology-only relation has no document and no body; that is not a failure.
  if (relPath === undefined || relPath === '') return { frontMatter: null, body: '' }

  const candidates: string[] = []
  if (isAbsolute(relPath)) {
    candidates.push(relPath)
  } else {
    if (relPath.split('/').some(segment => segment === '..' || segment === '')) return undefined
    candidates.push(join(root, relPath))
    // Also accept a graph-directory root (`<scope>/.graphs/<id>`).
    candidates.push(join(root, '..', '..', relPath))
  }

  for (const candidate of candidates) {
    try {
      return splitFrontMatter(await readFile(candidate, 'utf8'))
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** Parse the attributes the runtime injection reads, tolerating extra keys. */
function readDocumentAttributes(frontMatter: string | null): DocumentAttributes {
  if (frontMatter === null || frontMatter.trim() === '') return {}
  const record = parseSimpleYaml(frontMatter)
  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const authority = text('authority')
  const origin = text('origin')
  const reviewStatus = text('reviewStatus')
  return {
    ...(text('title') === undefined ? {} : { title: text('title')! }),
    ...(text('type') === undefined ? {} : { type: text('type')! }),
    ...(authority !== undefined && AUTHORITIES.includes(authority as MemoryAuthority)
      ? { authority: authority as MemoryAuthority }
      : {}),
    ...(origin !== undefined && ORIGINS.includes(origin as MemoryOrigin)
      ? { origin: origin as MemoryOrigin }
      : {}),
    ...(reviewStatus !== undefined && REVIEW_STATUSES.includes(reviewStatus as MemoryReviewStatus)
      ? { reviewStatus: reviewStatus as MemoryReviewStatus }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Ordering and budget
// ---------------------------------------------------------------------------

/**
 * Priority tiers: redline, canonical, advisory proxies, advisory internalized.
 * Advisory internalized branches are the first thing a prompt budget gives up.
 */
function entryTier(entry: MemoryContextEntry): number {
  if (entry.nonOverridable || entry.authority === 'redline') return 0
  if (entry.authority === 'canonical') return 1
  if (entry.mode === 'subscribe') return 2
  return 3
}

function compareEntries(left: MemoryContextEntry, right: MemoryContextEntry): number {
  const tier = entryTier(left) - entryTier(right)
  if (tier !== 0) return tier
  const graph = compareText(left.graphId, right.graphId)
  if (graph !== 0) return graph
  const type = sourceTypeRank(left.sourceType) - sourceTypeRank(right.sourceType)
  if (type !== 0) return type
  return compareText(left.sourceId, right.sourceId)
}

function sourceTypeRank(sourceType: BindingSourceType): number {
  return sourceType === 'node' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEMORY_CONTEXT_MAX_CHARS
  return Math.max(0, Math.floor(value))
}

function strictestAuthority(...values: Array<MemoryAuthority | undefined>): MemoryAuthority {
  let authority: MemoryAuthority = 'advisory'
  for (const value of values) {
    if (value !== undefined && AUTHORITY_RANK[value] > AUTHORITY_RANK[authority]) authority = value
  }
  return authority
}

function graphCommit(graph: LoadedGraph): string | undefined {
  const withCommit = graph as LoadedGraph & { commit?: string }
  if (typeof withCommit.commit === 'string' && withCommit.commit !== '') return withCommit.commit
  const manifest = graph.manifest as GraphManifest & { commit?: string; sourceCommit?: string }
  if (typeof manifest.commit === 'string' && manifest.commit !== '') return manifest.commit
  if (typeof manifest.sourceCommit === 'string' && manifest.sourceCommit !== '') return manifest.sourceCommit
  return undefined
}