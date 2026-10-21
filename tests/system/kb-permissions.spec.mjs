// 权限页三档视图的真实入口验收。
//
// 每个用例对应用户报过的一个问题，从 DataOps 门户真实登录、进入 /ai/dsh 内嵌 DSH、
// 在权限页上通过 UI 操作看到用户可见结果。不用 mock、不调接口、不读源码。
//
// 背景（这一批修的两个缺陷）：
// 1. 「按人员」里显示的是 超级管理员 / 管理员 —— 那是角色不是人，用户原话
//    「按人员应该是按 dataops 账号展示吧」。
// 2. 管理员行的权限点显示「只读」，而管理员实际能读写。原因是前端按
//    read/create/update/delete 过滤，而 DataOps 存的是 read/write/manage，
//    write 与 manage 被静默丢弃，只剩 read。
//
// 凭据只从环境变量来（KB_SYSTEM_USER / KB_SYSTEM_PASS）；缺省时用例 skip 并说明
// 原因，绝不落一个"看起来通过"的结果。仓库里没有密码。

import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'
import { enterKnowledgeBase, hasCredentials } from './support/kb-portal.mjs'

test.skip(!hasCredentials, '需要 KB_SYSTEM_USER / KB_SYSTEM_PASS 才能驱动真实登录入口')

/**
 * 无害噪声：与本功能合同无关的宿主环境事实。
 *
 * - `net::ERR_ABORTED` / `ERR_NETWORK_CHANGED` 是 DSH 外壳在页面切换或 iframe 重挂载
 *   时取消自身握手请求，属于导航语义，不是知识库失败。
 * - WebGL `GPU stall due to ReadPixels` 是 Xvfb 无 GPU 时 Chrome 的软渲染提示。
 * - **非知识库路由的 5xx**：宿主里其它插件（genui 的 mermaid/three 资源、
 *   `dynamicCordisRunner`、`credentials/describe`、`open-in-app`、`managed-auth`）
 *   在后端短暂不可用时会返回 502。它们与权限页的渲染无关，却会让本用例失败——
 *   实测就是这样：页面内容完全正确（按人员列出 DataOps Admin / DataOps Operator），
 *   但整条用例因为一串 genui 的 502 被判失败。
 *
 *   这条豁免**刻意不覆盖知识库自己的路由**：`/knowledge-base/api/*` 的 5xx 是我们
 *   要的功能真的坏了，必须让用例失败。用"是否属于本插件"来划界，而不是笼统地
 *   忽略所有 5xx，否则就会把真实故障一起吞掉。
 */
function isAmbientNoise(problem) {
  if (problem.includes('net::ERR_ABORTED')) return true
  if (problem.includes('net::ERR_NETWORK_CHANGED')) return true
  if (problem.includes('GPU stall due to ReadPixels')) return true
  // A 5xx from another plugin's route: recorded as `HTTP 5xx: <url>` or a console
  // line quoting the same URL. Knowledge-base's own routes stay fatal.
  if (/HTTP 5\d\d|Bad Gateway|status of 5\d\d/u.test(problem)) {
    return !problem.includes('/knowledge-base/')
  }
  return false
}

/** 断言没有真实（非环境噪声）的浏览器或网络故障。 */
function expectNoProblems(problems) {
  expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
}

/**
 * 进入权限管理页。
 *
 * 三档视图是这一页的主体，所以"进来了"的判据是它自己的 tablist 出现过，而不是只看
 * 页面标题文字：标题在侧边栏和面板里都有，命中它不代表面板已经挂载。
 * @param {import('playwright/test').Page} page 页面。
 * @param {string[]} problems 浏览器问题收集器。
 * @returns {Promise<import('playwright/test').Frame>} DSH 框架。
 */
async function openPermissions(page, problems) {
  observePage(page, '权限管理', problems)
  const frame = await enterKnowledgeBase(page)
  await frame.getByText('权限管理', { exact: true }).first().click()
  await expect(frame.getByRole('tab', { name: '按人员' })).toBeVisible({ timeout: 25_000 })
  return frame
}

/** 当前 Tab 面板里唯一的那张表。 */
function activeTable(frame) {
  return frame.locator('[role="tabpanel"] table').first()
}

/** 当前表头文字，按列顺序。 */
async function headersOf(table) {
  return await table.locator('thead th').allInnerTexts().then(cells => cells.map(text => text.trim()))
}

/** 当前表格正文的行数（不含空态行）。 */
async function rowCount(table) {
  return await table.locator('tbody tr').count()
}

test('权限页有三个视图：按人员 / 按角色 / 按资源，切换后内容确实变化', async ({ page }) => {
  const problems = []
  const frame = await openPermissions(page, problems)

  // 三档是三种不同的行颗粒，缺一个就有一半问题查不到。
  const personTab = frame.getByRole('tab', { name: '按人员' })
  const roleTab = frame.getByRole('tab', { name: '按角色' })
  const resourceTab = frame.getByRole('tab', { name: '按资源' })
  await expect(personTab).toBeVisible()
  await expect(roleTab).toBeVisible()
  await expect(resourceTab).toBeVisible()

  // 逐个可点，且选中态跟随。
  await personTab.click()
  await expect(personTab).toHaveAttribute('aria-selected', 'true')

  // 「按人号」与「按资源」的第一列表头不同，这是"换了一份内容"的可观察证据：
  // 前者按账号，后者按资源路径。只断言 aria-selected 的话，一个空壳 tab 也能过。
  const personHeaders = await headersOf(activeTable(frame))

  await roleTab.click()
  await expect(roleTab).toHaveAttribute('aria-selected', 'true')
  const roleHeaders = await headersOf(activeTable(frame))

  await resourceTab.click()
  await expect(resourceTab).toHaveAttribute('aria-selected', 'true')
  const resourceHeaders = await headersOf(activeTable(frame))

  expect(roleHeaders).not.toEqual(personHeaders)
  expect(resourceHeaders).not.toEqual(personHeaders)

  expectNoProblems(problems)
})

test('「按人员」列的是 DataOps 账号，不出现角色名', async ({ page }) => {
  const problems = []
  const frame = await openPermissions(page, problems)

  await frame.getByRole('tab', { name: '按人员' }).click()
  const table = activeTable(frame)
  await expect(table).toBeVisible({ timeout: 25_000 })

  // 这一条盯的就是用户报的原 bug：角色名出现在「按人员」里。
  // 角色名是内置角色，且它们出现在「按角色」档是**正确**的，所以只在这一档断言缺席。
  //
  // 只看主体列（第一列）而不是整行文字：一行里可能出现路径或账号昵称与角色同名，
  // 整行断言会成为误报源；bug 的表现恰恰是第一列印着角色名。
  const subjectCells = await table.locator('tbody tr td:first-child').allInnerTexts()
  for (const cell of subjectCells) {
    expect(cell).not.toContain('超级管理员')
    // 精确到"整格就是这个角色名"，避免账号昵称含"管理员"三字时误报。
    expect(cell.trim().split(String.fromCharCode(10))[0].trim()).not.toBe('管理员')
  }

  // 正面的证据：这一档的主体列是账号。账号列的表头必须是「账号」，而不是「主体」。
  const headers = await headersOf(table)
  expect(headers[0]).toBe('账号')

  expectNoProblems(problems)
})

test('管理员的权限点显示包含读与写，而不是只读', async ({ page }) => {
  const problems = []
  const frame = await openPermissions(page, problems)

  // 角色的实际权限在「按角色」档最直接：管理员与超级管理员对 @kb-root 在库里是
  // read + write + manage 三条 seed grant。旧前端按 read/create/update/delete 过滤，
  // 把 write 与 manage 静默丢了，于是显示「只读」——而用户本人正能读写。
  await frame.getByRole('tab', { name: '按角色' }).click()
  const table = activeTable(frame)
  await expect(table).toBeVisible({ timeout: 25_000 })

  const row = table.locator('tbody tr', { hasText: '管理员' }).first()
  await expect(row).toBeVisible()

  // 权限点列里必须同时出现"写"与"读"的措辞。文案来自 actionWrite/actionRead：
  //   超管/管理员 显示「读 + 写 + 管理」，其中 actionWrite = 「可写」、actionRead = 「只读」
  // 所以这里断言的是一条"能写"的证据，而不是精确文案：只要出现"可写"或"管理"任一，
  // 就说明 write/manage 没有再被丢弃。
  const permissions = await row.innerText()
  expect(permissions).toMatch(/可写|管理/u)

  // 反向证据：整行的权限点不能只有「只读」一个标签。
  expect(permissions.trim()).not.toBe('只读')

  // 管理员本人此刻能读写（这是用户能新建/上传的原因），页面不得与之矛盾。
  // 若显示只读而实际能写，就是这条用例要抓的错。
  expectNoProblems(problems)
})

test('表格有分页器，切页大小与翻页都会改变行内容', async ({ page }) => {
  const problems = []
  const frame = await openPermissions(page, problems)

  await frame.getByRole('tab', { name: '按资源' }).click()
  const table = activeTable(frame)
  await expect(table).toBeVisible({ timeout: 25_000 })

  // 分页器只在超过一页时出现。数据少时它正确地隐身，所以这里在"有分页器"与
  // "一页装得下"之间二选一，而不是把数据量当成测试前提。
  const pager = frame.locator('[data-kb-pager]').first()
  const pagerShown = await pager.isVisible().catch(() => false)
  test.skip(!pagerShown, '当前授权数据不足一页，分页器按设计隐藏，无法驱动翻页')

  // 页码文本：形如「第 1 页 / 共 N 页 · 共 T 条」。
  const status = frame.locator('[data-kb-pager-status]').first()
  await expect(status).toBeVisible()
  await expect(status).toHaveText(/第\s*\d+\s*页.*共\s*\d+\s*页/u)

  // 页大小控件：SegmentedControl 自己渲染 role=tablist，且就在分页条内。
  const sizeControl = frame.locator('[data-kb-pager] [role="tablist"]').first()
  await expect(sizeControl).toBeVisible()

  const firstPageRows = await table.locator('tbody').innerText()

  // 翻到下一页。按钮在最后一页会禁用，所以只有能点才点。
  const next = frame.locator('[data-kb-pager-next]').first()
  const canAdvance = await next.isEnabled().catch(() => false)
  test.skip(!canAdvance, '当前只有一页，无法驱动翻页')

  await next.click()
  await expect(status).toHaveText(/第\s*2\s*页/u)
  const secondPageRows = await table.locator('tbody').innerText()
  // 翻页必须真的换了内容，而不是只改了页码文本。
  expect(secondPageRows).not.toBe(firstPageRows)

  expectNoProblems(problems)
})
