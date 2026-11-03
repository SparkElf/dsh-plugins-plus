/**
 * Model-facing knowledge-graph tools (`kg_add` / `kg_get` / `kg_set` / `kg_del`).
 *
 * The four verbs mirror `kg.py`'s CLI. They operate on the P1 storage shape
 * (`知识图谱/<graph>/<topic>/index.md`, relations under `.kg/links/`) through the
 * same Host seam the HTTP routes use: one grant per graph, `canWritePath` before
 * every write, `readAuthorized` for every read, audit entries recorded beside the
 * caller's view, and `_trash` instead of deletion.
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

/**
 * Build the four graph tools.
 *
 * @param host - the Host seam, shared with the knowledge file tools.
 * @returns Tool definitions for the disclosure coordinator.
 */
export const createKnowledgeGraphTools = (host: KnowledgeGraphToolHost) => [
  defineTool({
    name: 'kg_add',
    description: 'Add one graph topic (a visible folder + index.md card) or one relation (a hidden .kg/links document). '
      + 'This WRITES the knowledge tree. Call without confirm:true first to receive the exact draft; show that draft to the user; '
      + 'call again with confirm:true only after they approve. "graph" is the graph path or name; "kind" is topic or link. '
      + 'For kind=topic pass id/title and optional domain/status/depth/summary/body. For kind=link pass a/b and optional label/body.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name, e.g. personal/知识图谱/工作轨迹.' },
      kind: { type: 'string', required: true, description: 'topic or link.' },
      id: { type: 'string', description: 'Topic id (topic kind), lowercase letters/digits/hyphens.' },
      title: { type: 'string', description: 'Card title (topic kind).' },
      domain: { type: 'string', description: 'Card domain; default default.' },
      status: { type: 'string', description: 'active | paused | done; default active.' },
      depth: { type: 'number', description: '1..5; default 1.' },
      summary: { type: 'string', description: 'First paragraph after the H1.' },
      body: { type: 'string', description: 'Free Markdown body after the summary.' },
      a: { type: 'string', description: 'First topic id of the relation (link kind).' },
      b: { type: 'string', description: 'Second topic id of the relation (link kind).' },
      label: { type: 'string', description: 'Short relation label.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph: string; kind: string; id?: string; title?: string; domain?: string; status?: string;
      depth?: number; summary?: string; body?: string; a?: string; b?: string; label?: string; confirm?: boolean;
    }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
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
      + 'With graph and no id it lists that graph\'s topics and relations. With graph+id it returns one card, its documents and all relation documents touching it. '
      + 'Read-only; never writes.',
    parameters: {
      graph: { type: 'string', description: 'Graph path or name. Omit for the overview.' },
      id: { type: 'string', description: 'Topic id. Omit to list the graph.' },
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
            counts: graph.counts,
            topics: graph.topics.map(topic => topicSummary(graph, topic)),
          })),
        }
      }
      const graph = requireGraph(graphs, args.graph)
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
    description: 'Change one graph topic card: status, depth, title, domain, summary and/or body. '
      + 'Call without confirm:true first to receive a before/after draft; show it to the user; call again with confirm:true only after approval. '
      + 'Only the named fields change; documents are untouched.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic id to edit.' },
      title: { type: 'string' }, domain: { type: 'string' }, status: { type: 'string' }, depth: { type: 'number' },
      summary: { type: 'string' }, body: { type: 'string' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: {
      graph: string; id: string; title?: string; domain?: string; status?: string; depth?: number;
      summary?: string; body?: string; confirm?: boolean;
    }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
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
    description: 'Move one graph topic folder to <graph>/_trash/ (never delete). Relations touching it block the move unless force:true, which moves those relation documents to _trash/links/ as well. '
      + 'Call without confirm:true first to receive the affected paths; show them to the user; call again with confirm:true only after approval. '
      + 'The audit trail records the actor, time, graph, topic and both paths.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph path or name.' },
      id: { type: 'string', required: true, description: 'Topic id to move to _trash.' },
      force: { type: 'boolean', description: 'Also move relation documents that reference the topic.' },
      confirm: { type: 'boolean', description: 'Write only when true; omitted/false returns the draft.' },
    },
    output: jsonOutput,
    execute: async (args: { graph: string; id: string; force?: boolean; confirm?: boolean }) => run(async () => {
      const graphs = await host.listGraphs()
      const graph = requireGraph(graphs, args.graph)
      const topic = requireTopic(graph, args.id)
      const actualGraph = actualGraphPath(graph)
      if (!await host.canWrite(actualGraph)) {
        throw new KnowledgeToolError('forbidden', 'write access is required for this graph', graph.path)
      }
      const caller = await host.resolveCaller()
      const relations: KnowledgeGraphLink[] = graph.links.filter(link => link.a === topic.id || link.b === topic.id)
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const topicFrom = topicActualPath(graph, topic)
      const topicTo = actualGraph + '/_trash/topics/' + stamp + '-' + topic.folder
      const relationMoves = relations
        .filter(link => link.file !== undefined)
        .map(link => ({ from: actualGraph + '/.kg/links/' + link.file!, to: actualGraph + '/_trash/links/' + stamp + '-' + link.file! }))
      const viewTopicTo = graph.path + '/_trash/topics/' + stamp + '-' + topic.folder
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
