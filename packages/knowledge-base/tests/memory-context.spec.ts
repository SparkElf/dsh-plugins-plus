import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GraphManifest, LoadedGraph, LoadedGraphEdge, LoadedGraphNode } from '../src/graphModel.ts'
import type { GraphViewer } from '../src/graphPolicy.ts'
import type { PersonalBinding } from '../src/memoryBindings.ts'
import {
  SYSTEM_POLICY_MARKER,
  resolveMemoryContext,
  type MemoryContextResult,
} from '../src/memoryContext.ts'

const NOW = '2026-11-12T10:00:00.000Z'

function manifest(overrides: Partial<GraphManifest> = {}): GraphManifest {
  return {
    schemaVersion: 1,
    id: 'g1',
    name: '采购制度图谱',
    scope: 'department:D1',
    version: 3,
    status: 'published',
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    visibility: 'department',
    nodes: [],
    edges: [],
    ...overrides,
  }
}

function node(id: string, path: string, overrides: Partial<LoadedGraphNode> = {}): LoadedGraphNode {
  return {
    id,
    path,
    type: 'policy',
    title: id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'approved',
    tags: [],
    sourceRefs: [],
    missing: false,
    ...overrides,
  }
}

function edge(id: string, from: string, to: string, docPath?: string, overrides: Partial<LoadedGraphEdge> = {}): LoadedGraphEdge {
  return {
    id,
    from,
    to,
    type: 'depends_on',
    title: id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'approved',
    tags: [],
    sourceRefs: [],
    missing: false,
    ...(docPath === undefined ? {} : { docPath }),
    ...overrides,
  }
}

function viewer(overrides: Partial<GraphViewer> = {}): GraphViewer {
  return {
    userId: 'u1',
    isAdmin: false,
    isSuperAdmin: false,
    departmentCode: 'D1',
    visibleDepartmentCodes: ['D1'],
    ...overrides,
  }
}

function binding(overrides: Partial<PersonalBinding> = {}): PersonalBinding {
  return {
    userId: 'u1',
    sourceType: 'node',
    sourceId: 'node-a',
    graphId: 'g1',
    mode: 'subscribe',
    sourceVersion: 3,
    sourceCommit: 'commit-3',
    lineage: {},
    status: 'active',
    updatedAt: NOW,
    ...overrides,
  }
}

async function writeDocument(root: string, relPath: string, frontMatter: string, body: string): Promise<void> {
  const target = join(root, relPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `---\n${frontMatter}\n---\n\n${body}\n`)
}

interface Fixture {
  root: string
  usersRoot: string
  graph: LoadedGraph
  bindings: PersonalBinding[]
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-context-'))
  const usersRoot = join(root, 'users')

  await writeDocument(root, '制度/采购制度.md',
    'id: node-a\ntitle: 采购制度\nauthority: canonical\norigin: human\nreviewStatus: approved',
    '采购正文：差旅标准 500 元。')
  await writeDocument(root, '流程/审批流程.md',
    'id: node-b\ntitle: 审批流程\nauthority: advisory\norigin: ai\nreviewStatus: reviewed',
    '审批正文：三级审批。')
  await writeDocument(root, '策略/安全红线.md',
    'id: node-c\ntitle: 安全红线\nauthority: redline\norigin: human\nreviewStatus: approved',
    '红线正文：禁止外发客户数据。')
  await writeDocument(root, '.graphs/g1/links/edge-1.md',
    'id: edge-1\nfrom: node-a\nto: node-b\ntype: depends_on\nauthority: advisory',
    '关系正文：采购依赖审批。')
  await writeDocument(root, '策略/普通关系.md',
    'id: edge-2\nfrom: node-b\nto: node-c\ntype: depends_on\nauthority: advisory',
    '关系正文：审批触及安全红线。')

  // One internalized branch owned by the user, deliberately divergent from node-b.
  const memoryRoot = join(usersRoot, 'u1', 'memory', 'g1')
  await mkdir(memoryRoot, { recursive: true })
  await writeFile(
    join(memoryRoot, 'node-b.md'),
    '---\nid: node-b\ntitle: 审批流程（个人）\nauthority: advisory\norigin: human\nreviewStatus: reviewed\n---\n\n'
      + '本地内化正文：我自己的审批笔记。\n',
  )

  const graph: LoadedGraph = {
    manifest: manifest(),
    root,
    nodes: [
      node('node-a', '制度/采购制度.md', { type: 'policy', title: '采购制度', authority: 'canonical', origin: 'human' }),
      node('node-b', '流程/审批流程.md', { type: 'procedure', title: '审批流程', authority: 'advisory', origin: 'ai', reviewStatus: 'reviewed' }),
      node('node-c', '策略/安全红线.md', { type: 'policy', title: '安全红线', authority: 'redline' }),
    ],
    edges: [
      edge('edge-1', 'node-a', 'node-b', '.graphs/g1/links/edge-1.md', { title: '采购依赖审批' }),
      edge('edge-2', 'node-b', 'node-c', '策略/普通关系.md', { title: '审批触及安全红线' }),
    ],
    issues: [],
  }

  return {
    root,
    usersRoot,
    graph,
    bindings: [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'edge', sourceId: 'edge-1', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
    ],
  }
}

function ids(result: MemoryContextResult): string[] {
  return result.entries.map(entry => entry.sourceId)
}

describe('memory context resolver', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('resolves live proxies and internalized branches in deterministic priority order', async () => {
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: fixture.bindings,
    })

    // canonical proxy (node), canonical relation (edge), then advisory internalized.
    expect(ids(result)).toEqual(['node-a', 'edge-1', 'node-b'])
    expect(result.entries.map(entry => entry.mode)).toEqual(['subscribe', 'subscribe', 'internalize'])

    const subscribed = result.entries[0]!
    expect(subscribed).toMatchObject({
      graphId: 'g1',
      sourceType: 'node',
      sourceId: 'node-a',
      authority: 'canonical',
      status: 'active',
      sourceVersion: 3,
      sourceCommit: 'commit-3',
      path: '制度/采购制度.md',
    })
    expect(subscribed.body).toContain('差旅标准 500 元')
    expect(subscribed.nonOverridable).toBe(false)

    const relation = result.entries[1]!
    expect(relation).toMatchObject({ sourceType: 'edge', from: 'node-a', to: 'node-b', path: '.graphs/g1/links/edge-1.md' })
    expect(relation.body).toContain('采购依赖审批')

    const internalized = result.entries[2]!
    expect(internalized).toMatchObject({
      mode: 'internalize',
      status: 'active',
      path: 'memory/g1/node-b.md',
      authority: 'advisory',
    })
    expect(internalized.body).toContain('本地内化正文')
    expect(internalized.body).not.toContain('三级审批')

    const again = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: fixture.bindings,
    })
    expect(ids(again)).toEqual(ids(result))
  })

  it('reflects a changed source body and frontmatter without re-running the guardian', async () => {
    const first = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a' })],
    })
    expect(first.entries[0]?.body).toContain('500 元')

    await writeDocument(fixture.root, '制度/采购制度.md',
      'id: node-a\ntitle: 采购制度（新版）\nauthority: canonical\norigin: human\nreviewStatus: approved',
      '采购正文：差旅标准 800 元。')

    const second = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a' })],
    })
    expect(second.entries[0]?.body).toContain('800 元')
    expect(second.entries[0]?.body).not.toContain('500 元')
    expect(second.entries[0]?.title).toBe('采购制度（新版）')
    // The binding was not refreshed; the proxy is live regardless.
    expect(second.entries[0]?.sourceVersion).toBe(3)
  })

  it('never follows a source change into an internalized branch', async () => {
    await writeDocument(fixture.root, '流程/审批流程.md',
      'id: node-b\ntitle: 审批流程\nauthority: advisory\norigin: ai\nreviewStatus: reviewed',
      '审批正文：已经改成新流程。')

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' })],
    })
    expect(result.entries[0]?.body).toContain('本地内化正文')
    expect(result.entries[0]?.body).not.toContain('已经改成新流程')
    expect(result.entries[0]?.title).toBe('审批流程（个人）')
  })

  it('carries stale and revoked branch status from the binding', async () => {
    const stale = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', status: 'stale', localPath: 'memory/g1/node-b.md' })],
    })
    expect(stale.entries[0]?.status).toBe('stale')
    expect(stale.entries[0]?.body).toContain('本地内化正文')

    const revoked = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', status: 'revoked', localPath: 'memory/g1/node-b.md' })],
    })
    expect(revoked.entries[0]?.status).toBe('revoked')
  })

  it('marks redlines nonOverridable and never drops them for the budget', async () => {
    const bindings = [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
      binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
    ]

    const wide = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
    })
    const redline = wide.entries.find(entry => entry.sourceId === 'node-c')
    expect(redline).toMatchObject({
      authority: 'redline',
      nonOverridable: true,
      policyNote: SYSTEM_POLICY_MARKER,
    })
    expect(wide.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    expect(redline?.body).toContain('禁止外发客户数据')

    // Zero budget: only the redline survives.
    const tight = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
      maxChars: 0,
    })
    expect(ids(tight)).toEqual(['node-c'])
    expect(tight.entries[0]?.nonOverridable).toBe(true)
    expect(tight.dropped.map(drop => drop.sourceId).sort()).toEqual(['node-a', 'node-b'])
    expect(tight.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    // Redline may exceed the budget; it is still returned.
    expect(tight.charCount).toBeGreaterThan(0)
  })

  it('drops the advisory internalized branch before the canonical proxy', async () => {
    const bindings = [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
      binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
    ]
    const wide = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
    })
    const internalized = wide.entries.find(entry => entry.mode === 'internalize')!
    const budget = wide.charCount - internalized.chars

    const tight = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
      maxChars: budget,
    })
    expect(tight.entries.map(entry => entry.sourceId)).toEqual(['node-c', 'node-a'])
    expect(tight.dropped).toEqual([
      expect.objectContaining({ sourceId: 'node-b', mode: 'internalize', reason: 'budget' }),
    ])
  })

  it('omits graphs, and relations with missing endpoints, that the viewer cannot see', async () => {
    const privateGraph: LoadedGraph = {
      manifest: manifest({ id: 'g2', name: '私有图谱', scope: 'personal:someone-else', visibility: 'private', owner: 'someone-else' }),
      root: fixture.root,
      nodes: [node('node-x', '私有/秘密.md')],
      edges: [],
      issues: [],
    }
    const foreignDepartment: LoadedGraph = {
      manifest: manifest({ id: 'g3', name: '别部门图谱', scope: 'department:D2', visibility: 'department' }),
      root: fixture.root,
      nodes: [node('node-y', '别部门/制度.md')],
      edges: [],
      issues: [],
    }

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph, privateGraph, foreignDepartment],
      bindings: [
        binding({ sourceType: 'node', sourceId: 'node-a' }),
        binding({ graphId: 'g2', sourceType: 'node', sourceId: 'node-x' }),
        binding({ graphId: 'g3', sourceType: 'node', sourceId: 'node-y' }),
      ],
    })
    expect(ids(result)).toEqual(['node-a'])

    // A relation whose endpoint is not in the loaded graph is omitted (fail closed).
    const broken: LoadedGraph = {
      manifest: manifest(),
      root: fixture.root,
      nodes: [node('node-a', '制度/采购制度.md', { authority: 'canonical' })],
      edges: [edge('edge-orphan', 'node-a', 'node-missing', '.graphs/g1/links/edge-1.md')],
      issues: [],
    }
    const orphan = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [broken],
      bindings: [binding({ sourceType: 'edge', sourceId: 'edge-orphan' })],
    })
    expect(orphan.entries).toEqual([])
  })

  it('inherits a redline from either endpoint of a relation', async () => {
    await writeDocument(fixture.root, '流程/审批红线关系.md',
      'id: edge-3\nfrom: node-b\nto: node-c\ntype: depends_on\nauthority: advisory',
      '关系正文：审批记录受红线约束。')

    const graph: LoadedGraph = {
      ...fixture.graph,
      edges: [
        ...fixture.graph.edges,
        edge('edge-3', 'node-b', 'node-c', '流程/审批红线关系.md', { title: '审批红线关系' }),
      ],
    }
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [graph],
      bindings: [binding({ sourceType: 'edge', sourceId: 'edge-3' })],
    })
    expect(result.entries[0]).toMatchObject({
      sourceType: 'edge',
      authority: 'redline',
      nonOverridable: true,
      policyNote: SYSTEM_POLICY_MARKER,
      from: 'node-b',
      to: 'node-c',
    })
  })
})