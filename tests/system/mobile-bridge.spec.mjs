import { devices, expect, test } from 'playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

const HARNESS_URL = process.env.DSH_SYSTEM_URL ?? 'http://127.0.0.1:3081'
const RELAY_URL = 'https://www.tokensfree.eu.cc'

function observePage(page, label, problems) {
  const pending = new Set()
  page.on('request', request => { pending.add(request.url()) })
  page.on('requestfinished', request => { pending.delete(request.url()) })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(label + ' console ' + message.type() + ': ' + message.text())
  })
  page.on('pageerror', error => { problems.push(label + ' pageerror: ' + (error.stack ?? error.message)) })
  page.on('requestfailed', request => { pending.delete(request.url()); problems.push(label + ' requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText ?? 'failed')) })
  page.on('response', response => {
    if (response.status() >= 500) problems.push(label + ' HTTP ' + response.status() + ': ' + response.url())
  })
  return pending
}

async function decodeRenderedQr(qr) {
  const png = PNG.sync.read(await qr.screenshot())
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
  expect(decoded, 'Settings 中渲染的二维码应可由手机相机解码').not.toBeNull()
  return decoded.data
}

test('登录页显示 DeepSeek 品牌并保留语言与主题选择', async ({ browser }) => {
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

    await page.getByRole('button', { name: 'EN' }).click()
    await expect(page.getByRole('heading', { name: 'Mobile connection' })).toBeVisible()
    await expect(page.getByText('Scan the QR code shown on the desktop')).toBeVisible()
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

test('两台手机独立配对，桌面只下线目标设备并保留下一张配对票据', async ({ browser }) => {
  const problems = []
  const desktopContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const phoneAContext = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' })
  const phoneBContext = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' })
  const desktop = await desktopContext.newPage()
  const phoneA = await phoneAContext.newPage()
  const phoneB = await phoneBContext.newPage()
  observePage(desktop, 'desktop', problems)
  const pendingPhoneA = observePage(phoneA, 'phone A', problems)
  const pendingPhoneB = observePage(phoneB, 'phone B', problems)

  try {
    await desktop.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' })
    await desktop.getByRole('button', { name: /^(设置|Settings)$/ }).click()
    await desktop.getByRole('button', { name: /^(移动连接|Mobile Bridge)$/ }).click()
    await desktop.getByRole('heading', { name: /^(移动连接|Mobile Bridge)$/ }).waitFor()
    await expect(desktop.getByLabel(/服务器地址|Server URL/)).toHaveValue(RELAY_URL)
    await expect(desktop.getByLabel(/本地端口|Local port/)).toHaveValue('3081')

    const offlineButtons = desktop.getByRole('button', { name: /^(下线|Take offline)$/ })
    while (await offlineButtons.count() > 0) {
      const previousCount = await offlineButtons.count()
      await offlineButtons.first().click()
      const cleanupDialog = desktop.getByRole('dialog', { name: /让设备下线|Take device offline/ })
      await expect(cleanupDialog).toBeVisible()
      await cleanupDialog.getByRole('button', { name: /^(确认下线|Take offline)$/ }).click()
      await expect(offlineButtons).toHaveCount(previousCount - 1)
    }

    const qr = desktop.getByRole('img', { name: /移动连接配对二维码|Mobile Bridge pairing QR code/ })
    const pairingCode = desktop.locator('output[aria-label="配对码"], output[aria-label="Pairing code"]')
    await expect(qr).toBeVisible()
    await expect(pairingCode).toHaveText(/^[0-9A-F]{6}$/)
    const firstCode = await pairingCode.innerText()
    const firstQrSource = await qr.evaluate(image => image.currentSrc)
    const phoneAUrl = await decodeRenderedQr(qr)
    expect(new URL(phoneAUrl).origin).toBe(RELAY_URL)

    await phoneA.goto(phoneAUrl, { waitUntil: 'domcontentloaded' })
    await expect(phoneA.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })

    await expect(offlineButtons).toHaveCount(1)
    await expect(pairingCode).not.toHaveText(firstCode)
    await expect(qr).not.toHaveAttribute('src', firstQrSource)
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

    await phoneA.reload({ waitUntil: 'domcontentloaded' })
    await expect(phoneA.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })

    await androidRow.getByRole('button', { name: /^(下线|Take offline)$/ }).click()
    const dialog = desktop.getByRole('dialog', { name: /让设备下线|Take device offline/ })
    await expect(dialog).toContainText(/重新扫码|scan again/)
    await dialog.getByRole('button', { name: /^(确认下线|Take offline)$/ }).click()
    await expect(androidRow).toHaveCount(0)
    await expect(iphoneRow).toBeVisible()
    await expect(offlineButtons).toHaveCount(1)

    await expect(phoneA.getByRole('heading', { name: /此设备已下线|This device is offline/ })).toBeVisible({ timeout: 30_000 })
    await expect(phoneA.getByRole('link', { name: /返回配对|Pair again/ })).toBeVisible()

    await phoneB.reload({ waitUntil: 'domcontentloaded' })
    await expect(phoneB.getByRole('button', { name: /Open sidebar|打开侧边栏|展开侧栏/ })).toBeVisible({ timeout: 30_000 })
    await expect(qr).toBeVisible()
    await expect(pairingCode).toHaveText(/^[0-9A-F]{6}$/)

    await desktop.screenshot({ path: '/tmp/mobile-bridge-two-devices-revoked-a.png', fullPage: true })
    expect(problems).toEqual([])
  } catch (error) {
    console.error(JSON.stringify({ problems, pendingPhoneA: [...pendingPhoneA], pendingPhoneB: [...pendingPhoneB] }, null, 2))
    throw error
  } finally {
    await Promise.all([desktopContext.close(), phoneAContext.close(), phoneBContext.close()])
  }
})
