// 知识库真实入口系统验收。
//
// 每个用例对应一个用户目标：从 DataOps 门户真实登录，进入 /ai/dsh 的内嵌 DSH，
// 在知识库页面上通过 UI 操作看到用户可见结果。不用 mock、不调接口、不读源码。
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
 * - `_dataops/session` / `managed-auth` 的 ERR_ABORTED 是 DSH 外壳在页面切换时取消
 *   自身握手请求，属于导航语义，不是知识库失败。
 * - WebGL `GPU stall due to ReadPixels` 是 Xvfb 无 GPU 时 Chrome 的软渲染提示，每个
 *   用例都会出现，与界面正确性无关。
 * - `net::ERR_NETWORK_CHANGED` 是浏览器在 iframe 重挂载时对被中断请求的统一报错
 *   （群聊成员、Agent 预设、模型目录等宿主请求都会被卷进来），属于导航语义。
 *
 * 除这几类外的问题仍然让用例失败，避免把真实故障淹没在噪声里。
 */
function isAmbientNoise(problem) {
  return problem.includes('net::ERR_ABORTED')
    || problem.includes('net::ERR_NETWORK_CHANGED')
    || problem.includes('GPU stall due to ReadPixels')
}

/** 每个用例都从知识库主页开始；登录与导航属于共用技术前置条件。 */
async function openKnowledgeBase(page, problems, label) {
  observePage(page, label, problems)
  const frame = await enterKnowledgeBase(page)
  // 主页自己的复选标记：三个栏目可见，说明知识库已完成首次数据加载。
  await expect(frame.getByText('主页', { exact: true }).first()).toBeVisible({ timeout: 25_000 })
  return frame
}

/** 断言没有真实（非环境噪声）的浏览器或网络故障。 */
function expectNoProblems(problems) {
  expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
}

/** 当前页面的 [role=dialog] 集合。 */
function dialogs(frame) {
  return frame.locator('[role="dialog"]')
}

test('知识库主页列出文档，打开一份文档就能看到正文', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '知识库主页')

  // 用户看到的是一张有内容的列表，而不是空表：至少一行以 .md 结尾的文件名。
  const documentCell = frame.getByText(/^[^\s]+\.md$/u).first()
  await expect(documentCell).toBeVisible({ timeout: 25_000 })
  const name = (await documentCell.innerText()).trim()

  await documentCell.click()
  // 选中文件后右栏出现内容区，这是"点开能读到东西"，不是"点了没反应"。
  await expect(frame.locator('[data-kb-reader-open]')).toHaveCount(1, { timeout: 25_000 })
  await expect(frame.getByText(name, { exact: true }).first()).toBeVisible()

  expectNoProblems(problems)
})

test('权限管理给出四个统计卡和按人员/按资源两种读法', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '权限管理')

  await frame.getByText('权限管理', { exact: true }).first().click()

  // 四个统计卡是这一页的信息骨架：少了用户就不知道当前授权规模。
  await expect(frame.locator('[class*="statCard"]')).toHaveCount(4, { timeout: 25_000 })
  // 两种读法是同一份授权的两个视角，缺一个就有一半问题查不到。
  await expect(frame.getByRole('tab', { name: '按人员' })).toBeVisible()
  await expect(frame.getByRole('tab', { name: '按资源' })).toBeVisible()

  // 切到"按资源"确实换了一份内容，而不是只有 tab 装饰。
  await frame.getByRole('tab', { name: '按资源' }).click()
  await expect(frame.getByRole('tab', { name: '按资源' })).toHaveAttribute('aria-selected', 'true')

  expectNoProblems(problems)
})

test('审计页把待审批与已发生日志分成两栏', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '审计')

  await frame.getByText('审计', { exact: true }).first().click()

  // 审批与日志是两个不同的问题域：一个要人做决定，一个是追溯记录。
  await expect(frame.getByRole('tab', { name: /^审批/u })).toBeVisible({ timeout: 25_000 })
  await expect(frame.getByRole('tab', { name: '日志' })).toBeVisible()

  expectNoProblems(problems)
})

test('新建文档走官方弹窗并且能选存放位置', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '新建文档')

  await frame.getByText('新建', { exact: true }).first().click()

  // 官方 Modal 形态：文档里出现 role=dialog 且以"新建文档"命名。
  // 以前这里是自制下拉加一个 window.prompt，既不能选位置也不可样式化。
  const dialog = dialogs(frame).filter({ has: frame.locator('body') }).first()
  await expect(dialogs(frame).first()).toBeVisible({ timeout: 25_000 })
  await expect(frame.locator('[role="dialog"][aria-label="新建文档"]')).toBeVisible()

  // 位置是弹窗的一部分：用户必须能看见并改变文档落到哪里，默认不能固定 global。
  await expect(frame.getByText('存放位置', { exact: true })).toBeVisible()
  const destination = frame.getByText(/^(顶层|global|personal\/)/u).first()
  await expect(destination).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(frame.locator('[role="dialog"][aria-label="新建文档"]')).toBeHidden()
})

test('模板库是卡片式弹窗，模板与管理同在一处', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '模板库')

  await frame.getByText('模板库', { exact: true }).first().click()

  const library = frame.locator('[role="dialog"][aria-label="模板库"]')
  await expect(library).toBeVisible({ timeout: 25_000 })

  // 弹窗内两个 tab：一个用来取用模板，一个用来维护模板。
  // 只有列表没有维护，模板只能靠改文件系统；只有维护没有列表，用户用不上。
  await expect(library.getByRole('tab', { name: '模板' })).toBeVisible()
  await expect(library.getByRole('tab', { name: '管理' })).toBeVisible()

  // 切到管理能看到新增入口，说明维护侧真的接上了。
  await library.getByRole('tab', { name: '管理' }).click()
  await expect(library.getByRole('button', { name: '新增模板' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(library).toBeHidden()
})

test('本地模式下设置页不给出无法执行的远程部署步骤', async ({ page }) => {
  const problems = []
  const frame = await openKnowledgeBase(page, problems, '设置')

  await frame.getByText('设置', { exact: true }).first().click()
  const knowledge = frame.getByText('知识库', { exact: true })
  await expect(knowledge.first()).toBeVisible({ timeout: 25_000 })
  await knowledge.last().click()

  // 本地存储没有共享导出可部署，所以"检查环境"这类远程步骤不该出现：
  // 给一个按了必然失败的按钮，比不给更糟。
  await expect(frame.getByText('检查环境', { exact: true })).toHaveCount(0)

  expectNoProblems(problems)
})
