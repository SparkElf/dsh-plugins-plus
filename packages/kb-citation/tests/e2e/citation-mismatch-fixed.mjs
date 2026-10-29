/**
 * Verify the line→chunk fix on the real admin workbench without installing the tarball.
 *
 * Hot-swaps `lib/client.js` into the served plugin bundle, opens the reported session, and
 * clicks the 经营班子会议事规则 chip. Expected: label `:第7块`, token
 * `kb://doc/49/chunk/1fe09e0dbfb4184d`, blue box on the page that renders 第十五条.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = '/root/projects/kb-citation-evidence/citation-mismatch'
const CLIENT = resolve(import.meta.dirname, '../../lib/client.js')
const TITLE = '董事会与经营班子会表决门槛区别'
const TOKEN = 'kb://doc/49/chunk/1fe09e0dbfb4184d'
mkdirSync(HERE, { recursive: true })

async function patchBundle(page) {
  const source = readFileSync(CLIENT, 'utf8')
  await page.route(/\/plugins\/\?\?/, async route => {
    const response = await route.fetch()
    const body = await response.text()
    const idAt = body.indexOf('id: "@sparkelf/dsh-kb-citation"')
    if (idAt === -1) return route.fulfill({ response, body })
    const start = body.lastIndexOf('window.__ModuleLoader__.load({', idAt)
    const next = body.indexOf('window.__ModuleLoader__.load({', idAt)
    await route.fulfill({
      status: response.status(),
      headers: { ...response.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      body: body.slice(0, start) + source + '\n;\n' + body.slice(next === -1 ? body.length : next),
    })
  })
}

const session = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const calls = []
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.on('pageerror', error => console.log('PAGEERROR', error.message.slice(0, 300)))
  page.on('request', request => {
    if (!request.url().includes('/knowledge-base/api/')) return
    calls.push({ phase: 'request', url: request.url().split('/knowledge-base/api/')[1], body: request.postData() })
  })
  page.on('response', async response => {
    if (!response.url().includes('/knowledge-base/api/')) return
    let body
    try { body = await response.text() } catch {}
    calls.push({ phase: 'response', url: response.url().split('/knowledge-base/api/')[1], status: response.status(), body: body?.slice(0, 1600) })
  })
  await patchBundle(page)
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1500)
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await page.getByText(/展开其余 \d+ 个会话/).first().click().catch(() => undefined)
    await page.waitForTimeout(2000)
  }
  const rows = page.locator('[class*="sessionRow"]', { hasText: TITLE })
  let opened = false
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click()
    await page.waitForTimeout(3500)
    const found = await page.evaluate(token => document.querySelector('button[data-kb-citation-token="' + token + '"]') !== null, TOKEN)
    console.log('ROW', index, 'chip-with-correct-token', found)
    if (found) { opened = true; break }
  }
  if (!opened) throw new Error('chip never received the verified chunk token')

  const chips = await page.evaluate(() => [...document.querySelectorAll('button,a,[role="button"]')]
    .filter(el => (el.textContent ?? '').includes('经营班子会议事规则'))
    .map(el => ({ tag: el.tagName, cls: el.className, text: (el.textContent ?? '').trim(), title: el.getAttribute('title'), dataset: { ...el.dataset } })))
  console.log('CHIPS', JSON.stringify(chips, null, 1))

  const target = chips.find(chip => chip.dataset.kbCitationToken === 'kb://doc/49/chunk/1fe09e0dbfb4184d')
  await page.evaluate(text => {
    const el = [...document.querySelectorAll('button,a,[role="button"]')].find(node => (node.textContent ?? '').trim() === text)
    if (el === undefined) throw new Error('click target vanished')
    el.click()
  }, target.text)
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-pdf-page]')].some(p => p.querySelectorAll('span').length > 0)
      && !/文档渲染中|正在渲染/.test(document.body.innerText),
    undefined, { timeout: 120_000, polling: 250 },
  ).catch(() => undefined)
  await page.waitForTimeout(6000)

  const report = await page.evaluate(() => {
    const rectOf = element => { const r = element.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
    return {
      url: location.href,
      pages: [...document.querySelectorAll('[data-pdf-page]')].map(p => ({
        page: p.dataset.pdfPage,
        boxes: p.querySelectorAll('.kb-citation-box').length,
        hits: p.querySelectorAll('.kb-citation-hit').length,
        text: (p.innerText ?? '').replace(/\s+/g, ' ').slice(0, 420),
      })).filter(p => p.boxes > 0 || p.hits > 0),
      boxes: [...document.querySelectorAll('.kb-citation-box')].map(b => ({ rect: rectOf(b), page: b.closest('[data-pdf-page]')?.dataset.pdfPage ?? null })),
      hits: document.querySelectorAll('.kb-citation-hit').length,
      tabs: [...document.querySelectorAll('[class*="tabTitle"],[role="tab"]')].map(t => (t.textContent ?? '').trim()).filter(Boolean),
    }
  })
  writeFileSync(resolve(HERE, 'fixed-report.json'), JSON.stringify({ chips, report, calls }, null, 1))
  console.log('REPORT', JSON.stringify(report, null, 1).slice(0, 5000))
  console.log('RESOLVE_CALLS', JSON.stringify(calls.filter(c => c.phase === 'request' && (c.url === 'resolve' || c.url === 'read')), null, 1))
  console.log('CHUNK_CALLS', JSON.stringify(calls.filter(c => c.phase === 'request' && c.url === 'chunk'), null, 1))
  await page.screenshot({ path: resolve(HERE, 'fixed-after-click.png') })
} finally {
  await browser.close()
}
