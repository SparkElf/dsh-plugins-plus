import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'
const TOKEN = process.env.KB_CITATION_TOKEN ?? 'kb://doc/51/chunk/e63b7f9eda2d86cb'
const s = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
await context.addCookies([s.cookie])
const page = await context.newPage()
await page.goto(s.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45000 })
await page.waitForTimeout(1300)
const expand = page.getByText(/展开其余 \d+ 个会话/).first()
if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) { await expand.click(); await page.waitForTimeout(2200) }
await page.locator('[class*="sessionRow"]', { hasText: '董事会与经营班子会表决门槛差异' }).nth(0).click()
await page.waitForFunction(t => document.querySelectorAll('button[data-kb-citation-token="' + t + '"]').length > 0, TOKEN, { timeout: 15000 })
await page.evaluate(t => document.querySelector('button[data-kb-citation-token="' + t + '"]').click(), TOKEN)
await page.waitForFunction(() => document.querySelectorAll('[data-pdf-page] span').length > 400, undefined, { timeout: 30000 })
const pages = await page.evaluate(() => [...document.querySelectorAll('[data-pdf-page]')].map(el => ({
  page: el.getAttribute('data-pdf-page'),
  spans: [...el.querySelectorAll('span')].map(sp => sp.textContent),
})))
for (const p of pages) {
  const text = p.spans.join('')
  console.log('=== PAGE', p.page, 'spans', p.spans.length, 'chars', text.length)
  console.log(text.slice(0, 1200))
}
await browser.close()
