import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GraphManifest, LoadedGraph, LoadedGraphNode } from '../src/graphModel.ts'
import type { GraphViewer } from '../src/graphPolicy.ts'
import { BindingStore, type PersonalBinding } from '../src/memoryBindings.ts'
import {
  createMemoryTools,
  type MemoryContextToolResult,
  type MemoryGuardianToolResult,
  type MemoryToolHost,
} from '../src/memoryTools.ts'

const NOW = '2026-11-12T11:00:00.000Z'

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

function reader(overrides: Partial<GraphViewer> = {}): GraphViewer {
  return {
    userId: 'u1',
    isAdmin: false,
    isSuperAdmin: false,
    departmentCode: 'D1',
    visibleDepartmentCodes: ['D1'],
    ...overrides,
  }
}

function configManager(overrides: Partial<GraphViewer> = {}): GraphViewer {
  return reader({
    isAdmin: true,
    manageableDepartmentCodes: ['D1'],
    ...overrides,
  })
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
  store: BindingStore
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-tools-'))
  const usersRoot = join(root, 'users')
  await writeDocument(root, '制度/采购制度.md',
    'id: node-a\ntitle: 采购制度\nauthority: canonical\norigin: human\nreviewStatus: approved',
    '采购正文：差旅标准 500 元。')

  const graph: LoadedGraph = {
    manifest: manifest(),
    root,
    nodes: [node('node-a', '制度/采购制度.md', { title: '采购制度', authority: 'canonical' })],
    edges: [],
    issues: [],
  }
  return { root, usersRoot, graph, store: new BindingStore(usersRoot) }
}

function makeHost(fixture: Fixture, viewer: GraphViewer, canManage: boolean, memoryEnabled = true): MemoryToolHost {
  return {
    resolveCaller: async () => viewer,
    usersRoot: fixture.usersRoot,
    loadGraphs: async () => [fixture.graph],
    canManage: async () => canManage,
    isMemoryEnabled: async () => memoryEnabled,
  }
}

describe('memory_context tool', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
    await fixture.store.set(binding())
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('returns a paused context without personal entries when the user paused memory', async () => {
    const [contextTool] = createMemoryTools(makeHost(fixture, reader(), false, false))
    const result = await contextTool!.execute({ format: 'markdown' }, {} as never) as unknown as MemoryContextToolResult
    expect(result.paused).toBe(true)
    expect(result.rendered).toContain('Personal memory is paused')
    expect(result.context.entries).toHaveLength(0)
  })

  it('returns a markdown context with live proxy content', async () => {
    const [contextTool] = createMemoryTools(makeHost(fixture, reader(), false))
    const result = await contextTool!.execute({ format: 'markdown' }, {} as never) as unknown as MemoryContextToolResult

    expect(result.ok).toBe(true)
    expect(result.format).toBe('markdown')
    expect(result.rendered).toContain('# Memory context (u1)')
    expect(result.rendered).toContain('采购制度')
    expect(result.rendered).toContain('差旅标准 500 元')
    expect(result.rendered).toContain('mode: subscribe')
    expect(result.context.entries).toHaveLength(1)

    // The proxy reads the document live on every call.
    await writeDocument(fixture.root, '制度/采购制度.md',
      'id: node-a\ntitle: 采购制度\nauthority: canonical\norigin: human\nreviewStatus: approved',
      '采购正文：差旅标准 900 元。')
    const again = await contextTool!.execute({ format: 'markdown' }, {} as never) as unknown as MemoryContextToolResult
    expect(again.rendered).toContain('差旅标准 900 元')
    expect(again.rendered).not.toContain('差旅标准 500 元')
  })

  it('returns parseable JSON and honours maxChars', async () => {
    const [contextTool] = createMemoryTools(makeHost(fixture, reader(), false))
    const result = await contextTool!.execute({ format: 'json', maxChars: 0 }, {} as never) as unknown as MemoryContextToolResult

    const parsed = JSON.parse(result.rendered) as { userId: string; maxChars: number; entries: unknown[]; dropped: unknown[] }
    expect(parsed.userId).toBe('u1')
    expect(parsed.maxChars).toBe(0)
    expect(parsed.entries).toEqual([])
    expect(parsed.dropped).toHaveLength(1)
  })
})

describe('memory_guardian_run tool', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('denies a reader and writes nothing', async () => {
    const [, guardianTool] = createMemoryTools(makeHost(fixture, reader(), false))
    await expect(guardianTool!.execute({}, {} as never)).rejects.toMatchObject({
      name: 'KnowledgeToolError',
      code: 'forbidden',
    })
    expect(await fixture.store.list('u1')).toEqual([])
  })

  it('runs the guardian for a config manager and is idempotent', async () => {
    const [, guardianTool] = createMemoryTools(makeHost(fixture, configManager(), true))
    const first = await guardianTool!.execute({}, {} as never) as unknown as MemoryGuardianToolResult

    expect(first.ok).toBe(true)
    expect(first.userId).toBe('u1')
    expect(first.graphs).toHaveLength(1)
    expect(first.graphs[0]).toMatchObject({
      graphId: 'g1',
      createdPending: 1,
      subscribed: 1,
      internalized: 0,
      rejectedRedline: 0,
    })
    expect(first.totals.createdPending).toBe(1)
    expect(await fixture.store.get('u1', 'node', 'node-a')).toMatchObject({
      mode: 'subscribe',
      sourceVersion: 3,
    })

    const second = await guardianTool!.execute({}, {} as never) as unknown as MemoryGuardianToolResult
    expect(second.graphs[0]?.createdPending).toBe(0)
    expect(second.totals).toEqual({
      createdPending: 0,
      subscribed: 0,
      internalized: 0,
      rejectedRedline: 0,
      upstreamUpdates: 0,
      revoked: 0,
    })
  })
})