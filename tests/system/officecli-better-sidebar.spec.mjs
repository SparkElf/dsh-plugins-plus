import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'

const HARNESS_URL = process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3080'
const MARKER = process.env.DSH_E2E_OFFICE_MARKER ?? ''

test('用户用 OfficeCLI 生成三种原件并在 Better Sidebar 连续查看', async ({ page }) => {
  test.skip(MARKER === '', 'requires DSH_E2E_OFFICE_MARKER')
  test.setTimeout(900_000)
  const problems = []
  observePage(page, 'officecli better sidebar', problems)

  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
  const testingNotice = page.getByRole('dialog', { name: /^(内测声明|Internal Testing Notice)$/ })
  const testingNoticeVisible = await testingNotice.waitFor({ timeout: 5_000 }).then(
    () => true,
    (error) => {
      if (error?.name !== 'TimeoutError') throw error
      return false
    },
  )
  if (testingNoticeVisible) {
    await testingNotice.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    await expect(testingNotice).toBeHidden()
  }

  const emptyWorkspace = page.getByRole('textbox', { name: /^(选择工作区|Choose workspace)$/ })
  if (await emptyWorkspace.isVisible()) {
    await emptyWorkspace.click()
    const dialog = page.getByRole('dialog', { name: /^(选择工作区目录|Choose workspace directory)$/ })
    await dialog.getByRole('button', { name: /^(编辑路径|Edit path)$/ }).click()
    const path = dialog.getByRole('textbox', { name: /^(编辑路径|Edit path)$/ })
    await path.fill('/root/projects')
    await path.press('Enter')
    await dialog.getByRole('button', { name: /^(打开|Open)$/ }).click()
  } else {
    await page.getByRole('button', { name: /^(选择工作区|Choose workspace)$/ }).click()
    await page.getByRole('menuitem', { name: 'projects', exact: true }).click()
  }

  const composer = page.getByRole('textbox', {
    name: /给智能体发消息|Message the agent|描述你想要构建的内容|Describe what you want to build/,
  })
  const outputRoot = '/root/projects/output/gui-' + MARKER
  const docxName = 'gui-' + MARKER + '.docx'
  const xlsxName = 'gui-' + MARKER + '.xlsx'
  const pptxName = 'gui-' + MARKER + '.pptx'
  const prompt = [
    '加载 office-government-docs Skill，并调用 officecli 的 load_skill word、load_skill excel、load_skill pptx 读取当前命令说明。',
    '直接创建三个原始 Office 文件，不生成 HTML、PNG、PDF 或 .univer：',
    outputRoot + '.docx：两页中文政务通知，标题为“OfficeCLI 文档预览验收通知”，正文使用政务字体和真实分页。',
    outputRoot + '.xlsx：包含“汇总”和“明细”两个工作表；汇总表有深色标题填充、百分比和人民币数字格式。',
    outputRoot + '.pptx：三页演示，第一页标题“OfficeCLI 演示预览验收”，第二页包含文字“侧栏搜索定位目标”，第三页包含结论。',
    '依次对三个原件执行 validate --json 和结构读取，修复发现的问题。',
    '最终回复包含独立标记 OFFICECLI-SIDEBAR-PASS:' + MARKER + '，并在三行中分别给出三个原件的绝对路径。',
  ].join('\n')

  await composer.fill(prompt)
  await page.getByRole('button', { name: /^(发送消息|Send message)$/ }).click()
  await expect(page.getByRole('button', { name: /^(停止生成|Stop generating)$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(发送消息|Send message)$/ })).toBeVisible({ timeout: 840_000 })

  await expect(page.getByText('OFFICECLI-SIDEBAR-PASS:' + MARKER, { exact: false }).last()).toBeVisible()

  await page.getByRole('button', { name: docxName, exact: true }).click()
  const docxViewer = page.getByLabel(docxName, { exact: true })
  await expect(docxViewer).toBeVisible()
  const docxZoom = page.getByRole('slider', { name: /^(缩放|Zoom)$/ })
  await expect(docxZoom).toBeVisible()
  await docxZoom.fill('125')
  await expect(docxZoom).toHaveValue('125')
  await expect(page.getByRole('button', { name: /^(适合宽度|Fit width)$/ })).toBeVisible()
  const refresh = page.getByRole('button', { name: /^(刷新|Refresh)$/ })
  await expect(refresh).toHaveCount(1)
  await refresh.click()
  await expect(docxViewer).toBeVisible()
  expect(Number(await docxZoom.inputValue())).toBeGreaterThan(25)
  await expect(page.getByText(/^(下载查看|Download to view)$/)).toHaveCount(0)

  await page.getByRole('button', { name: xlsxName, exact: true }).click()
  const xlsxViewer = page.getByLabel(xlsxName, { exact: true })
  await expect(xlsxViewer).toBeVisible()
  await expect(xlsxViewer.getByText('汇总', { exact: true })).toBeVisible()
  await xlsxViewer.getByText('明细', { exact: true }).click()
  await expect(xlsxViewer.getByText('明细', { exact: true })).toBeVisible()
  await expect(page.getByText(/^(下载查看|Download to view)$/)).toHaveCount(0)
  expect(problems).toEqual([])

  await page.getByRole('button', { name: pptxName, exact: true }).click()
  const pptxViewer = page.getByLabel(pptxName, { exact: true })
  await expect(pptxViewer).toBeVisible()
  await pptxViewer.getByRole('button', { name: /^(缩略图|Thumbnails)$/ }).click()
  await expect(pptxViewer.getByRole('button', { name: /^(幻灯片|Slide) 1$/ })).toBeVisible()
  await pptxViewer.getByRole('button', { name: /^(搜索|Search)$/ }).click()
  const search = pptxViewer.getByRole('textbox', { name: /^(搜索|Search)$/ })
  await search.fill('侧栏搜索定位目标')
  await search.press('Enter')
  await expect(pptxViewer.getByText('1 / 1', { exact: true })).toBeVisible()
  await pptxViewer.getByRole('button', { name: /^(下一页|Next)$/ }).click()
  await expect(pptxViewer.getByText('3 / 3', { exact: true })).toBeVisible()
  await expect(page.getByText(/^(下载查看|Download to view)$/)).toHaveCount(0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('OFFICECLI-SIDEBAR-PASS:' + MARKER, { exact: false }).last()).toBeVisible()
  // Univer logs this only when Better Sidebar preserves the inactive XLSX tab
  // at zero width. The active-XLSX checkpoint above must remain fully clean.
  const actionableProblems = problems.filter(problem => (
    !problem.includes('console error: The column width is less than 0, need to adjust page width to make it great than 0')
  ))
  expect(actionableProblems).toEqual([])
})
