import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledgeGraphTools, type KnowledgeGraphToolHost } from '../src/graphTools.ts'
import { loadGraph, type GraphManifest } from '../src/graphModel.ts'
import type { KnowledgeAuditEntry } from '../src/views.ts'
import type { KnowledgeGraphNode, KnowledgeGraphScopeKey } from '../src/graphTypes.ts'

const roots: string[] = []
const fakeExec = {} as never

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-graph-tools-json-'))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A node document with the documented front-matter shape. */
function nodeDocument(fields: Record<string, string>, body = '正文'): string {
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', body].join('\n')
}

function edgeDocument(fields: Record<string, string>, body = '关系说明'): string {
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', body].join('\n')
}

function graphJsonNode(overrides: Partial<KnowledgeGraphNode> = {}): KnowledgeGraphNode & { format: string } {
  return {
    id: 'personal/.graphs/proc',
    name: '采购制度图谱',
    scope: 'personal',
    path: 'personal/.graphs/proc',
    group: '',
    topics: [],
    links: [],
    counts: { topics: 0, links: 0, documents: 0 },
    actualPath: 'personal/u1/.graphs/proc',
    format: 'graph-json',
    ...overrides,
  }
}

function legacyGraphNode(): KnowledgeGraphNode {
  return {
    id: 'personal/知识图谱/legacy',
    name: 'legacy',
    scope: 'personal',
    path: 'personal/知识图谱/legacy',
    group: '',
    topics: [{
      id: 'topic-a',
      title: '主题 A',
      status: 'active',
      depth: 1,
      tags: [],
      summary: '摘要 A',
      body: '',
      folder: '主题A',
      path: 'personal/知识图谱/legacy/主题A',
      documents: [],
    }],
    links: [],
    counts: { topics: 1, links: 0, documents: 0 },
    actualPath: 'personal/u1/知识图谱/legacy',
  }
}

interface FakeHostOptions {
  canWrite?: (relPath: string) => boolean
  /** Rewrite one write before it lands; lets a test force a post-write validator error. */
  tamper?: (relPath: string, content: string) => string
}

/**
 * A Host stand-in that keeps the two coordinate systems apart exactly as the real
 * Host does: `readText` speaks view paths (`personal/...`), every write speaks
 * authoritative paths (`personal/<uid>/...`).
 */
function makeHost(root: string, graphs: KnowledgeGraphNode[], options: FakeHostOptions = {}) {
  const audits: KnowledgeAuditEntry[] = []
  const toActual = (relPath: string): string => {
    const clean = relPath.replace(/^\/+/u, '')
    if (clean === 'personal' || clean.startsWith('personal/')) {
      const rest = clean.slice('personal'.length).replace(/^\//u, '')
      if (rest === 'u1' || rest.startsWith('u1/')) return join(root, clean)
      return join(root, 'personal', 'u1', rest)
    }
    return join(root, clean)
  }
  const host: KnowledgeGraphToolHost = {
    listGraphs: async () => graphs,
    readText: async viewPath => readFile(toActual(viewPath), 'utf8'),
    resolveCaller: async () => ({ userId: 'u1', label: '测试用户' }),
    canWrite: async relPath => options.canWrite?.(relPath) ?? true,
    statEntry: async (relPath) => {
      try {
        const info = await stat(toActual(relPath))
        return info.isDirectory() ? { kind: 'directory' } : { kind: 'file', size: info.size }
      } catch {
        return undefined
      }
    },
    createEntry: async (relPath, createOptions) => {
      const full = toActual(relPath)
      if (createOptions.directory) {
        await mkdir(full, { recursive: true })
        return { relPath, kind: 'directory' }
      }
      await mkdir(dirname(full), { recursive: true })
      const content = options.tamper?.(relPath, createOptions.content ?? '') ?? createOptions.content ?? ''
      await writeFile(full, content, { encoding: 'utf8', flag: 'wx' })
      return { relPath, kind: 'file' }
    },
    overwriteFile: async (relPath, content) => {
      const next = options.tamper?.(relPath, content) ?? content
      await writeFile(toActual(relPath), next, 'utf8')
    },
    moveEntry: async (from, to) => {
      const source = toActual(from)
      const destination = toActual(to)
      if (source === destination) throw new Error('source and destination are the same path')
      let taken = true
      try {
        await stat(destination)
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') taken = false
        else throw error
      }
      if (taken) throw new Error('destination already exists: ' + to)
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)
      return { from, to }
    },
    refreshView: async () => ({}),
    viewDir: userId => join(root, 'state', userId),
    appendAudit: async (_viewDir, entry) => {
      audits.push(entry)
    },
  }
  return { host, audits }
}

const toolFor = (host: KnowledgeGraphToolHost, name: string) => {
  const definition = createKnowledgeGraphTools(host).find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

const execute = async (host: KnowledgeGraphToolHost, name: string, args: Record<string, unknown>) => (
  toolFor(host, name).execute(args, fakeExec) as Promise<Record<string, any>>
)

function manifest(overrides: Partial<GraphManifest> = {}): GraphManifest {
  return {
    schemaVersion: 1,
    id: 'proc',
    name: '采购制度图谱',
    scope: 'personal:u1',
    version: 2,
    status: 'draft',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    tags: [],
    visibility: 'private',
    nodes: [
      { id: 'node-policy', path: '制度/采购制度.md' },
      { id: 'node-flow', path: '流程/审批流程.md' },
    ],
    edges: [
      { id: 'edge-1', from: 'node-policy', to: 'node-flow', type: 'depends_on', doc: '.graphs/proc/links/edge-1.md' },
    ],
    ...overrides,
  }
}

interface GraphFixture {
  nodes?: Record<string, string>
  links?: Record<string, string>
}

/** Write `<tmp>/personal/u1/.graphs/proc/graph.json` plus its node and relation documents. */
async function writeGraph(root: string, value: GraphManifest, fixture: GraphFixture = {}): Promise<string> {
  const scope = join(root, 'personal', 'u1')
  await write(join(scope, '.graphs', value.id, 'graph.json'), JSON.stringify(value, null, 2) + '\n')
  for (const [relPath, content] of Object.entries(fixture.nodes ?? {})) await write(join(scope, relPath), content)
  for (const [name, content] of Object.entries(fixture.links ?? {})) {
    await write(join(scope, '.graphs', value.id, 'links', name), content)
  }
  return scope
}

function standardFixture(): GraphFixture {
  return {
    nodes: {
      '制度/采购制度.md': nodeDocument({
        id: 'node-policy',
        type: 'policy',
        title: '采购制度',
        authority: 'canonical',
        internalizable: 'true',
        origin: 'human',
        reviewStatus: 'approved',
        tags: '[采购, 制度]',
        sourceRefs: '[]',
      }, '正文甲\n\n第二段'),
      '流程/审批流程.md': nodeDocument({
        id: 'node-flow',
        type: 'procedure',
        title: '审批流程',
        authority: 'advisory',
        internalizable: 'true',
        origin: 'human',
        reviewStatus: 'draft',
        tags: '[]',
        sourceRefs: '[]',
      }, '正文乙'),
    },
    links: {
      'edge-1.md': edgeDocument({
        id: 'edge-1',
        from: 'node-policy',
        to: 'node-flow',
        type: 'depends_on',
        authority: 'advisory',
        internalizable: 'true',
        origin: 'human',
        reviewStatus: 'approved',
      }),
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('graph-json kg_add', () => {
  it('returns the exact node draft without writing until confirmed', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const draft = await execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc',
      kind: 'node',
      id: 'node-extra',
      path: '制度/补充制度.md',
      title: '补充制度',
      type: 'policy',
      authority: 'canonical',
      tags: ['采购'],
    })
    expect(draft).toMatchObject({
      ok: true,
      draft: true,
      kind: 'node',
      id: 'node-extra',
      path: 'personal/制度/补充制度.md',
      manifestPath: '制度/补充制度.md',
    })
    expect(draft.content).toContain('id: node-extra')
    expect(draft.content).toContain('authority: canonical')
    expect(draft.content).toContain('tags: [采购]')
    expect(await exists(join(root, 'personal', 'u1', '制度', '补充制度.md'))).toBe(false)
    const current = JSON.parse(await readFile(join(root, 'personal', 'u1', '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(current.nodes).toHaveLength(2)
  })

  it('writes the node document and appends it to graph.json', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host, audits } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc',
      kind: 'node',
      id: 'node-extra',
      path: '制度/补充制度.md',
      title: '补充制度',
      type: 'procedure',
      origin: 'ai',
      reviewStatus: 'draft',
      body: '正文丙',
      confirm: true,
    })
    expect(result).toMatchObject({ ok: true, action: 'add', kind: 'node', id: 'node-extra', audit: { written: true } })
    const document = await readFile(join(scope, '制度', '补充制度.md'), 'utf8')
    expect(document).toContain('title: 补充制度')
    expect(document).toContain('origin: ai')
    expect(document).toContain('正文丙')
    const written = JSON.parse(await readFile(join(scope, '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(written.nodes).toContainEqual({ id: 'node-extra', path: '制度/补充制度.md' })
    expect(written.version).toBe(3)
    expect(written.updatedAt).not.toBe('2026-11-01T00:00:00.000Z')

    const loaded = await loadGraph(scope, 'proc')
    expect(loaded.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(loaded.nodes.find(node => node.id === 'node-extra')?.title).toBe('补充制度')
    expect(audits[0]).toMatchObject({ action: 'create', tool: 'kg_add', topicId: 'node-extra' })
  })

  it('writes a relation document and appends the edge', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc',
      kind: 'edge',
      id: 'edge-2',
      from: 'node-flow',
      to: 'node-policy',
      type: 'depends_on',
      authority: 'advisory',
      tags: ['依赖'],
      body: '流程依赖制度',
      confirm: true,
    })
    expect(result).toMatchObject({ ok: true, kind: 'edge', id: 'edge-2', doc: '.graphs/proc/links/edge-2.md' })
    const relation = await readFile(join(scope, '.graphs', 'proc', 'links', 'edge-2.md'), 'utf8')
    expect(relation).toContain('from: node-flow')
    expect(relation).toContain('to: node-policy')
    expect(relation).toContain('type: depends_on')
    expect(relation).toContain('tags: [依赖]')
    expect(relation).toContain('流程依赖制度')
    const written = JSON.parse(await readFile(join(scope, '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(written.edges).toContainEqual({
      id: 'edge-2', from: 'node-flow', to: 'node-policy', type: 'depends_on', doc: '.graphs/proc/links/edge-2.md',
    })
    const loaded = await loadGraph(scope, 'proc')
    expect(loaded.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(loaded.edges.find(item => item.id === 'edge-2')?.missing).toBe(false)
  })

  it('refuses a duplicate id, an unknown endpoint and a path escape', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'node', id: 'node-policy', path: '制度/其它.md', title: '重复', confirm: true,
    })).rejects.toMatchObject({ code: 'exists' })
    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'edge', id: 'edge-9', from: 'node-policy', to: 'node-ghost', type: 'related_to', confirm: true,
    })).rejects.toMatchObject({ code: 'not-found' })
    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'node', id: 'node-evil', path: '../evil.md', title: '逃逸',
    })).rejects.toMatchObject({ code: 'invalid' })
    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'node', id: 'node-evil', path: '.graphs/proc/evil.md', title: '逃逸',
    })).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('graph-json kg_get', () => {
  it('lists nodes and edges with frontmatter attributes and missing flags', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest({
      nodes: [
        { id: 'node-policy', path: '制度/采购制度.md' },
        { id: 'node-missing', path: '制度/缺失.md' },
      ],
      edges: [],
    }), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_get', { graph: 'personal/.graphs/proc' })
    expect(result.graph).toMatchObject({ format: 'graph-json', id: 'personal/.graphs/proc' })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({
      id: 'node-policy',
      title: '采购制度',
      type: 'policy',
      authority: 'canonical',
      origin: 'human',
      reviewStatus: 'approved',
      tags: ['采购', '制度'],
      path: 'personal/制度/采购制度.md',
      missing: false,
    })
    expect(result.nodes[1]).toMatchObject({ id: 'node-missing', missing: true })
    expect(result.issues.some((issue: any) => issue.code === 'missing-node')).toBe(true)
  })

  it('returns one node with its body and touching edges', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_get', { graph: 'personal/.graphs/proc', id: 'node-policy' })
    expect(result.node).toMatchObject({
      id: 'node-policy',
      title: '采购制度',
      authority: 'canonical',
      reviewStatus: 'approved',
    })
    expect(result.node.body).toContain('正文甲')
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({
      id: 'edge-1',
      from: 'node-policy',
      to: 'node-flow',
      type: 'depends_on',
      authority: 'advisory',
      reviewStatus: 'approved',
      missing: false,
    })
  })

  it('marks the graph-json format in the overview', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode(), legacyGraphNode()])

    const result = await execute(host, 'kg_get', {})
    const formats = Object.fromEntries(result.graphs.map((graph: any) => [graph.id, graph.format]))
    expect(formats['personal/.graphs/proc']).toBe('graph-json')
    expect(formats['personal/知识图谱/legacy']).toBe('legacy')
  })
})

describe('graph-json kg_set', () => {
  it('updates node frontmatter without touching the body', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host, audits } = makeHost(root, [graphJsonNode()])
    const docPath = join(scope, '制度', '采购制度.md')
    const before = await readFile(docPath, 'utf8')

    const draft = await execute(host, 'kg_set', {
      graph: 'personal/.graphs/proc',
      id: 'node-policy',
      kind: 'node',
      title: '采购制度（修订）',
      authority: 'redline',
      internalizable: false,
      tags: ['采购'],
    })
    expect(draft).toMatchObject({ ok: true, draft: true, kind: 'node' })
    expect(draft.after).toMatchObject({ title: '采购制度（修订）', authority: 'redline', internalizable: false, tags: ['采购'] })
    expect(await readFile(docPath, 'utf8')).toBe(before)

    await execute(host, 'kg_set', {
      graph: 'personal/.graphs/proc',
      id: 'node-policy',
      kind: 'node',
      title: '采购制度（修订）',
      authority: 'redline',
      internalizable: false,
      tags: ['采购'],
      confirm: true,
    })
    const after = await readFile(docPath, 'utf8')
    expect(after).toContain('title: 采购制度（修订）')
    expect(after).toContain('authority: redline')
    expect(after).toContain('internalizable: false')
    expect(after).toContain('tags: [采购]')
    // The body is byte-for-byte what it was: the edit only rewrote front matter.
    expect(after.slice(after.indexOf('\n---\n') + 5)).toBe(before.slice(before.indexOf('\n---\n') + 5))
    const loaded = await loadGraph(scope, 'proc')
    expect(loaded.nodes.find(node => node.id === 'node-policy')?.authority).toBe('redline')
    expect(loaded.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(audits[0]).toMatchObject({ action: 'edit', tool: 'kg_set', topicId: 'node-policy' })
  })

  it('rejects legacy card fields on a graph-json node', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])
    await expect(execute(host, 'kg_set', {
      graph: 'personal/.graphs/proc', id: 'node-policy', body: '替换正文',
    })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('updates an edge type and its relation document', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_set', {
      graph: 'personal/.graphs/proc',
      id: 'edge-1',
      kind: 'edge',
      type: 'supports',
      internalizable: false,
      confirm: true,
    })
    expect(result).toMatchObject({ ok: true, kind: 'edge', after: { type: 'supports', internalizable: false } })
    const written = JSON.parse(await readFile(join(scope, '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(written.edges[0]).toMatchObject({ id: 'edge-1', type: 'supports' })
    const relation = await readFile(join(scope, '.graphs', 'proc', 'links', 'edge-1.md'), 'utf8')
    expect(relation).toContain('type: supports')
    expect(relation).toContain('internalizable: false')
    expect(relation).toContain('关系说明')
  })
})

describe('graph-json kg_del', () => {
  it('refuses a node with edges unless cascade is set', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const draft = await execute(host, 'kg_del', { graph: 'personal/.graphs/proc', id: 'node-policy' })
    expect(draft).toMatchObject({ ok: true, draft: true, kind: 'node', needsCascade: true })
    await expect(execute(host, 'kg_del', {
      graph: 'personal/.graphs/proc', id: 'node-policy', confirm: true,
    })).rejects.toMatchObject({ code: 'invalid' })
    expect(await exists(join(scope, '制度', '采购制度.md'))).toBe(true)
  })

  it('moves the node body and incident relation documents to _trash', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_del', {
      graph: 'personal/.graphs/proc', id: 'node-policy', cascade: true, confirm: true,
    })
    expect(result).toMatchObject({ ok: true, kind: 'node', movedToTrash: true })
    expect(await exists(join(scope, '制度', '采购制度.md'))).toBe(false)
    expect(await exists(join(scope, '.graphs', 'proc', 'links', 'edge-1.md'))).toBe(false)
    const trashedNodes = await stat(join(scope, '.graphs', 'proc', '_trash', 'nodes'))
    expect(trashedNodes.isDirectory()).toBe(true)
    const written = JSON.parse(await readFile(join(scope, '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(written.nodes.map((node: any) => node.id)).toEqual(['node-flow'])
    expect(written.edges).toEqual([])
    const loaded = await loadGraph(scope, 'proc')
    expect(loaded.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(loaded.nodes.map(node => node.id)).toEqual(['node-flow'])
  })

  it('removes one edge and trashes its document', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()])

    const result = await execute(host, 'kg_del', {
      graph: 'personal/.graphs/proc', id: 'edge-1', kind: 'edge', confirm: true,
    })
    expect(result).toMatchObject({ ok: true, kind: 'edge', movedToTrash: true })
    expect(await exists(join(scope, '.graphs', 'proc', 'links', 'edge-1.md'))).toBe(false)
    const written = JSON.parse(await readFile(join(scope, '.graphs', 'proc', 'graph.json'), 'utf8'))
    expect(written.edges).toEqual([])
    expect(written.nodes).toHaveLength(2)
  })
})

describe('graph-json validator rollback', () => {
  it('rolls the node document and graph.json back when the post-write validator reports an error', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    let tampered = false
    const { host } = makeHost(root, [graphJsonNode()], {
      tamper: (relPath, content) => {
        if (!tampered && relPath.endsWith('制度/采购制度.md')) {
          tampered = true
          return content.replace('authority: redline', 'authority: bogus')
        }
        return content
      },
    })
    const docPath = join(scope, '制度', '采购制度.md')
    const before = await readFile(docPath, 'utf8')
    const manifestPath = join(scope, '.graphs', 'proc', 'graph.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')

    await expect(execute(host, 'kg_set', {
      graph: 'personal/.graphs/proc', id: 'node-policy', kind: 'node', authority: 'redline', confirm: true,
    })).rejects.toMatchObject({ code: 'invalid' })
    expect(tampered).toBe(true)
    expect(await readFile(docPath, 'utf8')).toBe(before)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    const loaded = await loadGraph(scope, 'proc')
    expect(loaded.issues.filter(issue => issue.severity === 'error')).toEqual([])
  })

  it('rolls graph.json and the created document back when an added node fails validation', async () => {
    const root = await tempRoot()
    const scope = await writeGraph(root, manifest(), standardFixture())
    let tampered = false
    const { host } = makeHost(root, [graphJsonNode()], {
      tamper: (relPath, content) => {
        if (!tampered && relPath.endsWith('制度/补充制度.md')) {
          tampered = true
          return content.replace('type: fact', 'type: not-a-type')
        }
        return content
      },
    })
    const manifestPath = join(scope, '.graphs', 'proc', 'graph.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')

    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'node', id: 'node-extra', path: '制度/补充制度.md', title: '补充制度', confirm: true,
    })).rejects.toMatchObject({ code: 'invalid' })
    expect(tampered).toBe(true)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    expect(await exists(join(scope, '制度', '补充制度.md'))).toBe(false)
    expect(await exists(join(scope, '.graphs', 'proc', '_trash', 'rejected', 'nodes'))).toBe(true)
  })
})

describe('legacy folder graphs keep the existing behaviour', () => {
  it('reads a legacy topic and creates a new topic folder', async () => {
    const root = await tempRoot()
    await write(join(root, 'personal', 'u1', '知识图谱', 'legacy', '主题A', 'index.md'), [
      '---', 'id: topic-a', 'title: 主题 A', 'status: active', 'depth: 1', 'domain: default', 'updated: 2026-11-01',
      '---', '', '# 主题 A', '', '摘要 A', '',
    ].join('\n'))
    const { host } = makeHost(root, [legacyGraphNode()])

    const read = await execute(host, 'kg_get', { graph: 'personal/知识图谱/legacy' })
    expect(read.graph.topics[0]).toMatchObject({ id: 'topic-a', title: '主题 A' })

    const draft = await execute(host, 'kg_add', {
      graph: 'personal/知识图谱/legacy', kind: 'topic', id: 'topic-b', title: '主题 B', summary: '摘要 B',
    })
    expect(draft).toMatchObject({ ok: true, draft: true, kind: 'topic', id: 'topic-b' })
    expect(draft.content).toContain('id: topic-b')

    const result = await execute(host, 'kg_add', {
      graph: 'personal/知识图谱/legacy', kind: 'topic', id: 'topic-b', title: '主题 B', summary: '摘要 B', confirm: true,
    })
    expect(result).toMatchObject({ ok: true, kind: 'topic', path: 'personal/知识图谱/legacy/主题 B' })
    const created = await readFile(join(root, 'personal', 'u1', '知识图谱', 'legacy', '主题 B', 'index.md'), 'utf8')
    expect(created).toContain('title: 主题 B')
    expect(created).toContain('摘要 B')
  })

  it('still refuses an unknown legacy kind', async () => {
    const root = await tempRoot()
    await write(join(root, 'personal', 'u1', '知识图谱', 'legacy', '主题A', 'index.md'), nodeDocument({ id: 'topic-a', title: '主题 A' }))
    const { host } = makeHost(root, [legacyGraphNode()])
    await expect(execute(host, 'kg_get', { graph: 'personal/知识图谱/legacy', id: 'topic-ghost' }))
      .rejects.toMatchObject({ code: 'not-found' })
    await expect(execute(host, 'kg_add', { graph: 'personal/知识图谱/legacy', kind: 'node', id: 'x', title: 'X' }))
      .rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('graph-json write permission', () => {
  it('refuses to write when the graph store is not writable', async () => {
    const root = await tempRoot()
    await writeGraph(root, manifest(), standardFixture())
    const { host } = makeHost(root, [graphJsonNode()], {
      canWrite: relPath => !relPath.includes('.graphs/proc'),
    })
    await expect(execute(host, 'kg_add', {
      graph: 'personal/.graphs/proc', kind: 'node', id: 'node-x', path: '制度/x.md', title: 'X', confirm: true,
    })).rejects.toMatchObject({ code: 'forbidden' })
  })
})