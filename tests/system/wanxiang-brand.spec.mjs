import { expect, test } from 'playwright/test'

const URL = process.env.DSH_WORKBENCH_SYSTEM_URL ?? 'http://127.0.0.1:3081/'
const BRAND_KEY = 'dsh.dataops.wanxiangBrand'

async function dismissOnboarding(page) {
  const continueButton = page.getByRole('button', { name: /^(继续|Continue)$/ })
  const configureLater = page.getByRole('button', { name: /^(稍后配置|Configure later|Set up later)$/ }).first()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await continueButton.isVisible()) await continueButton.click({ force: true })
    if (await configureLater.isVisible()) await configureLater.click({ force: true })
    await page.waitForTimeout(200)
  }
}

async function openBrandSetting(page) {
  await page.getByRole('button', { name: /设置|Settings/ }).click()
  await page.getByRole('button', { name: 'DataOps', exact: true }).click()
  return page.getByRole('switch', { name: /应用万相品牌|Apply Wanxiang branding/ })
}

test('DataOps workspace applies and persists the Wanxiang shell identity', async ({ page }) => {
  const problems = []
  page.on('pageerror', error => problems.push(error.message))
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
  await page.route('**/integrations/dataops/managed-auth', route => route.fulfill({ status: 200, json: {} }))
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('wanxiang-test-initialized') === null) {
      localStorage.removeItem(key)
      sessionStorage.setItem('wanxiang-test-initialized', 'true')
    }
  }, BRAND_KEY)

  await page.goto(URL, { waitUntil: 'networkidle' })
  await dismissOnboarding(page)

  const heroName = page.getByRole('img', { name: '万相数据平台' })
  await expect(heroName).toBeVisible()
  await dismissOnboarding(page)
  await expect(page.locator('html')).toHaveAttribute('data-dataops-brand', 'wanxiang')
  await expect(page.locator('link#dataops-wanxiang-favicon')).toHaveCount(1)
  await expect(page.getByText(/^(预览版|Preview)$/)).toHaveCount(0)
  await expect.poll(() => page.title()).toBe('万相数据平台 Harness')

  const heroMark = page.locator('svg[viewBox="0 0 54 58"][width="34"]')
  await expect(heroMark).toHaveCSS('cursor', 'pointer')
  const unit = heroMark.locator('g > g').first()
  expect(await unit.evaluate(element => getComputedStyle(element).transform)).toBe('none')
  try {
    await heroMark.hover({ timeout: 2_500 })
  } catch {
    await dismissOnboarding(page)
    await heroMark.hover()
  }
  await expect.poll(() => unit.evaluate(element => getComputedStyle(element).transform)).not.toBe('none')

  const toggle = await openBrandSetting(page)
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('html')).not.toHaveAttribute('data-dataops-brand', 'wanxiang')
  await expect(page.getByRole('img', { name: '万相数据平台' })).toHaveCount(0)
  await expect(page.getByText(/^(预览版|Preview)$/)).toHaveCount(1)

  await page.reload({ waitUntil: 'networkidle' })
  await dismissOnboarding(page)
  await expect(page.locator('html')).not.toHaveAttribute('data-dataops-brand', 'wanxiang')
  await expect(page.getByRole('img', { name: '万相数据平台' })).toHaveCount(0)
  await expect(page.getByText(/^(预览版|Preview)$/)).toHaveCount(1)

  const restoredToggle = await openBrandSetting(page)
  await expect(restoredToggle).toHaveAttribute('aria-checked', 'false')
  await restoredToggle.click()
  await expect(restoredToggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-dataops-brand', 'wanxiang')
  await expect(page.getByRole('img', { name: '万相数据平台' })).toBeVisible()
  await expect(page.getByText(/^(预览版|Preview)$/)).toHaveCount(0)
  expect(problems).toEqual([])
})
