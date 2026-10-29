/**
 * Verify the fail-closed path: when no chunk proves the cited line, the chip must read
 * 引用已失效 and the click must not open any document tab.
 *
 * The read endpoint is stubbed so line 137 contains text no real chunk carries.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = '/root/projects/kb-citation-evidence/citation-mismatch'
const CLIENT = resolve(import.meta.dirname, '../../lib/client.js')
const TITLE = '董事会与经营班子会表决门槛区别'

async function patchBundle(page) {
  const source = readFileSync(CLIENT, 'utf8')
  await page.route(/\/plugins\/\?\?/, async route => {
    const response = await route.fetch()
    const body = await response.text()
    const idAt = body.indexOf('id: "@sparkelf/dsh-kb-citation"')
    if (idAt === -1) return route.fulfill({ response, body })
    const start = body.lastIndexOf('window.__ModuleLoader__.load({', idAt)
    const next = body.indexOf('window.__ModuleLoader__.load({', idAt)
    await route.fulfill({ status: response.status(), headers: { ...response.headers(), 'content-type': 'application/javascript; charset=utf-8' }, body: body.slice(0, start) + source + '\n;\n' + body.slice(next === -1 ? body.length : next) })
  })
}

const session = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  await patchBundle(page)
  const lines = []
  for (let index = 1; index < 137; index += 1) lines.push(index % 2 === 1 ? '填充段落' + String(index) : '')
  lines.push('第九十九条 这段文字不属于任何真实分块。')
  await page.route('**/knowledge-base/api/read', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'text', content: lines.join('\n') }),
  }))
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1500)
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await page.getByText(/展开其余 \d+ 个会话/).first().click().catch(() => undefined)
    await page.waitForTimeout(2000)
  }
  const rows = page.locator('[class*="sessionRow"]', { hasText: TITLE })
  await rows.first().click()
  await page.waitForTimeout(5000)
  const chips = await page.evaluate(() => [...document.querySelectorAll('button,a,[role="button"]')]
    .filter(el => (el.textContent ?? '').trim() === '引用已失效'
      || (el.getAttribute('title') ?? '').includes('.docx.md:137')
      || el.hasAttribute('data-kb-citation-invalid'))
    .map(el => ({ text: (el.textContent ?? '').trim(), title: el.getAttribute('title'), dataset: { ...el.dataset } })))
  const invalid = chips.find(chip => chip.text === '引用已失效' && (chip.title ?? '').includes('低空公司经营班子会议事规则'))
  console.log('INVALID_CHIP', JSON.stringify(invalid ?? null))
  if (invalid === undefined) console.log('ALL_CHIPS', JSON.stringify(chips, null, 1))
  const tabsBefore = await page.evaluate(() => [...document.querySelectorAll('[class*="tabTitle"]')].map(tab => (tab.textContent ?? '').trim()))
  if (invalid === undefined) throw new Error('chip did not become 引用已失效')
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button,a,[role="button"]')].find(node => (node.textContent ?? '').trim() === '引用已失效' && (node.getAttribute('title') ?? '').includes('低空公司经营班子会议事规则'))
    if (el === undefined) throw new Error('invalid chip vanished')
    el.click()
  })
  await page.waitForTimeout(2500)
  const after = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[class*="tabTitle"]')].map(tab => (tab.textContent ?? '').trim()),
    pages: document.querySelectorAll('[data-pdf-page]').length,
    text: document.body.innerText.slice(0, 300),
  }))
  writeFileSync(resolve(HERE, 'invalid-report.json'), JSON.stringify({ chips, tabsBefore, after }, null, 1))
  console.log('TABS_BEFORE', JSON.stringify(tabsBefore))
  console.log('AFTER', JSON.stringify({ tabs: after.tabs, pages: after.pages }))
  await page.screenshot({ path: resolve(HERE, 'invalid-after-click.png') })
} finally {
  await browser.close()
}
