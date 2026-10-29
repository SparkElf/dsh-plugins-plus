import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'
const s = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
await context.addCookies([s.cookie])
const page = await context.newPage()
await page.goto(s.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(10000)
const cls = await page.evaluate(() => [...document.querySelectorAll('[class*="sessionRow"]')].map(r => ({ cls: r.className, text: (r.textContent || '').slice(0, 50) })))
console.log('ROWS', cls.length, JSON.stringify(cls.slice(0, 10), null, 1))
const el = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('*')].filter(el => (el.textContent ?? '').includes('董事会与经营班子会表决门槛'))
  const leaf = nodes.filter(el => el.children.length === 0)
  return leaf.slice(0, 6).map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 80), text: (el.textContent ?? '').slice(0, 50), parentCls: String(el.parentElement?.className).slice(0, 80) }))
})
console.log('LEAF', JSON.stringify(el, null, 1))
await browser.close()
