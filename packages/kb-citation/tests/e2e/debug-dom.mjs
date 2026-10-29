import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'
const s = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
await context.addCookies([s.cookie])
const page = await context.newPage()
await page.goto(s.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45000 })
await page.waitForTimeout(1200)
const expand = page.getByText(/展开其余 \d+ 个会话/).first()
if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) { await expand.click(); await page.waitForTimeout(2200) }
const rows = page.locator('[class*="sessionRow"]', { hasText: '董事会与经营班子会表决门槛差异' })
console.log('rows', await rows.count())
await rows.nth(0).click()
await page.waitForTimeout(4000)
const info = await page.evaluate(() => {
  const sel = {
    flowUser: '[data-chat-flow-kind="user"]',
    flowAssistantStep: '[data-chat-flow-kind="assistant-step"]',
    dataRoleUser: '[data-role="user"]',
    dataMessageRole: '[data-message-role="user"]',
    messageRole: '[class*="user"]',
  }
  const out = {}
  for (const [k, v] of Object.entries(sel)) out[k] = document.querySelectorAll(v).length
  const users = [...document.querySelectorAll('[data-chat-flow-kind="user"]')].map(el => (el.textContent ?? '').slice(0, 100))
  return { out, users, bodyStart: document.body.innerText.slice(0, 300) }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
