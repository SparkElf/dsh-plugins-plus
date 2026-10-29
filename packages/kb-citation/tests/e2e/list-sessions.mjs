import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'
const s = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
await context.addCookies([s.cookie])
const page = await context.newPage()
await page.goto(s.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(4000)
const btn = page.locator('text=/展开其余/').first()
console.log('expand count', await page.locator('text=/展开其余/').count(), 'text', await btn.textContent().catch(() => null))
if (await btn.count()) { await btn.click(); await page.waitForTimeout(2500) }
console.log('BODY', (await page.evaluate(() => document.body.innerText)).slice(0, 4000))
const classes = await page.evaluate(() => {
  const interesting = [...document.querySelectorAll('a,button,div,li')].filter(el => (el.textContent ?? '').includes('董事会与经营班子会表决门槛'))
  return interesting.slice(-12).map(el => ({ tag: el.tagName, cls: el.className, text: (el.textContent ?? '').slice(0, 60) }))
})
console.log('INTERESTING', JSON.stringify(classes, null, 1))
await page.screenshot({ path: '/root/projects/kb-citation-evidence/20261025-amber/session-list.png' })
await browser.close()
