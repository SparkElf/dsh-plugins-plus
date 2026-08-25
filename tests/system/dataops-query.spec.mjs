import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'

const HARNESS_URL = process.env.DSH_DATAOPS_SYSTEM_URL ?? process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3081'
const QUERY_PROMPT = process.env.DSH_E2E_DATA_QUERY_PROMPT ?? ''
const CHART_TITLE = process.env.DSH_E2E_DATA_QUERY_CHART_TITLE ?? ''
const ANALYSIS_MARKER = process.env.DSH_E2E_DATA_QUERY_ANALYSIS_MARKER ?? ''

test('用户通过真实 DataOps 结果完成语义分析和交互图表，并在刷新后继续看到同一结果', async ({ page }) => {
  test.skip(
    QUERY_PROMPT === '' || CHART_TITLE === '' || ANALYSIS_MARKER === '',
    'requires DSH_E2E_DATA_QUERY_PROMPT, DSH_E2E_DATA_QUERY_CHART_TITLE, and DSH_E2E_DATA_QUERY_ANALYSIS_MARKER',
  )
  test.setTimeout(600_000)
  const problems = []
  observePage(page, 'data query', problems)

  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
  const testingNotice = page.getByRole('dialog', { name: /^(内测声明|Internal Testing Notice)$/ })
  if (await testingNotice.isVisible()) {
    await testingNotice.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    await expect(testingNotice).toBeHidden()
  }

  const composer = page.getByPlaceholder(/^(给智能体发消息|Message the agent|描述你想要构建的内容|Describe what you want to build)$/)
  await composer.fill(QUERY_PROMPT)
  await page.getByRole('button', { name: /^(发送消息|Send message)$/ }).click()
  await expect(page.getByRole('button', { name: /^(停止生成|Stop generating)$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(发送消息|Send message)$/ })).toBeVisible({ timeout: 540_000 })

  await expect(page.getByText('Analyze complete query result', { exact: true })).toBeVisible()
  await expect(page.getByText(ANALYSIS_MARKER, { exact: false }).last()).toBeVisible()
  const chart = page.getByRole('img', { name: CHART_TITLE, exact: true })
  await expect(chart).toBeVisible()
  await expect(chart.locator('canvas')).toBeVisible()
  await expect(page.getByText(/^(无法渲染该图表。|Unable to render this chart.)$/)).toHaveCount(0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Analyze complete query result', { exact: true })).toBeVisible()
  await expect(page.getByText(ANALYSIS_MARKER, { exact: false }).last()).toBeVisible()
  const replayedChart = page.getByRole('img', { name: CHART_TITLE, exact: true })
  await expect(replayedChart).toBeVisible()
  await expect(replayedChart.locator('canvas')).toBeVisible()

  const subagents = page.getByRole('button', { name: /子代理|subagents/i })
  await expect(subagents).toBeVisible({ timeout: 30_000 })
  await subagents.click()
  const childTree = page.getByRole('tree', { name: /子代理会话|Subagent sessions/i })
  const batchChild = childTree.getByRole('treeitem', {
    name: /^Analysis qa2_[0-9a-f-]+ batch 1\b/i,
  }).first()
  await expect(batchChild).toBeVisible()
  await batchChild.click()
  await expect(page.getByRole('status').filter({ hasText: /一次性子代理记录|One-shot subagent record/i })).toBeVisible()
  expect(problems).toEqual([])
})
