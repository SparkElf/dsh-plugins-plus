/** Reproduce the label/bbox chunk mismatch on the real admin workbench. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from '/root/projects/dsh-plugins-plus/packages/kb-citation/tests/e2e/lib/admin-session.mjs'

const HERE = process.env.KB_CITATION_ARTIFACTS ?? '/root/projects/kb-citation-evidence/citation-mismatch'
const TITLE = process.env.SESSION_TITLE ?? '董事会与经营班子会表决门槛区别'
mkdirSync(HERE, { recursive: true })

const session = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const calls = []
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.on('request', request => {
    if (!request.url().includes('/knowledge-base/api/')) return
    calls.push({ phase: 'request', url: request.url().split('/knowledge-base/api/')[1], method: request.method(), body: request.postData() })
  })
  page.on('response', async response => {
    if (!response.url().includes('/knowledge-base/api/')) return
    let body
    try { body = await response.text() } catch {}
    calls.push({ phase: 'response', url: response.url().split('/knowledge-base/api/')[1], status: response.status(), body: body?.slice(0, 2500) })
  })
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1500)
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await page.getByText(/展开其余 \d+ 个会话/).first().click().catch(() => undefined)
    await page.waitForTimeout(2000)
  }
  const rows = page.locator('[class*="sessionRow"]', { hasText: TITLE })
  console.log('ROWS', await rows.count())
  let opened = false
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click()
    await page.waitForTimeout(2500)
    const found = await page.evaluate(() => [...document.querySelectorAll('button,a,[role="button"]')]
      .some(el => (el.textContent ?? '').includes('经营班子会议事规则') && (el.textContent ?? '').includes('第')))
    if (found) { opened = true; console.log('OPENED row', index, 'url', page.url()); break }
  }
  if (!opened) {
    await page.screenshot({ path: resolve(HERE, 'no-chip.png') })
    throw new Error('chip not found in any matching session row')
  }
  const chips = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button,a,[role="button"],[data-kb-citation-token]')) {
      const text = (el.textContent ?? '').trim()
      if (!text.includes('经营班子会议事规则')) continue
      out.push({
        tag: el.tagName, cls: el.className, text,
        title: el.getAttribute('title'), href: el.getAttribute('href'),
        ariaLabel: el.getAttribute('aria-label'),
        dataset: { ...el.dataset },
      })
    }
    return out
  })
  console.log('CHIPS', JSON.stringify(chips, null, 1))
  // Click the chip carrying the 第N块 suffix.
  const target = chips.find(chip => /第\d+块/.test(chip.text)) ?? chips[0]
  console.log('TARGET', JSON.stringify(target))
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
    const rectOf = element => {
      const r = element.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
    }
    const pages = [...document.querySelectorAll('[data-pdf-page]')].map(pageEl => ({
      page: pageEl.dataset.pdfPage,
      boxCount: pageEl.querySelectorAll('.kb-citation-box').length,
      hitCount: pageEl.querySelectorAll('.kb-citation-hit').length,
      text: (pageEl.innerText ?? '').replace(/\s+/g, ' ').slice(0, 500),
    }))
    const boxes = [...document.querySelectorAll('.kb-citation-box')].map(box => ({ rect: rectOf(box), page: box.closest('[data-pdf-page]')?.dataset.pdfPage ?? null }))
    const hits = [...document.querySelectorAll('.kb-citation-hit')].map(hit => ({ rect: rectOf(hit), page: hit.closest('[data-pdf-page]')?.dataset.pdfPage ?? null }))
    const tabs = [...document.querySelectorAll('[class*="tabTitle"],[role="tab"]')].map(tab => ({ text: (tab.textContent ?? '').trim(), cls: tab.className }))
    return { url: location.href, tabs, pages: pages.filter(p => p.boxCount > 0 || p.hitCount > 0), boxes, hits, body: document.body.innerText.slice(0, 1200) }
  })
  writeFileSync(resolve(HERE, 'browser-report.json'), JSON.stringify({ chips, report, calls }, null, 1))
  console.log('REPORT', JSON.stringify(report, null, 1).slice(0, 6000))
  console.log('CALLS', JSON.stringify(calls, null, 1).slice(0, 6000))
  await page.screenshot({ path: resolve(HERE, 'after-click.png') })
} finally {
  await browser.close()
}
