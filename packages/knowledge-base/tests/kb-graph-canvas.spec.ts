// @vitest-environment jsdom
/**
 * The graph canvas runs in its own document and speaks to the panel over
 * `postMessage`. A document card in the topic detail panel is the second way into
 * a file (the Home table is the first), so a click there must produce a
 * `kg:open-document` message with the view-relative path.
 *
 * This is a regression test for a shadowed global: the canvas keeps a tree map in a
 * module-level `parent`, which made every `parent.postMessage(...)` in the same
 * script call `Map.postMessage` and throw inside a `try/catch`. The click looked
 * dead with no error anywhere. Keep the map named `parentOf`; this test executes
 * the real canvas script, not a copy of its wiring.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { GRAPH_CANVAS_HTML } from '../src/graphCanvas.ts'

const DOCUMENT_PATH = 'personal/知识图谱/工作轨迹/个人知识库/scope.md'

const graphPayload = {
  type: 'kg:set-graphs',
  graphs: [
    {
      id: 'personal/知识图谱/工作轨迹',
      name: '工作轨迹',
      scope: 'personal',
      path: 'personal/知识图谱/工作轨迹',
      group: '',
      topics: [
        {
          id: 'personal-kb',
          title: '个人知识库',
          status: '进行中',
          depth: 3,
          tags: [],
          summary: '只读闭环：tab、图谱树、画布、主题详情。',
          body: '只读闭环：tab、图谱树、画布、主题详情。写操作下一期。',
          folder: '个人知识库',
          path: 'personal/知识图谱/工作轨迹/个人知识库',
          documents: [
            {
              title: '作用域与权限',
              file: 'scope.md',
              path: DOCUMENT_PATH,
              date: '2026-10-31',
            },
          ],
        },
      ],
      links: [],
      counts: { topics: 1, links: 0, documents: 1 },
    },
  ],
  activeGraphId: 'personal/知识图谱/工作轨迹',
  selectedTopicId: null,
}

describe('graph canvas document cards', () => {
  it('posts kg:open-document with the view-relative path when a card is clicked', async () => {
    const dom = new JSDOM(GRAPH_CANVAS_HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/knowledge-base/api/graph.canvas',
    })
    const { window } = dom
    const messages: Array<{ type?: string; path?: string }> = []
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; path?: string } | null
      if (data !== null && typeof data === 'object') messages.push(data)
    })

    // The script posts `kg:ready` from its own load handler; wait for the document
    // to finish, then hand it the same payload the host sends.
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    window.postMessage(graphPayload, '*')
    await new Promise((resolve) => window.setTimeout(resolve, 50))

    const view = (window as unknown as { __KG_VIEW__?: { selectTopic: (id: string) => void } }).__KG_VIEW__
    expect(view).toBeTruthy()
    view?.selectTopic('personal-kb')

    const card = window.document.querySelector('.p-doc-item') as HTMLElement | null
    expect(card).not.toBeNull()
    expect(card?.getAttribute('data-doc-path')).toBe(DOCUMENT_PATH)
    card?.click()

    await new Promise((resolve) => window.setTimeout(resolve, 50))
    const opened = messages.find((message) => message.type === 'kg:open-document')
    expect(opened?.path).toBe(DOCUMENT_PATH)
    dom.window.close()
  })
})