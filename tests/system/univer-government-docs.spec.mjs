import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'

const HARNESS_URL = process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3080'
const MARKER = process.env.DSH_E2E_GOV_DOC_MARKER ?? ''

test('用户从政府文档 Skill 创建、编辑、截图并导出 Traditional 文档', async ({ page }) => {
  test.skip(MARKER === '', 'requires DSH_E2E_GOV_DOC_MARKER')
  test.setTimeout(900_000)
  const problems = []
  observePage(page, 'government document', problems)

  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
  const testingNotice = page.getByRole('dialog', { name: /^(内测声明|Internal Testing Notice)$/ })
  if (await testingNotice.isVisible()) {
    await testingNotice.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    await expect(testingNotice).toBeHidden()
  }

  await page.getByRole('button', { name: /^(选择工作区|Choose workspace)$/ }).click()
  await page.getByRole('menuitem', { name: 'projects', exact: true }).click()

  const composer = page.getByRole('textbox', { name: /给智能体发消息|Message the agent|描述你想要构建的内容|Describe what you want to build/ })
  const relativeFile = 'dsh-univer-government-docs/artifacts/gui-' + MARKER + '.univer'
  const prompt = [
    '加载 univer-government-docs Skill，并按 Skill 使用通用政务 Traditional 模板。',
    '在当前 projects 工作区创建 ' + relativeFile + '。',
    '只创建一个 draft worktree；不要 ready、merge 或 discard。',
    '至少分两次调用 univer_execute，把标题改为“关于开展政务数据共享应用验收工作的通知”，并把主送机关、正文、一级标题、落款和日期替换成完整示例内容。',
    '随后依次执行 univer_inspect、univer_screenshot；截图输出目录必须是 dsh-univer-government-docs/artifacts/gui-' + MARKER + '-screenshots；再从同一个 draft 导出 dsh-univer-government-docs/artifacts/gui-' + MARKER + '.docx。',
    '最终回复必须包含独立标记 GOV-DOC-GUI-PASS:' + MARKER + '，以及 file、worktreeId、unitId。',
  ].join('\n')

  await composer.fill(prompt)
  await page.getByRole('button', { name: /^(发送消息|Send message)$/ }).click()
  await expect(page.getByRole('button', { name: /^(停止生成|Stop generating)$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(发送消息|Send message)$/ })).toBeVisible({ timeout: 840_000 })

  await expect(page.getByText('GOV-DOC-GUI-PASS:' + MARKER, { exact: false }).last()).toBeVisible()
  await expect(page.getByText('gui-' + MARKER + '.docx', { exact: false }).last()).toBeVisible()
  await expect(page.getByText('gui-' + MARKER + '-screenshots', { exact: false }).last()).toBeVisible()
  const review = page.getByRole('region', { name: 'gui-' + MARKER + '.univer' })
  await expect(review).toBeVisible()
  await expect(review).toContainText(/修改中|Modification in progress/)
  await expect(review).not.toContainText(/当前版本|Current version/)
  const viewerSrc = await review.locator('iframe').getAttribute('src')
  if (viewerSrc === null) throw new Error('Univer review card has no Viewer URL')
  const viewerOrigin = new URL(viewerSrc).origin

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('GOV-DOC-GUI-PASS:' + MARKER, { exact: false }).last()).toBeVisible()
  await expect(review).toBeVisible()
  await expect(review).toContainText(/修改中|Modification in progress/)
  const actionableProblems = problems.filter(problem => {
    const viewerAbort = problem.startsWith('government document requestfailed: ' + viewerOrigin + '/') && problem.endsWith('net::ERR_ABORTED')
    const rediWarning = problem.includes('console warning: [redi]: Expect 0 custom parameter(s) of xG but get 1.') && problem.includes(viewerOrigin + '/')
    return !viewerAbort && !rediWarning
  })
  expect(actionableProblems).toEqual([])
})
