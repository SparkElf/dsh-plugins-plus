/**
 * Model-facing knowledge-graph tools (`kg_add` / `kg_get` / `kg_set` / `kg_del`).
 *
 * The four verbs mirror `kg.py`'s CLI. Two storage layouts are addressed through
 * the same Host seam the HTTP routes use: one grant per graph, `canWrite` before
 * every write, `readText` for every read, audit entries recorded beside the
 * caller's view, and `_trash` instead of deletion.
 *
 * - **Legacy folder graphs** (`<scope>/知识图谱/<graph>/<topic>/index.md`, relations
 *   under `.kg/links/`) keep their original behaviour untouched.
 * - **`.graphs/<id>/graph.json` graphs** (`format: 'graph-json'`) carry topology in
 *   the manifest and attributes in each node document's front matter. The tools
 *   read both, refuse duplicate ids / unknown endpoints / unsafe paths, and write
 *   the manifest through a temp-file rename; after every write the loaded graph is
 *   re-validated and the change is rolled back when the validator reports an error.
 *
 * Writes are two-step by design. A call without `confirm: true` returns the exact
 * draft it would write and changes nothing; the model shows that draft to the user
 * and calls again with `confirm: true` after approval. This is the §7 trigger rule
 * (user sovereignty) expressed in the tool protocol rather than in a hook.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  asKnowledgeToolError,
  KnowledgeToolError,
  type KnowledgeFileToolHost,
} from './knowledgeTools.ts'
import type { KnowledgeAuditEntry } from './views.ts'
import {
  bodyAfterSummary,
  firstSummary,
  parseGraphFrontMatter,
  parseGraphList,
} from './graph.ts'
import {
  parseNodeFrontMatter,
  validateGraph,
  type GraphManifest,
  type GraphManifestEdge,
  type GraphManifestNode,
  type GraphNodeAttributes,
  type GraphValidationIssue,
  type LoadedGraph,
  type LoadedGraphEdge,
  type LoadedGraphNode,
  type MemoryAuthority,
  type MemoryNodeType,
  type MemoryOrigin,
  type MemoryReviewStatus,
} from './graphModel.ts'
import type { KnowledgeGraphLink, KnowledgeGraphNode, KnowledgeGraphTopic } from './graphTypes.ts'

/** The Host operations graph tools compose. Actual paths are authoritative. */
export interface KnowledgeGraphToolHost extends Pick<
  KnowledgeFileToolHost,
  'resolveCaller' | 'canWrite' | 'createEntry' | 'overwriteFile' | 'moveEntry' | 'statEntry' | 'refreshView' | 'appendAudit' | 'viewDir'
> {
  /** Every graph the caller may read, with Host-only `actualPath`. */
  listGraphs(): Promise<KnowledgeGraphNode[]>
  /** Read one view-relative document through the permission-checked route. */
  readText(viewPath: string): Promise<string>
  /**
   * Read one knowledge-root-relative path that may be hidden from the view tree
   * (`.graphs/<id>/graph.json`, relation docs). The Host applies the same path
   * permission check as {@link readText}; absent means the Host cannot read
   * hidden paths and the tool falls back to the view spelling.
   */
  readActual?(relPath: string): Promise<string>
  /** Stat one knowledge-root-relative path, for the hidden `.graphs` store. */
  statActual?(relPath: string): Promise<{ kind: 'file' | 'directory'; size?: number } | undefined>
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const run = async (operation: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
  try {
    return await operation()
  } catch (error) {
    throw asKnowledgeToolError(error)
  }
}

/** Resolve one graph by id, path or unique name. */
function requireGraph(graphs: readonly KnowledgeGraphNode[], value: string): KnowledgeGraphNode {
  const needle = value.trim()
  const found = graphs.filter(graph => graph.id === needle || graph.path === needle || graph.name === needle)
  if (found.length === 1) return found[0]!
  if (found.length === 0) throw new KnowledgeToolError('not-found', 'no readable graph matches ' + JSON.stringify(needle))
  throw new KnowledgeToolError('invalid', 'the graph name is ambiguous; pass its path: '
    + found.map(graph => graph.path).join(', '))
}

/** Resolve one topic inside a graph by id or folder name. */
function requireTopic(graph: KnowledgeGraphNode, value: string): KnowledgeGraphTopic {
  const needle = value.trim()
  const found = graph.topics.filter(topic => topic.id === needle || topic.folder === needle)
  if (found.length === 1) return found[0]!
  if (found.length === 0) throw new KnowledgeToolError('not-found', 'no topic matches ' + JSON.stringify(needle) + ' in ' + graph.name)
  throw new KnowledgeToolError('invalid', 'the topic id is ambiguous in ' + graph.name)
}

/** Actual path of a graph, refusing a node the scanner did not anchor. */
function actualGraphPath(graph: KnowledgeGraphNode): string {
  if (graph.actualPath === undefined || graph.actualPath === '') {
    throw new KnowledgeToolError('not-configured', 'the graph has no authoritative path')
  }
  return graph.actualPath
}

/** Actual path of one topic folder. */
function topicActualPath(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): string {
  return actualGraphPath(graph) + '/' + topic.folder
}

/** Today as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Render one topic card. */
function renderCard(input: {
  id: string
  title: string
  status: string
  depth: number
  domain: string
  summary: string
  body: string
  updated?: string
}): string {
  return [
    '---',
    `id: ${input.id}`,
    `title: ${input.title}`,
    `status: ${input.status}`,
    `depth: ${input.depth}`,
    `domain: ${input.domain}`,
    `updated: ${input.updated ?? today()}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    input.summary.trim(),
    '',
    input.body.trim(),
    '',
  ].join('\n')
}

/** Render one relation document. */
function renderLink(input: { a: string; b: string; label?: string; body: string }): string {
  return [
    '---',
    `a: ${input.a}`,
    `b: ${input.b}`,
    ...(input.label === undefined || input.label.trim() === '' ? [] : [`label: ${input.label.trim()}`]),
    `updated: ${today()}`,
    '---',
    '',
    `# ${input.label?.trim() || input.a + ' ↔ ' + input.b}`,
    '',
    input.body.trim(),
    '',
  ].join('\n')
}

/** The view-relative path a tool result may expose. */
function topicViewPath(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): string {
  return graph.path + '/' + topic.folder
}

/** Record one graph action beside the caller's view. */
async function recordAudit(
  host: KnowledgeGraphToolHost,
  caller: { userId: string; label?: string },
  entry: Omit<KnowledgeAuditEntry, 'at' | 'actor' | 'actorLabel'>,
): Promise<{ written: boolean; reason?: string }> {
  try {
    await host.appendAudit(host.viewDir(caller.userId), {
      at: new Date().toISOString(),
      actor: caller.userId,
      ...(caller.label === undefined ? {} : { actorLabel: caller.label }),
      ...entry,
    })
    return { written: true }
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Validate a status value. */
function requireStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value !== 'active' && value !== 'paused' && value !== 'done') {
    throw new KnowledgeToolError('invalid', 'status must be active, paused or done')
  }
  return value
}

/** Validate a depth value. */
function requireDepth(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const depth = Number(value)
  if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
    throw new KnowledgeToolError('invalid', 'depth must be an integer from 1 to 5')
  }
  return depth
}

/** One topic as the summary list returns it. */
function topicSummary(graph: KnowledgeGraphNode, topic: KnowledgeGraphTopic): Record<string, unknown> {
  return {
    id: topic.id,
    title: topic.title,
    status: topic.status,
    depth: topic.depth,
    summary: topic.summary,
    path: topicViewPath(graph, topic),
    documents: topic.documents.length,
    relations: graph.links.filter(link => link.a === topic.id || link.b === topic.id).length,
  }
}

// ---------------------------------------------------------------------------
// `.graphs/<id>/graph.json` graphs (`format: 'graph-json'`)
// ---------------------------------------------------------------------------

/**
 * `readText` returns the Host preview window; anything larger is truncated.
 * Refusing an oversized document is the only safe answer: rewriting the visible
 * head would silently drop the tail of a node body or a manifest.
 */
const GRAPH_JSON_TEXT_LIMIT = 256 * 1024

/** A node/edge id is one safe path segment and one relation-file stem. */
const GRAPH_ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u

const NODE_TYPES: readonly MemoryNodeType[] = ['policy', 'fact', 'procedure', 'case', 'skill', 'decision', 'topic']
const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']

/** A graph node as the Projection publishes it: `format` is a runtime-only tag. */
type GraphNodeWithFormat = KnowledgeGraphNode & { format?: string }

/** The `.graphs/<id>` coordinates one graph-json graph is addressed in. */
interface GraphJsonStore {
  graph: KnowledgeGraphNode
  /** `.graphs/<id>` directory name (the manifest id is checked against it). */
  graphId: string
  /** View-relative scope base, e.g. `personal`. */
  viewBase: string
  /** Authoritative scope base, e.g. `personal/<uid>`. */
  actualBase: string
  /** View-relative store, e.g. `personal/.graphs/procurement`. */
  viewStorePath: string
  /** Authoritative store, e.g. `personal/<uid>/.graphs/procurement`. */
  actualStorePath: string
}

/** One loaded `.graphs` graph: manifest, nodes, edges and loader issues. */
interface GraphJsonState {
  store: GraphJsonStore
  /** The manifest object exactly as parsed, so unknown fields survive a rewrite. */
  raw: Record<string, unknown>
  manifest: GraphManifest
  nodes: LoadedGraphNode[]
  edges: LoadedGraphEdge[]
  issues: GraphValidationIssue[]
  manifestText: string
}

/** A manifest replacement that can be undone. */
interface ManifestCommit {
  previousText: string
  backupPath: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A manifest timestamp / trash suffix, safe as one path segment. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-')
}

function isSafeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('\\') && !value.includes('\0')
}

/** Whether a value is a portable `/`-separated path that cannot escape its root. */
function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) return false
  return value.split('/').every(isSafeSegment)
}

/** Whether a value may be a node body path: a visible `.md` document in the scope. */
function isSafeNodePath(value: unknown): value is string {
  if (!isSafeRelPath(value) || !value.toLowerCase().endsWith('.md')) return false
  const segments = value.split('/')
  // `.graphs`, `.kg`, `.archive` and `_trash` are plumbing, never node bodies.
  if (segments.some(segment => segment.startsWith('.'))) return false
  return !segments.some(segment => segment === '_trash')
}

/** Join a scope base with a scope-relative path, keeping `/` separators. */
function joinRel(base: string, relPath: string): string {
  return base === '' ? relPath : base + '/' + relPath
}

/** Split a `<base>/.graphs/<id>` path into base and id; undefined when it is not one. */
function storePathParts(value: string): { base: string; id: string } | undefined {
  const parts = value.split('/')
  if (parts.length < 2 || parts[parts.length - 2] !== '.graphs') return undefined
  const id = parts[parts.length - 1] ?? ''
  if (!isSafeSegment(id)) return undefined
  return { base: parts.slice(0, -2).join('/'), id }
}

/**
 * The store coordinates of a graph, or undefined for a legacy folder graph.
 *
 * Only `format === 'graph-json'` is accepted: guessing from a path spelling would
 * let a legacy graph with a coincidentally similar name be written as a manifest.
 */
function graphJsonStore(graph: KnowledgeGraphNode): GraphJsonStore | undefined {
  if ((graph as GraphNodeWithFormat).format !== 'graph-json') return undefined
  const actualPath = actualGraphPath(graph)
  const actual = storePathParts(actualPath)
  const view = storePathParts(graph.path)
  if (actual === undefined) {
    throw new KnowledgeToolError('not-configured', 'the graph-json graph has no .graphs/<id> actual path', graph.path)
  }
  if (view === undefined) {
    throw new KnowledgeToolError('not-configured', 'the graph-json graph has no .graphs/<id> view path', graph.path)
  }
  return {
    graph,
    graphId: actual.id,
    viewBase: view.base,
    actualBase: actual.base,
    viewStorePath: graph.path,
    actualStorePath: actualPath,
  }
}

/** The title fallback the loader uses: the file name without its extension. */
function titleFromPath(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

function errorIssue(code: GraphValidationIssue['code'], message: string, ref?: string): GraphValidationIssue {
  return ref === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, message, ref }
}

function warningIssue(code: GraphValidationIssue['code'], message: string, ref?: string): GraphValidationIssue {
  return ref === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, message, ref }
}

function defaultNodeAttributes(id: string, title: string): GraphNodeAttributes {
  return {
    id,
    type: 'fact',
    title,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
  }
}

/** Read one view/actual document, trying both spellings of the same file. */
async function readTextEither(
  host: KnowledgeGraphToolHost,
  viewPath: string,
  actualPath: string,
): Promise<string> {
  // `.graphs/` is plumbing and may be excluded from the view tree, so the
  // authoritative reader is tried first when the Host exposes one. The view
  // spelling stays as the fallback for a Host whose view already links it.
  if (host.readActual !== undefined && actualPath !== viewPath) {
    try {
      return await host.readActual(actualPath)
    } catch {
      // fall through to the view spelling
    }
  }
  const candidates = viewPath === actualPath ? [viewPath] : [viewPath, actualPath]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await host.readText(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw asKnowledgeToolError(lastError)
}

/** Read a document that lives at a scope-relative path. */
async function readScopeText(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  relPath: string,
): Promise<string> {
  return readTextEither(host, joinRel(store.viewBase, relPath), joinRel(store.actualBase, relPath))
}

/** Read a file inside `.graphs/<id>` by its path relative to the store. */
async function readStoreText(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  relPath: string,
): Promise<string> {
  return readTextEither(host, joinRel(store.viewStorePath, relPath), joinRel(store.actualStorePath, relPath))
}

/** Stat one authoritative document. A missing or unreadable path answers undefined. */
async function statFile(
  host: KnowledgeGraphToolHost,
  actualRelPath: string,
): Promise<{ kind: 'file' | 'directory'; size?: number } | undefined> {
  if (host.statActual !== undefined) {
    try {
      return await host.statActual(actualRelPath)
    } catch {
      return undefined
    }
  }
  try {
    return await host.statEntry(actualRelPath)
  } catch {
    return undefined
  }
}

/**
 * Split a document into front-matter lines and the body beneath the closing `---`.
 *
 * The body is kept as the raw remainder of the source, not re-joined line by
 * line: a front-matter-only edit must not normalise line endings or touch one
 * body byte.
 */
interface SplitDocument {
  hasBlock: boolean
  closed: boolean
  lines: string[]
  body: string
}

function splitDocument(source: string): SplitDocument {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const firstLineEnd = text.indexOf('\n')
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).replace(/\r$/u, '').trimEnd()
  if (firstLine !== '---') return { hasBlock: false, closed: false, lines: [], body: text }
  const lines: string[] = []
  let offset = firstLineEnd + 1
  while (offset <= text.length) {
    const lineEnd = text.indexOf('\n', offset)
    const rawLine = lineEnd === -1 ? text.slice(offset) : text.slice(offset, lineEnd)
    const line = rawLine.replace(/\r$/u, '')
    if (line.trimEnd() === '---') {
      return {
        hasBlock: true,
        closed: true,
        lines,
        body: lineEnd === -1 ? '' : text.slice(lineEnd + 1),
      }
    }
    lines.push(line)
    if (lineEnd === -1) break
    offset = lineEnd + 1
  }
  return { hasBlock: true, closed: false, lines, body: text }
}

/** Remove an unquoted trailing ` # comment` from one front-matter value. */
function stripComment(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') || value.startsWith("'")) return value
  const match = /\s+#/u.exec(value)
  return match === null ? value : value.slice(0, match.index).trimEnd()
}

/** Unquote one single- or double-quoted scalar; undefined when the quotes do not balance. */
function unquoteScalar(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length < 2) return undefined
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return undefined
  const inner = value.slice(1, -1)
  if (quote === "'") return inner.replace(/''/gu, "'")
  let result = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (char !== '\\') {
      result += char
      continue
    }
    const next = inner[index + 1]
    if (next === undefined) return undefined
    index += 1
    if (next === 'n') result += '\n'
    else if (next === 't') result += '\t'
    else if (next === 'r') result += '\r'
    else result += next
  }
  return result
}

/** Parse one `key: value` line per entry; the documented front-matter subset. */
function parseFrontMatterEntries(lines: readonly string[]): { values: Map<string, string>; errors: string[] } {
  const values = new Map<string, string>()
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/u.test(line)) {
      errors.push(`line ${index + 1}: nested YAML collections are not supported`)
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/u.exec(line)
    if (match === null) {
      errors.push(`line ${index + 1}: expected a "key: value" pair`)
      continue
    }
    const key = match[1] ?? ''
    if (values.has(key)) {
      errors.push(`line ${index + 1}: duplicate key "${key}"`)
      continue
    }
    values.set(key, (match[2] ?? '').trim())
  }
  return { values, errors }
}

/** Split `[a, "b, c"]` into its values; undefined when the array is malformed. */
function parseFlowArray(raw: string): string[] | undefined {
  const value = raw.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined
  const inner = value.slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (quote === '"') {
      current += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      current += char
      if (char === "'") {
        if (inner[index + 1] === "'") {
          current += inner[index + 1] ?? ''
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote !== undefined) return undefined
  items.push(current.trim())
  const values: string[] = []
  for (const item of items) {
    if (item === '') return undefined
    if (item.startsWith('"') || item.startsWith("'")) {
      const text = unquoteScalar(item)
      if (text === undefined) return undefined
      values.push(text)
      continue
    }
    if (item.includes('[') || item.includes(']')) return undefined
    values.push(item)
  }
  return values
}

/** Render a scalar for the front-matter subset, quoting anything that needs it. */
function yamlScalar(value: string): string {
  if (value === '') return '""'
  if (
    value.trim() === value
    && /^[A-Za-z0-9_\u4e00-\u9fff][^:#\n\r\t]*$/u.test(value)
    && !/^(?:true|false|null|~)$/iu.test(value)
  ) {
    return value
  }
  return JSON.stringify(value)
}

/** Render one inline array; an empty list stays `[]`. */
function renderStringArray(values: readonly string[]): string {
  return '[' + values.map(item => {
    if (item.trim() === item && /^[^,[\]'"#\n\r\t][^,[\]'"#\n\r\t]*$/u.test(item)) return item
    return JSON.stringify(item)
  }).join(', ') + ']'
}

/** Rewrite the managed keys of an existing front-matter block, preserving every other line. */
function rewriteFrontMatter(split: SplitDocument, fields: ReadonlyArray<readonly [string, string]>): string {
  const wanted = new Map(fields)
  const emitted = new Set<string>()
  const lines: string[] = []
  for (const line of split.lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:/u.exec(line)
    const key = match?.[1]
    if (key === undefined || !wanted.has(key)) {
      lines.push(line)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    lines.push(`${key}: ${wanted.get(key) ?? ''}`)
  }
  for (const [key, value] of fields) {
    if (emitted.has(key)) continue
    lines.push(`${key}: ${value}`)
  }
  return `---\n${lines.join('\n')}\n---\n${split.body}`
}

/** Render the canonical node front matter. */
function nodeFrontMatterFields(attributes: GraphNodeAttributes): Array<[string, string]> {
  return [
    ['id', yamlScalar(attributes.id)],
    ['type', attributes.type],
    ['title', yamlScalar(attributes.title)],
    ['authority', attributes.authority],
    ['internalizable', String(attributes.internalizable)],
    ['origin', attributes.origin],
    ['reviewStatus', attributes.reviewStatus],
    ['tags', renderStringArray(attributes.tags)],
    ['sourceRefs', renderStringArray(attributes.sourceRefs)],
  ]
}

/** Render a brand-new node document. */
function renderNodeDocument(attributes: GraphNodeAttributes, body: string): string {
  const fields = nodeFrontMatterFields(attributes).map(([key, value]) => `${key}: ${value}`)
  const text = body.trim()
  return `---\n${fields.join('\n')}\n---\n\n# ${attributes.title}\n\n${text}${text === '' ? '' : '\n'}`
}

/** Render a brand-new relation document. */
function renderEdgeDocument(input: {
  id: string
  from: string
  to: string
  type: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  title?: string
  tags?: readonly string[]
  sourceRefs?: readonly string[]
}, body: string): string {
  const fields = [
    `id: ${yamlScalar(input.id)}`,
    `from: ${yamlScalar(input.from)}`,
    `to: ${yamlScalar(input.to)}`,
    `type: ${yamlScalar(input.type)}`,
    `authority: ${input.authority}`,
    `internalizable: ${String(input.internalizable)}`,
    `origin: ${input.origin}`,
    `reviewStatus: ${input.reviewStatus}`,
  ]
  if (input.title !== undefined && input.title.trim() !== '') fields.splice(3, 0, `title: ${yamlScalar(input.title.trim())}`)
  if (input.tags !== undefined && input.tags.length > 0) fields.push(`tags: ${renderStringArray(input.tags)}`)
  if (input.sourceRefs !== undefined && input.sourceRefs.length > 0) fields.push(`sourceRefs: ${renderStringArray(input.sourceRefs)}`)
  const text = body.trim()
  return `---\n${fields.join('\n')}\n---\n${text === '' ? '' : '\n' + text + '\n'}`
}

/** The default relation-document path for one edge id. */
function edgeDocPath(graphId: string, edgeId: string): string {
  return `.graphs/${graphId}/links/${edgeId}.md`
}

/** Read one node body and merge its front matter with the manifest identity. */
async function loadGraphJsonNode(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  manifestNode: GraphManifestNode,
): Promise<{ node: LoadedGraphNode; issues: GraphValidationIssue[] }> {
  const issues: GraphValidationIssue[] = []
  const fallback = defaultNodeAttributes(manifestNode.id, titleFromPath(manifestNode.path))
  if (!isSafeNodePath(manifestNode.path)) {
    issues.push(errorIssue(
      'path-escape',
      `node "${manifestNode.id}" path "${manifestNode.path}" is not a safe scope-relative document path`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  const actualPath = joinRel(store.actualBase, manifestNode.path)
  const info = await statFile(host, actualPath)
  if (info === undefined || info.kind !== 'file') {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" does not exist`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" is larger than the ${String(GRAPH_JSON_TEXT_LIMIT)}-byte readable window`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  let source: string
  try {
    source = await readScopeText(host, store, manifestNode.path)
  } catch (error) {
    issues.push(errorIssue(
      'missing-node',
      `node "${manifestNode.id}" document "${manifestNode.path}" could not be read (${messageOf(error)})`,
      manifestNode.path,
    ))
    return { node: { ...fallback, path: manifestNode.path, missing: true }, issues }
  }
  const parsed = parseNodeDocument(source, manifestNode)
  issues.push(...parsed.issues)
  if (parsed.attributes.id !== manifestNode.id) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `node front matter id "${parsed.attributes.id}" does not match graph.json id "${manifestNode.id}"; graph.json wins`,
      manifestNode.path,
    ))
  }
  return {
    node: { ...parsed.attributes, id: manifestNode.id, path: manifestNode.path, missing: false },
    issues,
  }
}

/** Parse a node document, using the loader's fallbacks when it has no front matter. */
function parseNodeDocument(
  source: string,
  manifestNode: GraphManifestNode,
): { attributes: GraphNodeAttributes; body: string; issues: GraphValidationIssue[] } {
  const split = splitDocument(source)
  const fallback = defaultNodeAttributes(manifestNode.id, titleFromPath(manifestNode.path))
  const parsed = parseNodeFrontMatter(source)
  if (parsed.attributes !== null) {
    return { attributes: parsed.attributes, body: parsed.body, issues: parsed.issues }
  }
  // `loadGraph` treats an unannotated legacy document as a warning and fills the
  // defaults; only a present-but-invalid block is an error.
  const issues = split.hasBlock
    ? parsed.issues
    : parsed.issues.map(issue => ({ ...issue, severity: 'warning' as const }))
  return { attributes: fallback, body: split.body, issues }
}

interface EdgeAttributes {
  title: string
  authority: MemoryAuthority
  internalizable: boolean
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  tags: string[]
  sourceRefs: string[]
  /** The relation type written in the document, when it has one. */
  relationType?: string
  /** The id written in the document, when it has one. */
  documentId?: string
}

/** Parse one optional relation document. Its `type` is a free-form relation label. */
function parseEdgeDocument(
  source: string,
  edge: GraphManifestEdge,
  docPath: string,
): { attributes: EdgeAttributes; body: string; issues: GraphValidationIssue[] } {
  const split = splitDocument(source)
  const attributes: EdgeAttributes = {
    title: edge.id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
  }
  const issues: GraphValidationIssue[] = []
  if (!split.hasBlock) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge "${edge.id}" document has no front matter; defaults are used`,
      docPath,
    ))
    return { attributes, body: split.body, issues }
  }
  if (!split.closed) {
    issues.push(errorIssue(
      'invalid-frontmatter',
      `edge "${edge.id}" document front matter is not closed with ---`,
      docPath,
    ))
    return { attributes, body: split.body, issues }
  }

  const { values, errors } = parseFrontMatterEntries(split.lines)
  const fail = (message: string): void => {
    issues.push(errorIssue('invalid-frontmatter', `edge "${edge.id}" ${message}`, docPath))
  }
  for (const message of errors) fail(message)

  const readText = (key: string): string | undefined => {
    const raw = values.get(key)
    if (raw === undefined) return undefined
    const stripped = stripComment(raw)
    if (stripped.startsWith('"') || stripped.startsWith("'")) {
      const text = unquoteScalar(stripped)
      if (text === undefined) fail(`front matter "${key}" has unbalanced quotes`)
      return text
    }
    return stripped
  }
  const readArray = (key: string): string[] | undefined => {
    const raw = values.get(key)
    if (raw === undefined) return undefined
    const stripped = stripComment(raw)
    const items = parseFlowArray(stripped)
    if (items === undefined) fail(`front matter "${key}" must be an inline array such as [a, b]`)
    return items
  }
  const readEnum = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = readText(key)
    if (raw === undefined) return fallback
    if (!(allowed as readonly string[]).includes(raw)) {
      fail(`front matter "${key}" must be one of ${allowed.join(', ')}`)
      return fallback
    }
    return raw as T
  }

  const documentId = readText('id')
  if (documentId !== undefined && documentId !== edge.id) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge front matter id "${documentId}" does not match graph.json id "${edge.id}"; graph.json wins`,
      docPath,
    ))
  }
  const relationType = readText('type')
  if (relationType !== undefined && relationType !== edge.type) {
    issues.push(warningIssue(
      'invalid-frontmatter',
      `edge front matter type "${relationType}" does not match graph.json type "${edge.type}"; graph.json wins`,
      docPath,
    ))
  }
  const internalizableRaw = readText('internalizable')
  let internalizable = true
  if (internalizableRaw !== undefined) {
    if (internalizableRaw !== 'true' && internalizableRaw !== 'false') {
      fail('front matter "internalizable" must be true or false')
    } else {
      internalizable = internalizableRaw === 'true'
    }
  }

  attributes.title = readText('title') ?? edge.id
  attributes.authority = readEnum('authority', AUTHORITIES, 'advisory')
  attributes.internalizable = internalizable
  attributes.origin = readEnum('origin', ORIGINS, 'human')
  attributes.reviewStatus = readEnum('reviewStatus', REVIEW_STATUSES, 'draft')
  attributes.tags = readArray('tags') ?? []
  attributes.sourceRefs = readArray('sourceRefs') ?? []
  if (documentId !== undefined) attributes.documentId = documentId
  if (relationType !== undefined) attributes.relationType = relationType

  return { attributes, body: split.body, issues }
}

/** Read one edge and its optional relation document. */
async function loadGraphJsonEdge(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  manifestEdge: GraphManifestEdge,
): Promise<{ edge: LoadedGraphEdge; issues: GraphValidationIssue[] }> {
  const issues: GraphValidationIssue[] = []
  const fallback: LoadedGraphEdge = {
    id: manifestEdge.id,
    type: manifestEdge.type,
    from: manifestEdge.from,
    to: manifestEdge.to,
    title: manifestEdge.id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: [],
    sourceRefs: [],
    missing: false,
  }
  const explicit = manifestEdge.doc !== undefined
  const candidate = manifestEdge.doc ?? edgeDocPath(store.graphId, manifestEdge.id)
  if (!isSafeRelPath(candidate)) {
    issues.push(errorIssue(
      'path-escape',
      `edge "${manifestEdge.id}" document path "${candidate}" is not a safe scope-relative path`,
      candidate,
    ))
    return { edge: { ...fallback, missing: true }, issues }
  }
  const info = await statFile(host, joinRel(store.actualBase, candidate))
  if (info === undefined || info.kind !== 'file') {
    if (explicit) {
      issues.push(warningIssue(
        'missing-edge-doc',
        `edge "${manifestEdge.id}" document "${candidate}" does not exist`,
        candidate,
      ))
      return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
    }
    // A topology-only edge is valid; there is no document to report.
    return { edge: fallback, issues }
  }
  if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    issues.push(warningIssue(
      'missing-edge-doc',
      `edge "${manifestEdge.id}" document "${candidate}" is larger than the readable window; defaults are used`,
      candidate,
    ))
    return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
  }
  let source: string
  try {
    source = await readScopeText(host, store, candidate)
  } catch (error) {
    issues.push(warningIssue(
      'missing-edge-doc',
      `edge "${manifestEdge.id}" document "${candidate}" could not be read (${messageOf(error)})`,
      candidate,
    ))
    return { edge: { ...fallback, docPath: candidate, missing: true }, issues }
  }
  const parsed = parseEdgeDocument(source, manifestEdge, candidate)
  issues.push(...parsed.issues)
  return {
    edge: {
      ...fallback,
      title: parsed.attributes.title,
      authority: parsed.attributes.authority,
      internalizable: parsed.attributes.internalizable,
      origin: parsed.attributes.origin,
      reviewStatus: parsed.attributes.reviewStatus,
      tags: parsed.attributes.tags,
      sourceRefs: parsed.attributes.sourceRefs,
      docPath: candidate,
      missing: false,
    },
    issues,
  }
}

/** Validate one parsed `graph.json` object and return it with typed nodes/edges. */
function parseManifestRecord(text: string, graphId: string): { record: Record<string, unknown>; manifest: GraphManifest } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new KnowledgeToolError('invalid', 'graph.json is not valid JSON: ' + messageOf(error), graphId)
  }
  if (!isRecord(parsed)) throw new KnowledgeToolError('invalid', 'graph.json must contain a JSON object', graphId)
  if (parsed.schemaVersion !== 1) throw new KnowledgeToolError('invalid', 'graph.json "schemaVersion" must be 1', graphId)
  if (typeof parsed.id !== 'string' || parsed.id !== graphId) {
    throw new KnowledgeToolError(
      'invalid',
      `graph.json id ${JSON.stringify(parsed.id)} does not match its .graphs directory "${graphId}"`,
      graphId,
    )
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new KnowledgeToolError('invalid', 'graph.json "nodes" and "edges" must be arrays', graphId)
  }
  parsed.nodes.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '' || typeof item.path !== 'string' || item.path.trim() === '') {
      throw new KnowledgeToolError('invalid', `graph.json "nodes[${index}]" must have a non-empty "id" and "path"`, graphId)
    }
  })
  parsed.edges.forEach((item, index) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string' || item.id.trim() === ''
      || typeof item.from !== 'string' || item.from.trim() === ''
      || typeof item.to !== 'string' || item.to.trim() === ''
      || typeof item.type !== 'string' || item.type.trim() === ''
    ) {
      throw new KnowledgeToolError('invalid', `graph.json "edges[${index}]" must have non-empty "id", "from", "to" and "type"`, graphId)
    }
    if (item.doc !== undefined && typeof item.doc !== 'string') {
      throw new KnowledgeToolError('invalid', `graph.json "edges[${index}].doc" must be a string`, graphId)
    }
  })
  return { record: parsed, manifest: parsed as unknown as GraphManifest }
}

/** Load one `.graphs/<id>` graph: manifest, every referenced document, and issues. */
async function loadGraphJsonState(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
): Promise<GraphJsonState> {
  const manifestInfo = await statFile(host, joinRel(store.actualStorePath, 'graph.json'))
  if (manifestInfo === undefined || manifestInfo.kind !== 'file') {
    throw new KnowledgeToolError('not-found', 'the graph has no graph.json', store.graph.path)
  }
  if ((manifestInfo.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
    throw new KnowledgeToolError(
      'too-large',
      `graph.json is larger than the ${String(GRAPH_JSON_TEXT_LIMIT)}-byte readable window`,
      store.graph.path,
    )
  }
  const manifestText = await readStoreText(host, store, 'graph.json')
  const { record, manifest } = parseManifestRecord(manifestText, store.graphId)

  const nodes: LoadedGraphNode[] = []
  const edges: LoadedGraphEdge[] = []
  const issues: GraphValidationIssue[] = []
  for (const manifestNode of manifest.nodes) {
    const loaded = await loadGraphJsonNode(host, store, manifestNode)
    nodes.push(loaded.node)
    issues.push(...loaded.issues)
  }
  for (const manifestEdge of manifest.edges) {
    const loaded = await loadGraphJsonEdge(host, store, manifestEdge)
    edges.push(loaded.edge)
    issues.push(...loaded.issues)
  }
  return { store, raw: record, manifest, nodes, edges, issues, manifestText }
}

/** The `LoadedGraph` shape `validateGraph` recomputes from (it ignores `root`). */
function loadedGraphOf(state: GraphJsonState): LoadedGraph {
  return {
    manifest: state.manifest,
    root: state.store.actualBase,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
  }
}

/** Reload the graph and return the validator's error-level issues. */
async function validateGraphStore(host: KnowledgeGraphToolHost, store: GraphJsonStore): Promise<GraphValidationIssue[]> {
  let state: GraphJsonState
  try {
    state = await loadGraphJsonState(host, store)
  } catch (error) {
    throw new KnowledgeToolError('invalid', 'the graph could not be reloaded after the write: ' + messageOf(error), store.graph.path)
  }
  return validateGraph(loadedGraphOf(state))
}

/** Wrap a validator result as the refusal a rolled-back write reports. */
function requireValidGraph(issues: readonly GraphValidationIssue[], store: GraphJsonStore): void {
  if (issues.length === 0) return
  throw new KnowledgeToolError(
    'invalid',
    'the write was rolled back because the graph validator reported: '
      + issues.map(issue => issue.message).join('; '),
    store.graph.path,
  )
}

/**
 * Replace `graph.json` through a temp file and a rename.
 *
 * The old manifest is kept under `_trash/manifests/`: a rename cannot overwrite
 * on every platform without a backup, and keeping it makes the rollback path
 * (restore on a validator error) exact instead of a re-serialisation.
 */
async function commitManifest(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  record: Record<string, unknown>,
  previousText: string,
): Promise<ManifestCommit> {
  const content = JSON.stringify(record, null, 2) + '\n'
  const current = joinRel(store.actualStorePath, 'graph.json')
  const tag = stamp()
  const temporary = joinRel(store.actualStorePath, '.tmp/graph.json.' + tag)
  const backup = joinRel(store.actualStorePath, '_trash/manifests/graph.json.' + tag)
  await host.createEntry(temporary, { directory: false, content })
  await host.moveEntry(current, backup, caller)
  try {
    await host.moveEntry(temporary, current, caller)
  } catch (error) {
    await host.moveEntry(backup, current, caller).catch(() => undefined)
    throw error
  }
  return { previousText, backupPath: backup }
}

/** Undo {@link commitManifest}, leaving the replaced bytes under `_trash/manifests/`. */
async function rollbackManifest(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  commit: ManifestCommit,
): Promise<void> {
  const current = joinRel(store.actualStorePath, 'graph.json')
  const aside = joinRel(store.actualStorePath, '_trash/manifests/graph.json.rollback-' + stamp())
  try {
    await host.moveEntry(current, aside, caller)
  } catch {
    // The failed commit may have left no graph.json; the backup is still the truth.
  }
  try {
    await host.moveEntry(commit.backupPath, current, caller)
    return
  } catch {
    // Fall through to a byte-for-byte restore of the text the tool read.
  }
  try {
    await host.overwriteFile(current, commit.previousText)
  } catch {
    await host.createEntry(current, { directory: false, content: commit.previousText })
  }
}

/** Move one authoritative document into the graph store's `_trash/<bucket>/`. */
async function moveToTrash(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  caller: { userId: string; label?: string },
  actualFrom: string,
  bucket: string,
  name: string,
): Promise<{ from: string; to: string }> {
  const safeName = name.replace(/[/\\]/gu, '-').trim() || 'entry'
  const to = joinRel(store.actualStorePath, `_trash/${bucket}/${safeName}`)
  await host.moveEntry(actualFrom, to, caller)
  return { from: actualFrom, to }
}

/** Undo a list of trash moves, newest first. */
async function restoreTrashMoves(
  host: KnowledgeGraphToolHost,
  caller: { userId: string; label?: string },
  moves: readonly { from: string; to: string }[],
): Promise<void> {
  for (const move of [...moves].reverse()) {
    await host.moveEntry(move.to, move.from, caller).catch(() => undefined)
  }
}

/** Require write access to the graph store and (when given) the document it touches. */
async function requireGraphJsonWrite(
  host: KnowledgeGraphToolHost,
  store: GraphJsonStore,
  extraPath?: string,
): Promise<{ userId: string; label?: string }> {
  if (!await host.canWrite(store.actualStorePath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this graph', store.graph.path)
  }
  if (extraPath !== undefined && extraPath !== store.actualStorePath && !await host.canWrite(extraPath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this document', extraPath)
  }
  return host.resolveCaller()
}

/** The next manifest object: nodes/edges replaced, version bumped, timestamp refreshed. */
function nextManifestRecord(
  state: GraphJsonState,
  nodes: readonly GraphManifestNode[],
  edges: readonly GraphManifestEdge[],
): Record<string, unknown> {
  const version = typeof state.raw.version === 'number' && Number.isFinite(state.raw.version)
    ? state.raw.version + 1
    : 1
  return {
    ...state.raw,
    version,
    updatedAt: new Date().toISOString(),
    nodes: nodes.map(node => ({ id: node.id, path: node.path })),
    edges: edges.map(edge => (
      edge.doc === undefined
        ? { id: edge.id, from: edge.from, to: edge.to, type: edge.type }
        : { id: edge.id, from: edge.from, to: edge.to, type: edge.type, doc: edge.doc }
    )),
  }
}

function stringListArg(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new KnowledgeToolError('invalid', field + ' must be an array of strings')
  }
  return (value as string[]).map(item => item.trim()).filter(item => item !== '')
}

function booleanArg(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new KnowledgeToolError('invalid', field + ' must be true or false')
  return value
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value.trim() : ''
  if (!(allowed as readonly string[]).includes(text)) {
    throw new KnowledgeToolError('invalid', field + ' must be one of ' + allowed.join(', '))
  }
  return text as T
}

/** Which node/edge a graph-json `kg_get`/`kg_set`/`kg_del` call names. */
function resolveGraphJsonTarget(
  state: GraphJsonState,
  id: string,
  kind: string | undefined,
): { node?: LoadedGraphNode; edge?: LoadedGraphEdge } {
  const node = state.nodes.find(item => item.id === id)
  const edge = state.edges.find(item => item.id === id)
  if (kind === 'node') {
    if (node === undefined) throw new KnowledgeToolError('not-found', 'no node has this id', id)
    return { node }
  }
  if (kind === 'edge') {
    if (edge === undefined) throw new KnowledgeToolError('not-found', 'no edge has this id', id)
    return { edge }
  }
  if (kind !== undefined && kind !== '') {
    throw new KnowledgeToolError('invalid', 'kind must be node or edge', id)
  }
  if (node !== undefined && edge !== undefined) {
    throw new KnowledgeToolError('invalid', 'a node and an edge share this id; pass kind to disambiguate', id)
  }
  if (node !== undefined) return { node }
  if (edge !== undefined) return { edge }
  throw new KnowledgeToolError('not-found', 'no node or edge has this id', id)
}

/** Whether any node or edge already uses an id. */
function graphJsonIdTaken(state: GraphJsonState, id: string): boolean {
  return state.nodes.some(node => node.id === id) || state.edges.some(edge => edge.id === id)
}

/** The view-relative path of a node body. */
function nodeViewPath(store: GraphJsonStore, node: { path: string }): string {
  return joinRel(store.viewBase, node.path)
}

/** One node as `kg_get` lists it. */
function nodeSummary(store: GraphJsonStore, node: LoadedGraphNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    authority: node.authority,
    internalizable: node.internalizable,
    origin: node.origin,
    reviewStatus: node.reviewStatus,
    tags: node.tags,
    sourceRefs: node.sourceRefs,
    path: nodeViewPath(store, node),
    manifestPath: node.path,
    missing: node.missing,
  }
}

/** One edge as `kg_get` lists it. */
function edgeSummary(store: GraphJsonStore, edge: LoadedGraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    title: edge.title,
    authority: edge.authority,
    internalizable: edge.internalizable,
    origin: edge.origin,
    reviewStatus: edge.reviewStatus,
    tags: edge.tags,
    sourceRefs: edge.sourceRefs,
    doc: edge.docPath,
    path: edge.docPath === undefined ? undefined : joinRel(store.viewBase, edge.docPath),
    missing: edge.missing,
  }
}

/** `kg_add` for a `.graphs/<id>/graph.json` graph. */
async function addToGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: {
    kind: string; id?: string; title?: string; path?: string; type?: string; authority?: string
    internalizable?: boolean; origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]
    body?: string; from?: string; to?: string; confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const id = (args.id ?? '').trim()
  if (!GRAPH_ITEM_ID.test(id)) {
    throw new KnowledgeToolError('invalid', 'id must be 1-64 lowercase letters, digits or hyphens', id === '' ? undefined : id)
  }
  if (graphJsonIdTaken(state, id)) {
    throw new KnowledgeToolError('exists', 'an item with this id already exists', id)
  }
  const body = args.body ?? ''

  if (args.kind === 'node') {
    const nodePath = (args.path ?? '').trim()
    if (!isSafeNodePath(nodePath)) {
      throw new KnowledgeToolError(
        'invalid',
        'path must be a scope-relative .md document path outside .graphs, .kg and _trash',
        nodePath === '' ? undefined : nodePath,
      )
    }
    if (state.nodes.some(node => node.path === nodePath)) {
      throw new KnowledgeToolError('exists', 'a node already references this path', nodePath)
    }
    const title = (args.title ?? '').trim()
    if (title === '') throw new KnowledgeToolError('invalid', 'title is required')
    const attributes: GraphNodeAttributes = {
      id,
      type: enumArg(args.type, NODE_TYPES, 'type') ?? 'fact',
      title,
      authority: enumArg(args.authority, AUTHORITIES, 'authority') ?? 'advisory',
      internalizable: booleanArg(args.internalizable, 'internalizable') ?? true,
      origin: enumArg(args.origin, ORIGINS, 'origin') ?? 'human',
      reviewStatus: enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? 'draft',
      tags: stringListArg(args.tags, 'tags') ?? [],
      sourceRefs: stringListArg(args.sourceRefs, 'sourceRefs') ?? [],
    }
    const content = renderNodeDocument(attributes, body)
    const viewPath = joinRel(store.viewBase, nodePath)
    const actualPath = joinRel(store.actualBase, nodePath)
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'add', kind: 'node', format: 'graph-json',
        graph: graph.path, id, path: viewPath, manifestPath: nodePath, content,
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    if (await statFile(host, actualPath) !== undefined) {
      throw new KnowledgeToolError('exists', 'a document already exists at this path', nodePath)
    }
    await host.createEntry(actualPath, { directory: false, content })
    // The post-write validator reads the new document back through the caller's
    // view; a fresh file only appears there after the view sync this write forces.
    await host.refreshView(actualPath).catch(() => undefined)
    const nodes = [...state.manifest.nodes, { id, path: nodePath }]
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, nodes, state.manifest.edges), state.manifestText)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await rollbackManifest(host, store, caller, commit)
      await moveToTrash(host, store, caller, actualPath, 'rejected/nodes', `${stamp()}-${id}-${titleFromPath(nodePath)}`).catch(() => undefined)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'create', relPath: viewPath, tool: 'kg_add', graphId: graph.path,
      topicId: id, intent: 'new graph node', diffSummary: 'created node ' + title, outcome: 'applied',
    })
    return { ok: true, action: 'add', kind: 'node', format: 'graph-json', graph: graph.path, id, path: viewPath, manifestPath: nodePath, audit }
  }

  if (args.kind === 'edge') {
    const from = (args.from ?? '').trim()
    const to = (args.to ?? '').trim()
    if (from === '' || to === '') throw new KnowledgeToolError('invalid', 'from and to are required', id)
    if (from === to) throw new KnowledgeToolError('invalid', 'from and to must be different nodes', id)
    for (const endpoint of [from, to]) {
      if (!state.nodes.some(node => node.id === endpoint)) {
        throw new KnowledgeToolError('not-found', 'edge endpoint is not a node in this graph: ' + endpoint, endpoint)
      }
    }
    const type = (args.type ?? '').trim()
    if (type === '') throw new KnowledgeToolError('invalid', 'type (the relation label) is required for an edge', id)
    const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? 'advisory'
    const internalizable = booleanArg(args.internalizable, 'internalizable') ?? true
    const origin = enumArg(args.origin, ORIGINS, 'origin') ?? 'human'
    const reviewStatus = enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? 'draft'
    const title = (args.title ?? '').trim()
    const wantsDoc = body.trim() !== ''
      || args.authority !== undefined || args.internalizable !== undefined
      || args.origin !== undefined || args.reviewStatus !== undefined
      || args.tags !== undefined || args.sourceRefs !== undefined || title !== ''
    const docPath = edgeDocPath(store.graphId, id)
    const content = wantsDoc
      ? renderEdgeDocument({
        id, from, to, type, authority, internalizable, origin, reviewStatus,
        ...(title === '' ? {} : { title }),
        ...(args.tags === undefined ? {} : { tags: stringListArg(args.tags, 'tags') ?? [] }),
        ...(args.sourceRefs === undefined ? {} : { sourceRefs: stringListArg(args.sourceRefs, 'sourceRefs') ?? [] }),
      }, body)
      : undefined
    const viewPath = joinRel(store.viewBase, docPath)
    const actualPath = joinRel(store.actualBase, docPath)
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'add', kind: 'edge', format: 'graph-json',
        graph: graph.path, id, from, to, type,
        ...(content === undefined ? {} : { doc: docPath, content }),
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    if (content !== undefined) {
      if (await statFile(host, actualPath) !== undefined) {
        throw new KnowledgeToolError('exists', 'a relation document already exists at this path', docPath)
      }
      await host.createEntry(actualPath, { directory: false, content })
      // Same reason as a node: the validator reads the relation document through
      // the caller's view, which only knows the file after a sync.
      await host.refreshView(actualPath).catch(() => undefined)
    }
    const edges = [...state.manifest.edges, {
      id, from, to, type,
      ...(content === undefined ? {} : { doc: docPath }),
    }]
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await rollbackManifest(host, store, caller, commit)
      if (content !== undefined) {
        await moveToTrash(host, store, caller, actualPath, 'rejected/links', `${stamp()}-${id}.md`).catch(() => undefined)
      }
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'create', relPath: content === undefined ? graph.path : viewPath, tool: 'kg_add',
      graphId: graph.path, topicId: id, intent: 'new graph edge', diffSummary: `linked ${from} -> ${to} (${type})`,
      outcome: 'applied',
    })
    return {
      ok: true, action: 'add', kind: 'edge', format: 'graph-json', graph: graph.path, id, from, to, type,
      ...(content === undefined ? {} : { path: viewPath, doc: docPath }), audit,
    }
  }

  throw new KnowledgeToolError('invalid', 'kind must be node or edge for a graph-json graph')
}

/** `kg_get` for a `.graphs/<id>/graph.json` graph. */
async function getFromGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const header = {
    id: graph.id,
    name: graph.name,
    scope: graph.scope,
    group: graph.group,
    path: graph.path,
    format: 'graph-json',
    counts: graph.counts,
  }
  if (id === undefined || id.trim() === '') {
    return {
      ok: true,
      graph: header,
      nodes: state.nodes.map(node => nodeSummary(store, node)),
      edges: state.edges.map(edge => edgeSummary(store, edge)),
      issues: state.issues,
    }
  }
  const target = resolveGraphJsonTarget(state, id.trim(), undefined)
  if (target.node !== undefined) {
    const node = target.node
    let summary: string | undefined
    let body: string | undefined
    if (!node.missing) {
      try {
        const source = await readScopeText(host, store, node.path)
        const split = splitDocument(source)
        summary = firstSummary(split.body)
        body = split.body
      } catch {
        // The node was loaded as missing; the summary is simply not available.
      }
    }
    return {
      ok: true,
      graph: header,
      node: {
        ...nodeSummary(store, node),
        ...(summary === undefined ? {} : { summary }),
        ...(body === undefined ? {} : { body }),
      },
      edges: state.edges.filter(edge => edge.from === node.id || edge.to === node.id).map(edge => edgeSummary(store, edge)),
      issues: state.issues,
    }
  }
  const edge = target.edge!
  return { ok: true, graph: header, edge: edgeSummary(store, edge), issues: state.issues }
}

/** `kg_set` for a `.graphs/<id>/graph.json` graph: front matter and relation documents only. */
async function setOnGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: {
    id: string; kind?: string; title?: string; domain?: string; status?: string; depth?: number
    summary?: string; body?: string; type?: string; authority?: string; internalizable?: boolean
    origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; confirm?: boolean
  },
): Promise<Record<string, unknown>> {
  const state = await loadGraphJsonState(host, store)
  const target = resolveGraphJsonTarget(state, args.id.trim(), args.kind)

  if (target.node !== undefined) {
    const node = target.node
    const unsupported = [
      args.domain === undefined ? undefined : 'domain',
      args.status === undefined ? undefined : 'status',
      args.depth === undefined ? undefined : 'depth',
      args.summary === undefined ? undefined : 'summary',
      args.body === undefined ? undefined : 'body',
    ].filter((field): field is string => field !== undefined)
    if (unsupported.length > 0) {
      throw new KnowledgeToolError(
        'invalid',
        'a graph-json node has no card fields to edit (' + unsupported.join(', ')
          + '); pass title/type/authority/internalizable/origin/reviewStatus/tags/sourceRefs',
        node.id,
      )
    }
    if (node.missing) throw new KnowledgeToolError('not-found', 'the node document is missing; add it first', node.path)
    const type = enumArg(args.type, NODE_TYPES, 'type') ?? node.type
    const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? node.authority
    const internalizable = booleanArg(args.internalizable, 'internalizable') ?? node.internalizable
    const origin = enumArg(args.origin, ORIGINS, 'origin') ?? node.origin
    const reviewStatus = enumArg(args.reviewStatus, REVIEW_STATUSES, 'reviewStatus') ?? node.reviewStatus
    const tags = stringListArg(args.tags, 'tags') ?? node.tags
    const sourceRefs = stringListArg(args.sourceRefs, 'sourceRefs') ?? node.sourceRefs
    const title = (args.title ?? node.title).trim()
    if (title === '') throw new KnowledgeToolError('invalid', 'title must not be empty', node.id)
    const after: GraphNodeAttributes = {
      id: node.id, type, title, authority, internalizable, origin, reviewStatus, tags, sourceRefs,
    }
    const changed = (Object.keys(after) as Array<keyof GraphNodeAttributes>)
      .filter(key => key !== 'id' && JSON.stringify(after[key]) !== JSON.stringify(node[key]))
    if (changed.length === 0) throw new KnowledgeToolError('invalid', 'no attribute would change', node.id)

    const actualPath = joinRel(store.actualBase, node.path)
    const viewPath = nodeViewPath(store, node)
    const info = await statFile(host, actualPath)
    if (info === undefined || info.kind !== 'file') throw new KnowledgeToolError('not-found', 'the node document is missing', node.path)
    if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
      throw new KnowledgeToolError('too-large', 'the node document is larger than the readable window', node.path)
    }
    const previous = await readScopeText(host, store, node.path)
    const split = splitDocument(previous)
    if (split.hasBlock && !split.closed) {
      throw new KnowledgeToolError('invalid', 'the node front matter block is not closed with ---', node.path)
    }
    const content = rewriteFrontMatter(split, nodeFrontMatterFields(after))
    const before = {
      title: node.title, type: node.type, authority: node.authority, internalizable: node.internalizable,
      origin: node.origin, reviewStatus: node.reviewStatus, tags: node.tags, sourceRefs: node.sourceRefs,
    }
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, action: 'set', kind: 'node', format: 'graph-json',
        graph: graph.path, id: node.id, path: viewPath, before, after, content,
        next: 'show this draft to the user; call again with confirm:true to write it',
      }
    }
    const caller = await requireGraphJsonWrite(host, store, actualPath)
    await host.overwriteFile(actualPath, content)
    try {
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await host.overwriteFile(actualPath, previous)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'edit', relPath: viewPath, tool: 'kg_set', graphId: graph.path, topicId: node.id,
      intent: 'update node attributes', diffSummary: 'updated ' + changed.join(', '), outcome: 'applied',
    })
    return { ok: true, action: 'set', kind: 'node', format: 'graph-json', graph: graph.path, id: node.id, after, audit }
  }

  const edge = target.edge!
  const unsupported = [
    args.title === undefined ? undefined : 'title',
    args.domain === undefined ? undefined : 'domain',
    args.status === undefined ? undefined : 'status',
    args.depth === undefined ? undefined : 'depth',
    args.summary === undefined ? undefined : 'summary',
    args.origin === undefined ? undefined : 'origin',
    args.reviewStatus === undefined ? undefined : 'reviewStatus',
    args.tags === undefined ? undefined : 'tags',
    args.sourceRefs === undefined ? undefined : 'sourceRefs',
  ].filter((field): field is string => field !== undefined)
  if (unsupported.length > 0) {
    throw new KnowledgeToolError(
      'invalid',
      'a graph-json edge only supports type, authority, internalizable and a relation-document body (got '
        + unsupported.join(', ') + ')',
      edge.id,
    )
  }
  const type = (args.type ?? edge.type).trim()
  if (type === '') throw new KnowledgeToolError('invalid', 'type must not be empty', edge.id)
  const authority = enumArg(args.authority, AUTHORITIES, 'authority') ?? edge.authority
  const internalizable = booleanArg(args.internalizable, 'internalizable') ?? edge.internalizable
  const body = args.body
  const changed: string[] = []
  if (type !== edge.type) changed.push('type')
  if (authority !== edge.authority) changed.push('authority')
  if (internalizable !== edge.internalizable) changed.push('internalizable')
  if (body !== undefined) changed.push('body')
  if (changed.length === 0) throw new KnowledgeToolError('invalid', 'no edge field would change', edge.id)

  const manifestDoc = edge.docPath ?? edgeDocPath(store.graphId, edge.id)
  const actualDoc = joinRel(store.actualBase, manifestDoc)
  const viewDoc = joinRel(store.viewBase, manifestDoc)
  let previousDoc: string | undefined
  if (!edge.missing && edge.docPath !== undefined) {
    const info = await statFile(host, actualDoc)
    if (info !== undefined && info.kind === 'file') {
      if ((info.size ?? 0) > GRAPH_JSON_TEXT_LIMIT) {
        throw new KnowledgeToolError('too-large', 'the relation document is larger than the readable window', manifestDoc)
      }
      previousDoc = await readScopeText(host, store, manifestDoc)
    }
  }
  let content: string
  if (previousDoc !== undefined) {
    const split = splitDocument(previousDoc)
    if (split.hasBlock && !split.closed) {
      throw new KnowledgeToolError('invalid', 'the relation front matter block is not closed with ---', manifestDoc)
    }
    const fields = [
      ['id', yamlScalar(edge.id)],
      ['from', yamlScalar(edge.from)],
      ['to', yamlScalar(edge.to)],
      ['type', yamlScalar(type)],
      ['authority', authority],
      ['internalizable', String(internalizable)],
    ] as Array<[string, string]>
    content = rewriteFrontMatter(split, fields)
    if (body !== undefined) content = content.slice(0, content.length - split.body.length) + (body.trim() === '' ? '' : '\n' + body.trim() + '\n')
  } else {
    content = renderEdgeDocument({
      id: edge.id, from: edge.from, to: edge.to, type, authority, internalizable,
      origin: edge.origin, reviewStatus: edge.reviewStatus,
      ...(edge.tags.length === 0 ? {} : { tags: edge.tags }),
      ...(edge.sourceRefs.length === 0 ? {} : { sourceRefs: edge.sourceRefs }),
    }, body ?? '')
  }

  if (args.confirm !== true) {
    return {
      ok: true, draft: true, action: 'set', kind: 'edge', format: 'graph-json',
      graph: graph.path, id: edge.id, doc: manifestDoc, before: {
        type: edge.type, authority: edge.authority, internalizable: edge.internalizable, missing: edge.missing,
      }, after: { type, authority, internalizable }, content,
      next: 'show this draft to the user; call again with confirm:true to write it',
    }
  }
  const caller = await requireGraphJsonWrite(host, store, actualDoc)
  if (previousDoc === undefined) {
    if (await statFile(host, actualDoc) !== undefined) {
      throw new KnowledgeToolError('exists', 'a relation document already exists at this path', manifestDoc)
    }
    await host.createEntry(actualDoc, { directory: false, content })
    await host.refreshView(actualDoc).catch(() => undefined)
  } else {
    await host.overwriteFile(actualDoc, content)
  }
  const manifestChanged = type !== edge.type || edge.docPath === undefined
  let commit: ManifestCommit | undefined
  if (manifestChanged) {
    const edges = state.manifest.edges.map(item => {
      if (item.id !== edge.id) return item
      return { id: item.id, from: item.from, to: item.to, type, doc: item.doc ?? manifestDoc }
    })
    commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
  }
  try {
    requireValidGraph(await validateGraphStore(host, store), store)
  } catch (error) {
    if (commit !== undefined) await rollbackManifest(host, store, caller, commit)
    if (previousDoc !== undefined) await host.overwriteFile(actualDoc, previousDoc)
    else await moveToTrash(host, store, caller, actualDoc, 'rejected/links', `${stamp()}-${edge.id}.md`).catch(() => undefined)
    throw error
  }
  await host.refreshView().catch(() => undefined)
  const audit = await recordAudit(host, caller, {
    action: 'edit', relPath: viewDoc, tool: 'kg_set', graphId: graph.path, topicId: edge.id,
    intent: 'update edge', diffSummary: 'updated ' + changed.join(', '), outcome: 'applied',
  })
  return { ok: true, action: 'set', kind: 'edge', format: 'graph-json', graph: graph.path, id: edge.id, doc: manifestDoc, after: { type, authority, internalizable }, audit }
}

/** `kg_del` for a `.graphs/<id>/graph.json` graph: move to `_trash`, never delete. */
async function deleteFromGraphJson(
  host: KnowledgeGraphToolHost,
  graph: KnowledgeGraphNode,
  store: GraphJsonStore,
  args: { id: string; kind?: string; cascade?: boolean; force?: boolean; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (args.force === true) {
    throw new KnowledgeToolError('invalid', 'a graph-json graph uses cascade:true, not force:true', args.id)
  }
  const state = await loadGraphJsonState(host, store)
  const target = resolveGraphJsonTarget(state, args.id.trim(), args.kind)

  if (target.node !== undefined) {
    const node = target.node
    const incident = state.edges.filter(edge => edge.from === node.id || edge.to === node.id)
    const nodeActual = joinRel(store.actualBase, node.path)
    const nodeView = nodeViewPath(store, node)
    const base = titleFromPath(node.path)
    const tag = stamp()
    const trashName = `${tag}-${node.id}-${base}`
    const summary = {
      action: 'del', kind: 'node', format: 'graph-json', graph: graph.path, id: node.id,
      path: nodeView,
      nodeTo: node.missing ? undefined : joinRel(store.viewStorePath, `_trash/nodes/${trashName}`),
      edges: incident.map(edge => ({
        id: edge.id, from: edge.from, to: edge.to, type: edge.type, doc: edge.docPath,
      })),
      needsCascade: incident.length > 0 && args.cascade !== true,
    }
    if (args.confirm !== true) {
      return {
        ok: true, draft: true, ...summary,
        next: incident.length > 0 && args.cascade !== true
          ? 'show the incident edges to the user; call again with confirm:true and cascade:true to remove them and move every document to _trash'
          : 'show these paths to the user; call again with confirm:true to move the node and its relation documents to _trash',
      }
    }
    if (incident.length > 0 && args.cascade !== true) {
      throw new KnowledgeToolError('invalid', 'this node still has edges; pass cascade:true to remove them as well', node.id)
    }
    const caller = await requireGraphJsonWrite(host, store, nodeActual)
    const nodes = state.manifest.nodes.filter(item => item.id !== node.id)
    const edges = state.manifest.edges.filter(item => item.from !== node.id && item.to !== node.id)
    const commit = await commitManifest(host, store, caller, nextManifestRecord(state, nodes, edges), state.manifestText)
    const moves: Array<{ from: string; to: string }> = []
    try {
      if (!node.missing) {
        moves.push(await moveToTrash(host, store, caller, nodeActual, 'nodes', trashName))
      }
      for (const edge of incident) {
        if (edge.docPath === undefined || edge.missing) continue
        moves.push(await moveToTrash(
          host, store, caller, joinRel(store.actualBase, edge.docPath), 'links', `${tag}-${edge.id}.md`,
        ))
      }
      requireValidGraph(await validateGraphStore(host, store), store)
    } catch (error) {
      await restoreTrashMoves(host, caller, moves)
      await rollbackManifest(host, store, caller, commit)
      throw error
    }
    await host.refreshView().catch(() => undefined)
    const audit = await recordAudit(host, caller, {
      action: 'delete', relPath: nodeView, toRelPath: joinRel(store.viewStorePath, '_trash/nodes'),
      tool: 'kg_del', graphId: graph.path, topicId: node.id, intent: 'move-to-trash',
      diffSummary: 'moved node to _trash' + (incident.length > 0 ? ' with ' + String(incident.length) + ' edge(s)' : ''),
      outcome: 'applied',
    })
    return { ok: true, ...summary, movedToTrash: true, audit }
  }

  const edge = target.edge!
  const docView = edge.docPath === undefined ? graph.path : joinRel(store.viewBase, edge.docPath)
  const tag = stamp()
  const trashName = `${tag}-${edge.id}.md`
  const summary = {
    action: 'del', kind: 'edge', format: 'graph-json', graph: graph.path, id: edge.id,
    from: edge.from, to: edge.to, doc: edge.docPath,
    docTo: edge.docPath === undefined || edge.missing
      ? undefined
      : joinRel(store.viewStorePath, `_trash/links/${trashName}`),
  }
  if (args.confirm !== true) {
    return {
      ok: true, draft: true, ...summary,
      next: 'show these paths to the user; call again with confirm:true to move the relation document to _trash',
    }
  }
  const caller = await requireGraphJsonWrite(
    host,
    store,
    edge.docPath === undefined ? undefined : joinRel(store.actualBase, edge.docPath),
  )
  const edges = state.manifest.edges.filter(item => item.id !== edge.id)
  const commit = await commitManifest(host, store, caller, nextManifestRecord(state, state.manifest.nodes, edges), state.manifestText)
  const moves: Array<{ from: string; to: string }> = []
  try {
    if (edge.docPath !== undefined && !edge.missing) {
      moves.push(await moveToTrash(host, store, caller, joinRel(store.actualBase, edge.docPath), 'links', trashName))
    }
    requireValidGraph(await validateGraphStore(host, store), store)
  } catch (error) {
    await restoreTrashMoves(host, caller, moves)
    await rollbackManifest(host, store, caller, commit)
    throw error
  }
  await host.refreshView().catch(() => undefined)
  const audit = await recordAudit(host, caller, {
    action: 'delete', relPath: docView, toRelPath: joinRel(store.viewStorePath, '_trash/links'),
    tool: 'kg_del', graphId: graph.path, topicId: edge.id, intent: 'move-to-trash',
    diffSummary: 'removed edge ' + edge.id + ' from graph.json', outcome: 'applied',
  })
  return { ok: true, ...summary, movedToTrash: true, audit }
}

/**
 * Build the four graph tools.
 *
 * @param host - the Host seam, shared with the knowledge file tools.
 * @returns Tool definitions for the disclosure coordinator.
 */
export const createKnowledgeGraphTools = (host: KnowledgeGraphToolHost) => [
  defineTool({
    name: 'kg_add',
    description: 'Add one graph item and WRITE the knowledge tree. Call without confirm:true first to receive the exact draft; '
      + 'show that draft to the user; call again with confirm:true only after they approve. '
      + 'Legacy folder graphs: kind=topic creates a visible folder + index.md card; kind=link creates a hidden .kg/links document. '
      + 'Graph-json graphs (format=graph-json, stored under .graphs/<id>/graph.json): kind=node creates the node document at "path" '
      + 'with an id/type/title/authority/internalizable/origin/reviewStatus/tags/sourceRefs front matter block and appends {id,path} '
      + 'to graph.json; kind=edge appends {id,from,to,type} and, when a body or edge attributes are given, writes .graphs/<id>/links/<id>.md. '
      + 'Duplicate ids and unknown edge endpoints are refused. "graph" is the graph path or name; "kind" is topic/link for a legacy graph, node/edge for a graph-json graph.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name, e.g. personal/知识图谱/工作轨迹 or personal/.graphs/procurement.' },
      kind: { type: 'string', required: true, description: 'topic | link (legacy graph) or node | edge (graph-json graph).' },
      id: { type: 'string', description: 'Item id: topic id, node id or edge id (lowercase letters/digits/hyphens).' },
      title: { type: 'string', description: 'Node title, edge document title, or legacy topic card title.' },
      path: { type: 'string', description: 'Node document path relative to the graph scope, e.g. 制度/采购制度.md (graph-json node kind).' },
      type: { type: 'string', description: 'Node type (policy|fact|procedure|case|skill|decision|topic; default fact) or edge relation type (graph-json only).' },
      authority: { type: 'string', description: 'canonical | advisory | redline; default advisory (graph-json only).' },
      internalizable: { type: 'boolean', description: 'Whether personal internalization is allowed; default true (graph-json only).' },
      origin: { type: 'string', description: 'human | ai | mixed; default human (graph-json only).' },
      reviewStatus: { type: 'string', description: 'draft | reviewed | approved; default draft (graph-json only).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Node or edge tags (graph-json only).' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Node or edge source references (graph-json only).' },
      from: { type: 'string', description: 'Source node id of the edge (kind=edge on a graph-json graph).' },
      to: { type: 'string', description: 'Target node id of the edge (kind=edge on a graph-json graph).' },
      domain: { type: 'string', description: 'Legacy topic card domain; default default.' },
      status: { type: 'string', description: 'Legacy topic card status: active | paused | done.' },
      depth: { type: 'number', description: 'Legacy topic card depth, 1..5.' },
      summary: { type: 'string', description: 'Legacy topic card summary.' },
      body: { type: 'string', description: 'Free Markdown body (node document body or relation-document body).' },
      a: { type: 'string', description: 'Legacy relation first topic id (link kind).' },
      b: { type: 'string', description: 'Legacy relation second topic id (link kind).' },
      label: { type: 'string', description: 'Legacy relation label.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph: string; kind: string; id?: string; title?: string; domain?: string; status?: string;
      depth?: number; summary?: string; body?: string; a?: string; b?: string; label?: string; confirm?: boolean;
      path?: string; type?: string; authority?: string; internalizable?: boolean; origin?: string;
      reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; from?: string; to?: string;
    }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      const store = graphJsonStore(graph)
      if (store !== undefined) return addToGraphJson(host, graph, store, args)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()

      if (args.kind === 'topic') {
        const id = (args.id ?? '').trim()
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id)) {
          throw new KnowledgeToolError('invalid', 'id must be 1-40 lowercase letters, digits or hyphens')
        }
        if (graph.topics.some(topic => topic.id === id)) {
          throw new KnowledgeToolError('exists', 'a topic with this id already exists', id)
        }
        const title = (args.title ?? '').trim()
        if (title === '') throw new KnowledgeToolError('invalid', 'title is required')
        const status = requireStatus(args.status) ?? 'active'
        const depth = requireDepth(args.depth) ?? 1
        const domain = (args.domain ?? 'default').trim() || 'default'
        const summary = args.summary ?? ''
        const body = args.body ?? ''
        const content = renderCard({ id, title, status, depth, domain, summary, body })
        if (args.confirm !== true) {
          return { ok: true, draft: true, action: 'add', kind: 'topic', graph: graph.path, id, content,
            next: 'show this draft to the user; call again with confirm:true to write it' }
        }
        const folder = title.replace(/[/\\]/gu, '-').trim() || id
        const actualFolder = actualGraph + '/' + folder
        if (await host.statEntry(actualFolder) !== undefined) {
          throw new KnowledgeToolError('exists', 'a folder already exists at ' + folder, folder)
        }
        await host.createEntry(actualFolder, { directory: true })
        await host.createEntry(actualFolder + '/index.md', { directory: false, content })
        await host.refreshView().catch(() => undefined)
        const audit = await recordAudit(host, caller, {
          action: 'create', relPath: graph.path + '/' + folder, tool: 'kg_add', graphId: graph.path,
          topicId: id, intent: 'new topic', diffSummary: 'created topic card ' + title,
          outcome: 'applied',
        })
        return { ok: true, action: 'add', kind: 'topic', graph: graph.path, path: graph.path + '/' + folder, audit }
      }

      if (args.kind === 'link') {
        const a = (args.a ?? '').trim()
        const b = (args.b ?? '').trim()
        if (a === '' || b === '' || a === b) throw new KnowledgeToolError('invalid', 'a and b must name two different topics')
        if (!graph.topics.some(topic => topic.id === a) || !graph.topics.some(topic => topic.id === b)) {
          throw new KnowledgeToolError('not-found', 'both endpoints must be existing topics in this graph')
        }
        const key = a < b ? a + '--' + b : b + '--' + a
        const content = renderLink({ a, b, ...(args.label === undefined ? {} : { label: args.label }), body: args.body ?? '' })
        if (args.confirm !== true) {
          return { ok: true, draft: true, action: 'add', kind: 'link', graph: graph.path, key, content,
            next: 'show this draft to the user; call again with confirm:true to write it' }
        }
        const linksDir = actualGraph + '/.kg/links'
        await host.createEntry(linksDir, { directory: true }).catch(() => undefined)
        await host.createEntry(linksDir + '/' + key + '.md', { directory: false, content })
        await host.refreshView().catch(() => undefined)
        const audit = await recordAudit(host, caller, {
          action: 'create', relPath: graph.path + '/.kg/links/' + key + '.md', tool: 'kg_add', graphId: graph.path,
          intent: 'new relation', diffSummary: 'linked ' + a + ' ↔ ' + b, outcome: 'applied',
        })
        return { ok: true, action: 'add', kind: 'link', graph: graph.path, path: '.kg/links/' + key + '.md', audit }
      }

      throw new KnowledgeToolError('invalid', 'kind must be topic or link')
    }),
  }),

  defineTool({
    name: 'kg_get',
    description: 'Read the knowledge graph. Without graph/id it returns the overview of every readable graph. '
      + 'With graph and no id it lists that graph\'s topics, nodes and relations. With graph+id it returns one item: a legacy topic card, '
      + 'or a graph-json node/edge with its id/title/type/authority/origin/reviewStatus/tags/sourceRefs, path and missing flag. '
      + 'Graph-json graphs are read from .graphs/<id>/graph.json plus the referenced node documents\' front matter. Read-only; never writes.',
    parameters: {
      graph: { type: 'string', description: 'Graph path or name. Omit for the overview.' },
      id: { type: 'string', description: 'Topic, node or edge id. Omit to list the graph.' },
    },
    output: jsonOutput,
    execute: async (args: { graph?: string; id?: string }) => run(async () => {
      const graphs = await host.listGraphs()
      if (args.graph === undefined || args.graph.trim() === '') {
        return {
          ok: true,
          overview: true,
          totals: {
            graphs: graphs.length,
            topics: graphs.reduce((sum, graph) => sum + graph.topics.length, 0),
            relations: graphs.reduce((sum, graph) => sum + graph.links.length, 0),
          },
          graphs: graphs.map(graph => ({
            id: graph.id,
            name: graph.name,
            scope: graph.scope,
            group: graph.group,
            path: graph.path,
            format: (graph as GraphNodeWithFormat).format ?? 'legacy',
            counts: graph.counts,
            topics: graph.topics.map(topic => topicSummary(graph, topic)),
          })),
        }
      }
      const graph = requireGraph(graphs, args.graph)
      const store = graphJsonStore(graph)
      if (store !== undefined) return getFromGraphJson(host, graph, store, args.id)
      if (args.id === undefined || args.id.trim() === '') {
        return {
          ok: true,
          graph: {
            id: graph.id, name: graph.name, scope: graph.scope, group: graph.group,
            path: graph.path, counts: graph.counts,
            topics: graph.topics.map(topic => topicSummary(graph, topic)),
            relations: graph.links.map(link => ({ a: link.a, b: link.b, label: link.label, updated: link.updated, body: link.body })),
          },
        }
      }
      const topic = requireTopic(graph, args.id)
      const relations = graph.links.filter(link => link.a === topic.id || link.b === topic.id)
      return {
        ok: true,
        graph: { id: graph.id, name: graph.name, path: graph.path },
        topic: {
          id: topic.id, title: topic.title, status: topic.status, depth: topic.depth,
          domain: topic.domain, tags: topic.tags, summary: topic.summary, body: topic.body,
          path: topicViewPath(graph, topic),
          documents: topic.documents.map(document => ({ title: document.title, file: document.file, path: document.path, date: document.date, summary: document.summary })),
          relations: relations.map(link => ({
            other: link.a === topic.id ? link.b : link.a,
            label: link.label, updated: link.updated, body: link.body,
          })),
        },
      }
    }),
  }),

  defineTool({
    name: 'kg_set',
    description: 'Change one graph item. Call without confirm:true first to receive a before/after draft; show it to the user; call again with confirm:true only after approval. '
      + 'Legacy topic cards: status, depth, title, domain, summary and/or body. '
      + 'Graph-json graphs: kind=node updates the node front matter (title/type/authority/internalizable/origin/reviewStatus/tags/sourceRefs) without touching its body; '
      + 'kind=edge updates type/authority/internalizable and the optional relation-document body. Only the named fields change.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic, node or edge id to edit.' },
      kind: { type: 'string', description: 'node or edge (graph-json graphs); omit when the id is unambiguous.' },
      title: { type: 'string' }, domain: { type: 'string' }, status: { type: 'string' }, depth: { type: 'number' },
      summary: { type: 'string' }, body: { type: 'string' },
      type: { type: 'string', description: 'New node type or edge relation type (graph-json only).' },
      authority: { type: 'string', description: 'canonical | advisory | redline (graph-json only).' },
      internalizable: { type: 'boolean', description: 'Whether personal internalization is allowed (graph-json only).' },
      origin: { type: 'string', description: 'human | ai | mixed (graph-json node only).' },
      reviewStatus: { type: 'string', description: 'draft | reviewed | approved (graph-json node only).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Node tags (graph-json node only).' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Node source references (graph-json node only).' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph: string; id: string; kind?: string; title?: string; domain?: string; status?: string; depth?: number;
      summary?: string; body?: string; type?: string; authority?: string; internalizable?: boolean;
      origin?: string; reviewStatus?: string; tags?: string[]; sourceRefs?: string[]; confirm?: boolean;
    }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      const store = graphJsonStore(graph)
      if (store !== undefined) return setOnGraphJson(host, graph, store, args)
      const topic = requireTopic(graph, args.id)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()
      const viewPath = topicViewPath(graph, topic)
      const text = await host.readText(viewPath + '/index.md')
      const parsed = parseGraphFrontMatter(text)
      const before = {
        title: parsed.meta.title ?? topic.title,
        status: parsed.meta.status ?? topic.status,
        depth: parsed.meta.depth ?? String(topic.depth),
        domain: parsed.meta.domain ?? topic.domain ?? 'default',
        summary: firstSummary(parsed.body),
        body: bodyAfterSummary(parsed.body),
      }
      const status = requireStatus(args.status) ?? before.status
      const depth = requireDepth(args.depth) ?? Number(before.depth)
      const title = (args.title ?? before.title).trim()
      const domain = (args.domain ?? before.domain).trim() || 'default'
      const summary = args.summary ?? before.summary
      const body = args.body ?? before.body
      const content = renderCard({ id: topic.id, title, status, depth, domain, summary, body, updated: today() })
      const after = { title, status, depth, domain, summary, body }
      if (args.confirm !== true) {
        return { ok: true, draft: true, action: 'set', graph: graph.path, id: topic.id, before, after, content,
          next: 'show this draft to the user; call again with confirm:true to write it' }
      }
      await host.overwriteFile(topicActualPath(graph, topic) + '/index.md', content)
      await host.refreshView().catch(() => undefined)
      const audit = await recordAudit(host, caller, {
        action: 'edit', relPath: viewPath, tool: 'kg_set', graphId: graph.path, topicId: topic.id,
        intent: 'update card', diffSummary: 'updated ' + Object.keys(after).filter(key => before[key as keyof typeof before] !== after[key as keyof typeof after]).join(', '),
        outcome: 'applied',
      })
      return { ok: true, action: 'set', graph: graph.path, id: topic.id, after, audit }
    }),
  }),

  defineTool({
    name: 'kg_del',
    description: 'Move one graph item to _trash (never delete). Call without confirm:true first to receive the affected paths; show them to the user; call again with confirm:true only after approval. '
      + 'Legacy graphs: moves the topic folder; relation documents touching it block the move unless force:true. '
      + 'Graph-json graphs: removes the node/edge from graph.json and moves the node body (or relation document) under .graphs/<id>/_trash/; a node with edges needs cascade:true. '
      + 'The audit trail records the actor, time, graph, item and both paths.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic, node or edge id to move to _trash.' },
      kind: { type: 'string', description: 'node or edge (graph-json graphs); omit when the id is unambiguous.' },
      cascade: { type: 'boolean', description: 'Graph-json node kind: also remove its edges and move their documents to _trash.' },
      force: { type: 'boolean', description: 'Legacy graphs: also move relation documents that reference the topic.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: { graph: string; id: string; kind?: string; cascade?: boolean; force?: boolean; confirm?: boolean }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      const store = graphJsonStore(graph)
      if (store !== undefined) return deleteFromGraphJson(host, graph, store, args)
      const topic = requireTopic(graph, args.id)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()
      const relations: KnowledgeGraphLink[] = graph.links.filter(link => link.a === topic.id || link.b === topic.id)
      const stampValue = new Date().toISOString().replace(/[:.]/gu, '-')
      const topicFrom = topicActualPath(graph, topic)
      const topicTo = actualGraph + '/_trash/topics/' + stampValue + '-' + topic.folder
      const relationMoves = relations
        .filter(link => link.file !== undefined)
        .map(link => ({ from: actualGraph + '/.kg/links/' + link.file!, to: actualGraph + '/_trash/links/' + stampValue + '-' + link.file! }))
      const viewTopicTo = graph.path + '/_trash/topics/' + stampValue + '-' + topic.folder
      const summary = { action: 'del', graph: graph.path, id: topic.id, topicFrom: topicViewPath(graph, topic), topicTo: viewTopicTo, relations: relations.map(link => ({ a: link.a, b: link.b, file: link.file })) }
      if (args.confirm !== true) {
        return { ok: true, draft: true, ...summary, needsForce: relations.length > 0 && args.force !== true,
          next: relations.length > 0 && args.force !== true
            ? 'show the affected relations to the user; call again with confirm:true and force:true to move everything to _trash'
            : 'show these paths to the user; call again with confirm:true to move them to _trash' }
      }
      if (relations.length > 0 && args.force !== true) {
        throw new KnowledgeToolError('invalid', 'this topic still has relations; pass force:true to move them to _trash as well')
      }
      await host.createEntry(actualGraph + '/_trash/topics', { directory: true }).catch(() => undefined)
      await host.moveEntry(topicFrom, topicTo, caller)
      if (relationMoves.length > 0) {
        await host.createEntry(actualGraph + '/_trash/links', { directory: true }).catch(() => undefined)
        for (const move of relationMoves) await host.moveEntry(move.from, move.to, caller)
      }
      await host.refreshView().catch(() => undefined)
      const audit = await recordAudit(host, caller, {
        action: 'delete', relPath: topicViewPath(graph, topic), toRelPath: viewTopicTo,
        tool: 'kg_del', graphId: graph.path, topicId: topic.id, intent: 'move-to-trash',
        diffSummary: 'moved topic to _trash' + (relationMoves.length > 0 ? ' with ' + relationMoves.length + ' relation(s)' : ''),
        outcome: 'applied',
      })
      return { ok: true, ...summary, movedToTrash: true, audit }
    }),
  }),
]