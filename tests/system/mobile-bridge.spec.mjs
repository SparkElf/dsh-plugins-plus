import { devices, expect, test } from 'playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

const HARNESS_URL = process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3081'
const RELAY_URL = 'https://www.tokensfree.eu.cc'
const LOCAL_PORT = process.env.DSH_LOCAL_PORT ?? '3081'

// 启动 join 必须至少真实发生一次，不能把请求尚未开始时的空 pending 集合误判为已就绪。
async function settleSettingsJoins(page, requests, afterCount = 0) {
  const render = () => new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
  await expect.poll(() => requests.settingsJoinCount).toBeGreaterThan(afterCount)
  await expect.poll(() => [...requests.pending].some(request => /\/api\/(?:settings|credentials|llm)\./.test(new URL(request.url()).pathname))).toBe(false)
  await page.evaluate(render)
}

// 无 Provider 的候选环境只经可见 UI 选择稍后配置，保持真实 Provider e2e 的显式 waived 状态。
async function deferProviderOnboarding(page, requests) {
  await settleSettingsJoins(page, requests)
  const welcome = page.getByRole('dialog', { name: /^(内测声明|Internal Testing Notice)$/ })
  if (await welcome.isVisible()) {
    const previousJoinCount = requests.settingsJoinCount
    await welcome.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    await expect(welcome).toBeHidden()
    await settleSettingsJoins(page, requests, previousJoinCount)
  }
  const credentialOnboarding = page.getByRole('dialog', { name: /^(添加一个 API Key 开始使用|Add an API Key to get started)$/ })
  if (await credentialOnboarding.isVisible()) {
    await credentialOnboarding.getByRole('button', { name: /^(稍后配置|Configure later|Set up later)$/ }).click()
    await expect(credentialOnboarding).toBeHidden()
  }
}

function observePage(page, label, problems) {
  const requests = { pending: new Set(), settingsJoinCount: 0 }
  page.on('request', request => {
    requests.pending.add(request)
    if (/\/api\/(?:settings|credentials|llm)\./.test(new URL(request.url()).pathname)) requests.settingsJoinCount += 1
  })
  page.on('requestfinished', request => { requests.pending.delete(request) })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location()
      const source = location.url === '' ? '' : ' at ' + location.url + ':' + location.lineNumber + ':' + location.columnNumber
      problems.push(label + ' console ' + message.type() + ': ' + message.text() + source)
    }
  })
  page.on('pageerror', error => { problems.push(label + ' pageerror: ' + (error.stack ?? error.message)) })
  page.on('requestfailed', request => { requests.pending.delete(request); problems.push(label + ' requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText ?? 'failed')) })
  page.on('response', response => {
    if (response.status() >= 500) problems.push(label + ' HTTP ' + response.status() + ': ' + response.url())
  })
  return requests
}

async function decodeRenderedQr(qr) {
  let value = null
  await expect.poll(async () => {
    const ready = await qr.evaluate(image => image.complete && image.naturalWidth > 0)
    if (!ready) return false
    const png = PNG.sync.read(await qr.screenshot({ path: '/tmp/mobile-bridge-qr-current.png' }))
    value = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null
    return value !== null
  }, { message: 'Settings 中渲染的二维码应可由手机相机解码' }).toBe(true)
  return value
}

test('登录页显示品牌与相机入口并保留显示偏好', async ({ browser }) => {
  const problems = []
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' })
  const page = await context.newPage()
  observePage(page, 'phone preferences', problems)
  try {
    await page.goto(RELAY_URL + '/bridge/', { waitUntil: 'domcontentloaded' })
    const logo = page.getByRole('img', { name: 'DeepSeek' })
    await expect(logo).toBeVisible()
    expect(await logo.evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
    await expect(page.getByRole('heading', { name: '移动连接' })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开相机扫码' })).toBeVisible()
    await page.screenshot({ path: '/tmp/mobile-bridge-login-dark-camera.png', fullPage: true })

    await page.getByRole('button', { name: 'EN' }).click()
    await expect(page.getByRole('heading', { name: 'Mobile connection' })).toBeVisible()
    await expect(page.getByText('Scan the pairing QR shown on the desktop')).toBeVisible()
    await page.getByRole('button', { name: 'Light' }).click()
    await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Mobile connection' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: '/tmp/mobile-bridge-login-light-en.png', fullPage: true })
    expect(problems).toEqual([])
  } finally {
    await context.close()
  }
})

test('手机关闭页面后恢复登录，双设备独立配对并定向下线', async ({ browser }) => {
  const problems = []
  const desktopContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const phoneAContext = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' })
  const phoneBContext = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' })
  const desktop = await desktopContext.newPage()
  let phoneA = await phoneAContext.newPage()
  const phoneB = await phoneBContext.newPage()
  const pendingDesktop = observePage(desktop, 'desktop', problems)
  let pendingPhoneA = observePage(phoneA, 'phone A', problems)
  const pendingPhoneB = observePage(phoneB, 'phone B', problems)

  try {
    await desktop.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
    await deferProviderOnboarding(desktop, pendingDesktop)
    await desktop.getByRole('button', { name: /^(设置|Settings)$/ }).click()
    await desktop.getByRole('button', { name: /^(移动连接|Mobile Bridge)$/ }).click()
    await desktop.getByRole('heading', { name: /^(移动连接|Mobile Bridge)$/ }).waitFor()
    await expect(desktop.getByLabel(/服务器地址|Server URL/)).toHaveValue(RELAY_URL)
    await expect(desktop.getByLabel(/本地端口|Local port/)).toHaveValue(LOCAL_PORT)
    await expect(desktop.getByLabel(/移动端登录保持天数|Mobile sign-in duration/)).toHaveValue('7')
    await expect(desktop.getByLabel(/启动自动连接|Connect on startup/)).toBeChecked()
    await expect(desktop.getByLabel(/断线自动重连|Reconnect after disconnection/)).toBeChecked()
    const connectionButton = desktop.getByRole('button', { name: /^(主动连接|断开连接|Connect|Disconnect)$/ })
    await expect(connectionButton).toBeVisible()

    const serverUrl = desktop.getByLabel(/服务器地址|Server URL/)
    const autoReconnect = desktop.getByLabel(/断线自动重连|Reconnect after disconnection/)
    await expect(desktop.getByRole('button', { name: /^(保存配置|Save)$/ })).toHaveCount(0)
    await serverUrl.fill(RELAY_URL + '/bridge')
    await desktop.getByLabel(/本地端口|Local port/).focus()
    await expect(serverUrl).toHaveValue(RELAY_URL)
    await expect(desktop.getByRole('status').filter({ hasText: /已自动保存|Saved automatically/ })).toBeVisible({ timeout: 3_000 })

    await autoReconnect.uncheck()
    await expect(autoReconnect).not.toBeChecked()
    await expect(desktop.getByRole('status').filter({ hasText: /已自动保存|Saved automatically/ })).toBeVisible({ timeout: 3_000 })
    await autoReconnect.check()
    await expect(autoReconnect).toBeChecked()
    await expect(desktop.getByRole('status').filter({ hasText: /已自动保存|Saved automatically/ })).toBeVisible({ timeout: 3_000 })

    await expect(connectionButton).toHaveText(/^(断开连接|Disconnect)$/, { timeout: 30_000 })
    const qr = desktop.getByRole('img', { name: /移动连接配对二维码|Mobile Bridge pairing QR code/ })
    const pairingCode = desktop.locator('output[aria-label="配对码"], output[aria-label="Pairing code"]')
    await expect(qr).toBeVisible()
    const qrBeforeConnectionAction = await qr.getAttribute('src')
    await connectionButton.click()
    await expect(desktop.getByRole('status').filter({ hasText: /未连接|Not connected/ })).toBeVisible()
    await expect(connectionButton).toHaveText(/^(主动连接|Connect)$/)
    await connectionButton.click()
    await expect(desktop.getByRole('status').filter({ hasText: /已连接|Connected/ })).toBeVisible({ timeout: 30_000 })
    if (qrBeforeConnectionAction !== null) await expect(qr).not.toHaveAttribute('src', qrBeforeConnectionAction, { timeout: 30_000 })

    const offlineButtons = desktop.getByRole('button', { name: /^(下线|Take offline)$/ })
    while (await offlineButtons.count() > 0) {
      const previousCount = await offlineButtons.count()
      await offlineButtons.first().click()
      const cleanupDialog = desktop.getByRole('dialog', { name: /让设备下线|Take device offline/ })
      await expect(cleanupDialog).toBeVisible()
      await cleanupDialog.getByRole('button', { name: /^(确认下线|Take offline)$/ }).click()
      await expect(offlineButtons).toHaveCount(previousCount - 1)
    }

    await expect(qr).toBeVisible()
    await expect(pairingCode).toHaveText(/^[0-9A-F]{6}$/)
    const pairingTitle = desktop.getByText(/^(手机配对|Phone pairing)$/)
    const pairingCodeTitle = desktop.getByText(/^(配对码|Pairing code)$/)
    await expect(pairingTitle).toBeVisible()
    await expect(pairingCodeTitle).toBeVisible()
    const firstCode = await pairingCode.innerText()
    const firstQrSource = await qr.evaluate(image => image.currentSrc)
    const phoneAUrl = await decodeRenderedQr(qr)
    expect(new URL(phoneAUrl).origin).toBe(RELAY_URL)
    const phoneASidebar = phoneA.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })
    await phoneA.goto(phoneAUrl, { waitUntil: 'domcontentloaded' })
    await expect(phoneASidebar).toBeVisible({ timeout: 30_000 })
    await Promise.all([
      expect(pairingCode).not.toHaveText(firstCode),
      expect(qr).not.toHaveAttribute('src', firstQrSource),
    ])
    const openMainSidebar = phoneA.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ }).first()
    const collapseMainSidebar = phoneA.getByRole('button', { name: /^(收起侧边栏|Collapse sidebar)$/ }).first()
    const phoneSettings = phoneA.getByRole('dialog', { name: /^(设置|Settings)$/ })
    await deferProviderOnboarding(phoneA, pendingPhoneA)

    if (await openMainSidebar.isVisible()) await openMainSidebar.click()
    await expect(collapseMainSidebar).toBeVisible()
    await phoneA.getByRole('button', { name: /^(新建会话|New session)$/ }).first().click()
    await collapseMainSidebar.click()
    await expect(openMainSidebar).toBeVisible()
    const heroTitle = phoneA.getByText(/^(探索未至之境|Into the Unknown)$/)
    const heroBadge = phoneA.getByText(/^(预览版|Preview)$/)
    await expect(heroTitle).toBeVisible()
    await expect(heroBadge).toBeVisible()
    await phoneA.screenshot({ path: '/tmp/mobile-new-session-hero.png', fullPage: true })
    await openMainSidebar.click()
    await expect(collapseMainSidebar).toBeVisible()
    const unavailableSidebar = phoneA.getByRole('button', { name: /^(选择一个会话以使用侧边栏|Select a (?:session|conversation) to use the sidebar)$/ })
    if (await unavailableSidebar.isVisible()) {
      await unavailableSidebar.tap({ force: true })
      await expect(phoneA.getByRole('tooltip')).toHaveText(/^(选择一个会话以使用侧边栏|Select a (?:session|conversation) to use the sidebar)$/)
    }

    const sessionGoal = '移动连接系统验收'
    await collapseMainSidebar.click()
    await expect(openMainSidebar).toBeVisible()
    const phoneComposer = phoneA.locator('textarea').first()
    await phoneComposer.fill('/goal ' + sessionGoal)
    await phoneComposer.press('Enter')
    await expect(phoneA.locator('[data-goal-bar]').filter({ hasText: sessionGoal })).toBeVisible({ timeout: 30_000 })
    await openMainSidebar.click()
    await expect(collapseMainSidebar).toBeVisible()
    await expect(phoneA.getByRole('treeitem', { selected: true })).toBeVisible()
    await expect(collapseMainSidebar).toBeVisible()
    await expect(phoneA.getByRole('button', { name: 'Session log' })).toBeVisible()

    if (!(await phoneSettings.isVisible())) {
      const settingsButton = phoneA.getByRole('button', { name: /^(设置|Settings)$/ })
      if (!(await settingsButton.isVisible())) await openMainSidebar.click()
      await settingsButton.click()
      await expect(phoneSettings).toBeVisible()
    }
    const generalNav = phoneSettings.getByRole('button', { name: /^(通用设置|General)$/ })
    if (!(await generalNav.isVisible())) {
      await phoneSettings.getByRole('button', { name: /^(设置|Settings)$/ }).click()
    }
    await expect(generalNav).toBeVisible()
    const presetLabel = phoneSettings.getByText(/^(Agent 预设|Agent preset)$/).nth(1)
    await expect(presetLabel).toBeHidden()
    await generalNav.click()
    await expect(presetLabel).toBeVisible()
    await phoneA.screenshot({ path: '/tmp/mobile-bridge-settings-mobile.png', fullPage: true })

    await phoneSettings.getByRole('button', { name: /^(设置|Settings)$/ }).click()
    await expect(generalNav).toBeVisible()
    await expect(presetLabel).toBeHidden()
    await phoneSettings.getByRole('button', { name: /^(关闭|Close)$/ }).click()

    await expect(collapseMainSidebar).toBeVisible()

    const sessionLogButton = phoneA.getByRole('button', { name: 'Session log' })
    const expandBetterSidebar = phoneA.getByRole('button', { name: /^(展开侧边栏|Expand sidebar)$/ })
    await expect(sessionLogButton).toBeVisible()
    await expect(expandBetterSidebar).toBeVisible()
    await phoneA.screenshot({ path: '/tmp/mobile-session-header-composer.png', fullPage: true })

    await phoneA.getByRole('button', { name: /^(添加工作区|Add workspace)$/ }).click()
    const directoryPicker = phoneA.getByRole('dialog', { name: /^(选择工作区目录|Select Workspace Directory)$/ })
    await expect(directoryPicker).toBeVisible()
    const newFolderButton = directoryPicker.getByRole('button', { name: /^(新建文件夹|New folder)$/ })
    await expect(newFolderButton).toBeEnabled({ timeout: 30_000 })
    await phoneA.screenshot({ path: '/tmp/mobile-bridge-directory-picker-mobile.png', fullPage: true })
    await directoryPicker.getByRole('button', { name: /^(编辑路径|Edit path)$/ }).click()
    const pathInput = directoryPicker.getByLabel(/^(编辑路径|Edit path)$/)
    await pathInput.fill('/root/projects')
    await pathInput.press('Enter')
    await expect(newFolderButton).toBeEnabled({ timeout: 30_000 })
    await directoryPicker.getByRole('button', { name: /^(打开|Open)$/ }).click()
    await expect(directoryPicker).toBeHidden()
    await expect(collapseMainSidebar).toBeVisible()
    await collapseMainSidebar.click()
    await expect(openMainSidebar).toBeVisible()

    await expect(expandBetterSidebar).toBeVisible({ timeout: 30_000 })
    await expandBetterSidebar.click()
    const newTabButton = phoneA.getByRole('button', { name: /^(新建标签页|New tab)$/ }).first()
    await expect(newTabButton).toBeVisible()
    const collapseBetterSidebar = phoneA.getByRole('button', { name: /^(折叠侧边栏|Collapse sidebar)$/ })
    await expect(collapseBetterSidebar).toBeVisible()
    await phoneA.screenshot({ path: '/tmp/better-sidebar-mobile.png', fullPage: true })
    await collapseBetterSidebar.click()

    const modelButton = phoneA.getByRole('button', { name: /^(选择模型|Select model)/ }).first()
    const primaryButton = phoneA.getByRole('button', { name: /^(发送消息|Send message|停止生成|Stop generating)$/ }).last()
    await expect(modelButton).toBeVisible()
    await expect(primaryButton).toBeVisible()
    await modelButton.tap()
    await expect(phoneA.getByRole('menu', { name: /^(模型与推理等级|Model and reasoning effort)$/ })).toBeVisible()
    await phoneA.keyboard.press('Escape')

    const commandButton = phoneA.getByRole('button', { name: /^(命令|Commands)$/ })
    await commandButton.focus()
    const commandTooltip = phoneA.getByRole('tooltip').filter({ hasText: /^(命令|Commands)$/ })
    await expect(commandTooltip).toBeVisible()
    await commandButton.tap()
    await expect(commandTooltip).toBeHidden()
    await phoneA.keyboard.press('Escape')

    await expect(offlineButtons).toHaveCount(1)
    const phoneBUrl = await decodeRenderedQr(qr)
    expect(new URL(phoneBUrl).origin).toBe(RELAY_URL)

    await phoneB.goto(phoneBUrl, { waitUntil: 'domcontentloaded' })
    await expect(phoneB.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })
    await expect(offlineButtons).toHaveCount(2)

    const androidRow = desktop.getByRole('listitem').filter({ hasText: /Android.*Chrome/ })
    const iphoneRow = desktop.getByRole('listitem').filter({ hasText: /iPhone.*Safari/ })
    await expect(androidRow).toContainText(/IP\s+\S+/)
    await expect(androidRow).toContainText(/首次配对|Paired/)
    await expect(androidRow).toContainText(/最近连接|Last connected/)
    await expect(androidRow).toContainText(/在线|Online/)
    await expect(iphoneRow).toContainText(/IP\s+\S+/)
    await expect(iphoneRow).toContainText(/在线|Online/)

    phoneA.removeAllListeners('requestfailed')
    await phoneA.close()
    phoneA = await phoneAContext.newPage()
    pendingPhoneA = observePage(phoneA, 'phone A reopened', problems)
    await phoneA.goto(RELAY_URL + '/bridge/', { waitUntil: 'domcontentloaded' })
    await expect(phoneA.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })

    await androidRow.getByRole('button', { name: /^(下线|Take offline)$/ }).click()
    const dialog = desktop.getByRole('dialog', { name: /让设备下线|Take device offline/ })
    await expect(dialog).toContainText(/重新扫码|scan again/)
    await dialog.getByRole('button', { name: /^(确认下线|Take offline)$/ }).click()
    await expect(androidRow).toHaveCount(0)
    await expect(iphoneRow).toBeVisible()
    await expect(offlineButtons).toHaveCount(1)

    const revokedDialog = phoneA.getByRole('dialog', { name: /此设备已下线|This device is offline/ })
    await expect(revokedDialog).toBeVisible({ timeout: 30_000 })
    await expect(revokedDialog).toContainText(/请重新扫描最新二维码|Scan the latest QR code/)
    await expect(revokedDialog.getByRole('button', { name: /重新扫码|Scan again/ }).last()).toBeVisible()

    await phoneB.reload({ waitUntil: 'domcontentloaded' })
    await expect(phoneB.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })
    await expect(qr).toBeVisible()
    await expect(pairingCode).toHaveText(/^[0-9A-F]{6}$/)

    await desktop.screenshot({ path: '/tmp/mobile-bridge-two-devices-revoked-a.png', fullPage: true })
    expect(problems).toEqual([])
  } catch (error) {
    console.error(JSON.stringify({ problems, pendingPhoneA: [...pendingPhoneA.pending].map(request => request.url()), pendingPhoneB: [...pendingPhoneB.pending].map(request => request.url()) }, null, 2))
    throw error
  } finally {
    await Promise.all([desktopContext.close(), phoneAContext.close(), phoneBContext.close()])
  }
})
