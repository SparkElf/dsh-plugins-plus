import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseGraphFrontMatter,
  parseGraphList,
  readGraphLinks,
  scanKnowledgeGraphs,
  type KnowledgeGraphScopeRoot,
} from '../src/graph.ts'
import {
  emptyKnowledgeGraphTree,
  knowledgeGraphMatches,
  knowledgeGraphsOf,
  type KnowledgeGraphNode,
} from '../src/graphTypes.ts'
import { permissionForKbRoute } from '../src/index.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-graph-'))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('the knowledge-graph route is read-only', () => {
  it('maps the graph route to the file-read permission', () => {
    expect(permissionForKbRoute('graph')).toBe('kb:file:read')
  })

  it('leaves the canvas page ungated by a data permission', () => {
    // The page carries no data and makes no request; the graph route above is the
    // one that must be authorized.
    expect(permissionForKbRoute('graph.canvas')).toBeUndefined()
  })
})

describe('the graph scanner', () => {
  it('reads cards, documents and .kg relations without listing .kg as a topic', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'global', '知识图谱', '平台建设')
    await write(join(graph, '任务总线', 'index.md'), [
      '---',
      'id: task-bus',
      'title: 任务总线',
      'status: active',
      'depth: 4',
      'domain: dsh',
      'tags: [任务, 状态机]',
      '---',
      '',
      '# 任务总线',
      '',
      '任务卡是唯一状态载体。',
      '',
      '## 现在',
      '设计稿完成。',
      '',
    ].join('\n'))
    await write(join(graph, '任务总线', 'state-machine.md'), [
      '# 任务状态机',
      '',
      '主状态与流转。',
      '',
    ].join('\n'))
    await write(join(graph, '群聊', 'index.md'), [
      '---',
      'id: group-chat',
      'title: 群聊',
      '---',
      '# 群聊',
      '',
      '人机协作入口。',
      '',
    ].join('\n'))
    await write(join(graph, '.kg', 'links', 'task-bus--group-chat.md'), [
      '---',
      'a: task-bus',
      'b: group-chat',
      'label: 来源与展示面',
      'updated: 2026-10-28',
      '---',
      '# 任务总线 ↔ 群聊',
      '',
      '群聊是任务的来源与展示面。',
      '',
    ].join('\n'))
    // A relation to a topic that does not exist must not become an invisible edge.
    await write(join(graph, '.kg', 'links', 'task-bus--missing.md'), [
      '---',
      'a: task-bus',
      'b: missing',
      '---',
      'broken',
    ].join('\n'))

    const root: KnowledgeGraphScopeRoot = {
      key: 'global',
      actualPath: 'global/知识图谱',
      viewPath: 'global/知识图谱',
      groupKey: '',
      groupLabel: '',
    }
    const canRead = vi.fn(async () => true)
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [root],
      caller: { userId: 'u1', label: '测试用户' },
      canRead,
    })

    expect(tree.visible).toBe(1)
    expect(tree.scanned).toBe(1)
    expect(tree.scopes[0]?.groups[0]?.graphs).toHaveLength(1)
    const node = tree.scopes[0]?.groups[0]?.graphs[0]
    expect(node?.id).toBe('global/知识图谱/平台建设')
    expect(node?.counts).toEqual({ topics: 2, links: 1, documents: 1 })
    expect(node?.topics.map(topic => topic.id).sort()).toEqual(['group-chat', 'task-bus'])
    const taskBus = node?.topics.find(topic => topic.id === 'task-bus')
    expect(taskBus?.title).toBe('任务总线')
    expect(taskBus?.depth).toBe(4)
    expect(taskBus?.tags).toEqual(['任务', '状态机'])
    expect(taskBus?.summary).toBe('任务卡是唯一状态载体。')
    expect(taskBus?.body).toContain('## 现在')
    expect(taskBus?.documents).toHaveLength(1)
    expect(taskBus?.documents[0]).toMatchObject({ title: '任务状态机', file: 'state-machine.md' })
    // `index.md` is the card, not a document; `.kg` is never a topic.
    expect(taskBus?.documents.some(document => document.file === 'index.md')).toBe(false)
    expect(node?.topics.some(topic => topic.folder === '.kg')).toBe(false)
    expect(node?.links).toEqual([{
      a: 'task-bus',
      b: 'group-chat',
      label: '来源与展示面',
      updated: '2026-10-28',
      body: '群聊是任务的来源与展示面。',
    }])
    // One permission question per graph, never one per file or per `.kg` entry.
    expect(canRead).toHaveBeenCalledTimes(1)
    expect(canRead).toHaveBeenCalledWith('global/知识图谱/平台建设')
  })

  it('drops a denied graph before returning its name or contents', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'global', '知识图谱', '公开图谱', '主题', 'index.md'), '# 公开\n\n可见。\n')
    await write(join(actualRoot, 'global', '知识图谱', '机密图谱', '秘密', 'index.md'), '# 秘密\n\n不可见。\n')
    const root: KnowledgeGraphScopeRoot = {
      key: 'global',
      actualPath: 'global/知识图谱',
      viewPath: 'global/知识图谱',
      groupKey: '',
      groupLabel: '',
    }
    const canRead = vi.fn(async (path: string) => !path.includes('机密'))
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [root],
      caller: { userId: 'u1', label: '测试用户' },
      canRead,
    })

    expect(tree.scanned).toBe(2)
    expect(tree.visible).toBe(1)
    expect(tree.denied).toBe(1)
    expect(knowledgeGraphsOf(tree).map(graph => graph.name)).toEqual(['公开图谱'])
    expect(JSON.stringify(tree)).not.toContain('机密')
    expect(JSON.stringify(tree)).not.toContain('秘密')
    expect(canRead).toHaveBeenCalledTimes(2)
  })

  it('scans only the scope roots it is given, so another department never appears', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'department', 'data-platform', '知识图谱', '本部门图谱', '主题', 'index.md'), '# 本部门\n\n。\n')
    await write(join(actualRoot, 'department', 'other', '知识图谱', '外部门图谱', '主题', 'index.md'), '# 外部门\n\n。\n')
    const rootsGiven: KnowledgeGraphScopeRoot[] = [{
      key: 'department',
      actualPath: 'department/data-platform/知识图谱',
      viewPath: 'department/知识图谱',
      groupKey: 'data-platform',
      groupLabel: '数据平台',
    }]
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: rootsGiven,
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })

    expect(tree.scanned).toBe(1)
    const graphs = knowledgeGraphsOf(tree)
    expect(graphs.map(graph => graph.name)).toEqual(['本部门图谱'])
    expect(JSON.stringify(tree)).not.toContain('外部门')
    expect(graphs[0]?.path).toBe('department/知识图谱/本部门图谱')
    expect(tree.scopes.find(scope => scope.key === 'department')?.groups[0]?.label).toBe('数据平台')
  })

  it('resolves a personal root through the root it was handed, never by composing a uid', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'personal', 'uid-1', '知识图谱', '工作轨迹', '主题', 'index.md'), '# 工作轨迹\n\n。\n')
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'personal',
        actualPath: 'personal/uid-1/知识图谱',
        viewPath: 'personal/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'uid-1', label: '我' },
      canRead: async () => true,
    })
    const graph = knowledgeGraphsOf(tree)[0]
    expect(graph?.id).toBe('personal/知识图谱/工作轨迹')
    expect(graph?.path).not.toContain('uid-1')
    expect(tree.actualRoot).toBe(actualRoot)
  })

  it('treats a permission call that throws as a denial and keeps scanning', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'global', '知识图谱', '甲', '主题', 'index.md'), '# 甲\n\n。\n')
    await write(join(actualRoot, 'global', '知识图谱', '乙', '主题', 'index.md'), '# 乙\n\n。\n')
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'global',
        actualPath: 'global/知识图谱',
        viewPath: 'global/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async (path: string) => {
        if (path.endsWith('甲')) throw new Error('backend down')
        return true
      },
    })
    expect(tree.visible).toBe(1)
    expect(tree.denied).toBe(1)
    expect(knowledgeGraphsOf(tree).map(graph => graph.name)).toEqual(['乙'])
  })

  it('ignores a missing .kg directory and a graph with no topics', async () => {
    const actualRoot = await tempRoot()
    await mkdir(join(actualRoot, 'global', '知识图谱', '空图谱'), { recursive: true })
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'global',
        actualPath: 'global/知识图谱',
        viewPath: 'global/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })
    const graph = knowledgeGraphsOf(tree)[0]
    expect(graph?.topics).toEqual([])
    expect(graph?.links).toEqual([])
    expect(graph?.counts).toEqual({ topics: 0, links: 0, documents: 0 })
  })
})

describe('the graph card format', () => {
  it('splits simple front matter without needing a YAML dependency', () => {
    const parsed = parseGraphFrontMatter('---\ntitle: 标题\ntags: [a, b]\n---\n# 标题\n\n正文\n')
    expect(parsed.meta.title).toBe('标题')
    expect(parsed.meta.tags).toBe('[a, b]')
    expect(parsed.body).toContain('# 标题')
    expect(parseGraphList(parsed.meta.tags)).toEqual(['a', 'b'])
  })

  it('returns the whole document when there is no front matter', () => {
    expect(parseGraphFrontMatter('# 只有正文\n').meta).toEqual({})
    expect(parseGraphFrontMatter('# 只有正文\n').body).toBe('# 只有正文\n')
  })

  it('drops relations whose endpoints do not both exist', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'g')
    await write(join(graph, '.kg', 'links', 'a--b.md'), '---\na: a\nb: b\n---\n正文\n')
    await write(join(graph, '.kg', 'links', 'a--c.md'), '---\na: a\nb: c\n---\n正文\n')
    const links = await readGraphLinks(graph, new Set(['a', 'b']))
    expect(links.map(link => link.a + '--' + link.b)).toEqual(['a--b'])
  })
})

describe('the graph tree filter', () => {
  const graph: KnowledgeGraphNode = {
    id: 'global/知识图谱/平台建设',
    name: '平台建设',
    scope: 'global',
    path: 'global/知识图谱/平台建设',
    group: '',
    topics: [{
      id: 'task-bus',
      title: '任务总线',
      status: 'active',
      depth: 4,
      tags: [],
      summary: '',
      body: '',
      folder: '任务总线',
      path: 'global/知识图谱/平台建设/任务总线',
      documents: [],
    }],
    links: [],
    counts: { topics: 1, links: 0, documents: 0 },
  }

  it('matches a graph by its own name or a topic title, not by path', () => {
    expect(knowledgeGraphMatches(graph, '')).toBe(true)
    expect(knowledgeGraphMatches(graph, '平台')).toBe(true)
    expect(knowledgeGraphMatches(graph, '任务')).toBe(true)
    expect(knowledgeGraphMatches(graph, '不存在的')).toBe(false)
  })

  it('starts from an empty tree with the three scopes in display order', () => {
    const tree = emptyKnowledgeGraphTree()
    expect(tree.scopes.map(scope => scope.key)).toEqual(['global', 'department', 'personal'])
    expect(knowledgeGraphsOf(tree)).toEqual([])
  })
})