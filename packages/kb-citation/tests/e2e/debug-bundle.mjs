import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'
const s = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
await context.addCookies([s.cookie])
const page = await context.newPage()
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 300)) })
const seen = []
await page.route(/\/plugins\/\?\?/, async route => {
  const response = await route.fetch()
  const body = await response.text()
  const idAt = body.indexOf('id: "@sparkelf/dsh-kb-citation"')
  const idAt2 = body.indexOf('@sparkelf/dsh-kb-citation')
  const loads = (body.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length
  seen.push({ url: route.request().url().slice(0, 150), len: body.length, idAt, idAt2, loads })
  await route.fulfill({ response, body })
})
await page.goto(s.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(9000)
console.log(JSON.stringify(seen, null, 1))
await browser.close()
