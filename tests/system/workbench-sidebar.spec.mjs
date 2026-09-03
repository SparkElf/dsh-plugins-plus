import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'
import { API_SECRET, SSH_SECRET, installWorkbenchRoutes, responseBody } from './support/workbench-fixtures.mjs'

const HARNESS_URL = process.env.DSH_WORKBENCH_SYSTEM_URL ?? process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3081'
const COMPOSER_NAME = /给智能体发消息|Message the agent|描述你想要构建的内容|Describe what you want to build/

async function dismissOnboarding(page) {
  const testingNotice = page.getByRole('dialog', { name: /^(内测声明|Internal Testing Notice)$/ })
  if (await testingNotice.isVisible()) {
    await testingNotice.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    await expect(testingNotice).toBeHidden()
  }
  const credentials = page.getByRole('dialog', { name: /^(添加一个 API Key 开始使用|Add an API Key to get started)$/ })
  if (await credentials.isVisible()) {
    await credentials.getByRole('button', { name: /^(稍后配置|Configure later|Set up later)$/ }).click()
    await expect(credentials).toBeHidden()
  }
}

async function startSession(page) {
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1_000)
  await dismissOnboarding(page)
  await page.getByRole('button', { name: /^(新建会话|New session)$/i }).first().click()
  const configureLater = page.getByRole('button', { name: /稍后配置|Configure later|Set up later/i }).first()
  try { await configureLater.click({ timeout: 5_000 }) } catch {}
  await expect(page.getByRole('textbox', { name: COMPOSER_NAME })).toBeVisible()
}

async function openWorkbench(page, title) {
  const panel = page.locator('[data-dsh-panel]:not([data-dsh-bottom-panel])')
  if (!(await panel.isVisible())) {
    await page.getByRole('button', { name: /展开侧边栏|Expand sidebar/i }).click()
  }
  await expect(panel).toBeVisible()

  const existing = panel.locator('[title="' + title + '"]')
  if (await existing.count()) {
    await existing.first().click()
  } else {
    await panel.getByRole('button', { name: /新建标签页|New tab/i }).click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
  return panel
}

async function expectComponentSizing(page, root, panel, layout) {
  if (layout === 'narrow' && !(await root.isVisible())) {
    await root.evaluate(element => {
      document.body.appendChild(element)
      Object.assign(element.style, { position: 'fixed', inset: '0', zIndex: '99999', display: 'flex', width: '100vw', height: '100vh' })
    })
  }
  await expect(root).toBeVisible()
  const metrics = await root.evaluate((element, mode) => {
    const aside = element.querySelector('aside')
    const main = element.querySelector('main')
    if (!(main instanceof HTMLElement)) throw new Error('Workbench main sizing element is missing')
    const rootBox = element.getBoundingClientRect()
    const asideBox = aside instanceof HTMLElement ? aside.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0 }
    const mainBox = main.getBoundingClientRect()
    return { mode, viewportWidth: window.innerWidth, root: { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: rootBox.height, right: rootBox.right, bottom: rootBox.bottom }, aside: { x: asideBox.x, y: asideBox.y, width: asideBox.width, height: asideBox.height, right: asideBox.right, bottom: asideBox.bottom }, main: { x: mainBox.x, y: mainBox.y, width: mainBox.width, height: mainBox.height, right: mainBox.right, bottom: mainBox.bottom }, horizontalOverflow: element.scrollWidth - element.clientWidth }
  }, layout)
  expect(metrics.root.width).toBeGreaterThan(300)
  expect(metrics.root.height).toBeGreaterThan(300)
  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1)
  if (layout === 'desktop') {
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(metrics.root.x).toBeGreaterThanOrEqual(panelBox.x - 1)
    expect(metrics.root.right).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
    expect(metrics.root.bottom).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1)
    const sideBySide = metrics.aside.right <= metrics.main.x + 1 && Math.abs(metrics.aside.y - metrics.main.y) <= 1
    const stacked = Math.abs(metrics.aside.x - metrics.main.x) <= 1 && metrics.main.y >= metrics.aside.bottom - 1
    const singleView = metrics.aside.width === 0 || metrics.main.width === 0
    expect(sideBySide || stacked || singleView).toBe(true)
  } else {
    expect(metrics.viewportWidth).toBeLessThanOrEqual(700)
    const sideBySide = metrics.aside.right <= metrics.main.x + 1 && Math.abs(metrics.aside.y - metrics.main.y) <= 1
    const stacked = Math.abs(metrics.aside.x - metrics.main.x) <= 1 && metrics.main.y >= metrics.aside.bottom - 1
    const singleView = metrics.aside.width === 0 || metrics.main.width === 0
    expect(sideBySide || stacked || singleView).toBe(true)
  }
}

test('SSH Better Sidebar inventory sanitizes handoff and drives xterm input and resize', async ({ page }) => {
  const problems = []
  observePage(page, 'SSH workbench', problems)
  const calls = await installWorkbenchRoutes(page)
  await startSession(page)
  const panel = await openWorkbench(page, 'SSH')
  const root = panel.locator('[data-dsh-ssh-manager]')

  await expect(root.getByRole('button', { name: /^Production edge 1$/ })).toBeVisible()
  await expect(root.getByRole('button', { name: /Edge gateway.*deploy@edge[.]internal[.]example:2222/ })).toBeVisible()
  await expect(root.getByRole('button', { name: /Development worker.*builder@worker[.]internal[.]example:22/ })).toBeVisible()
  await root.getByPlaceholder(/搜索主机|Search hosts/).fill('gateway')
  await expect(root.getByRole('button', { name: /Edge gateway/ })).toBeVisible()
  await expect(root.getByRole('button', { name: /Development worker/ })).toHaveCount(0)
  await root.getByPlaceholder(/搜索主机|Search hosts/).fill('')

  await root.getByRole('button', { name: /Edge gateway/ }).click()
  await expect(root.getByRole('region', { name: /主机概览|Host overview/ }).getByText('Edge gateway', { exact: true })).toBeVisible()
  await expectComponentSizing(page, root, panel, 'desktop')

  await root.getByTitle(/将主机发送到对话|Send host to conversation/).click()
  const composer = page.getByRole('textbox', { name: COMPOSER_NAME })
  await expect(composer).toContainText(/SSH 主机引用：|SSH host reference:/)
  const sshDraft = await composer.innerText()
  expect(sshDraft).toContain('edge.internal.example')
  expect(sshDraft).toContain('credentialConfigured')
  expect(sshDraft).not.toContain('credentialId')
  expect(sshDraft).not.toContain(SSH_SECRET)

  await root.getByRole('button', { name: /Edge gateway/ }).dblclick()
  const terminal = root.locator('[data-ssh-terminal="terminal-edge"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible()
  expect((await terminal.boundingBox())?.width ?? 0).toBeGreaterThan(300)
  await terminal.locator('textarea').focus()
  await page.keyboard.insertText('echo system-test')
  await page.keyboard.press('Enter')
  await expect.poll(() => calls.terminal.filter(message => message.type === 'input').map(message => message.data).join('')).toContain('echo system-test')
  await expect.poll(() => calls.terminal.some(message => message.type === 'resize' && message.cols > 0 && message.rows > 0)).toBe(true)
  const desktopResize = calls.terminal.filter(message => message.type === 'resize').at(-1)

  await page.setViewportSize({ width: 700, height: 900 })
  await expectComponentSizing(page, root, panel, 'narrow')
  await expect.poll(() => calls.terminal.filter(message => message.type === 'resize').some(message => message.cols !== desktopResize.cols || message.rows !== desktopResize.rows)).toBe(true)
  expect(calls.ssh.some(call => call.method === 'state')).toBe(true)
  expect(calls.ssh.some(call => call.method === 'terminals.open' && call.payload.hostId === 'host-edge')).toBe(true)
  expect(problems).toEqual([])
})

test('API Better Sidebar inventory sanitizes handoff and renders executed response', async ({ page }) => {
  const problems = []
  observePage(page, 'API workbench', problems)
  const calls = await installWorkbenchRoutes(page)
  await startSession(page)
  const panel = await openWorkbench(page, 'API')
  const root = panel.locator('[data-dsh-api-client]')

  await expect(root.getByRole('combobox', { name: /工作区|Workspace/ })).toContainText('Platform APIs')
  await root.getByRole('combobox', { name: /环境|Environment/ }).click()
  await expect(root.getByRole('listbox', { name: /环境|Environment/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(root.getByText('Users', { exact: true })).toBeVisible()
  const request = root.getByRole('button', { name: /GET.*Get profile.*api[.]example[.]test/ })
  await expect(request).toBeVisible()
  await request.click()
  await expect(root.getByRole('textbox', { name: /请求 URL|Request URL/ })).toHaveValue('https://api.example.test/users/{{userId}}')
  await expectComponentSizing(page, root, panel, 'desktop')

  await root.getByTitle(/发送到对话|Send to conversation/).click()
  const composer = page.getByRole('textbox', { name: COMPOSER_NAME })
  await expect(composer).toContainText(/API 请求引用：|API request reference:/)
  const apiDraft = await composer.innerText()
  expect(apiDraft).toContain('Platform APIs')
  expect(apiDraft).toMatch(/\[(redacted|已隐藏)\]/)
  expect(apiDraft).not.toContain('credentialId')
  expect(apiDraft).not.toContain(API_SECRET)

  await root.getByRole('button', { name: /^(发送|Send)$/ }).click()
  await expect(root.getByText(/200\s+OK/)).toBeVisible()
  await expect(root.locator('pre')).toContainText(responseBody())
  expect(calls.api.some(call => call.method === 'requests.save' && call.payload.request.id === 'request-profile')).toBe(true)
  expect(calls.api.some(call => call.method === 'requests.execute' && call.payload.requestId === 'request-profile')).toBe(true)

  await page.setViewportSize({ width: 700, height: 900 })
  await expectComponentSizing(page, root, panel, 'narrow')
  expect(problems).toEqual([])
})
