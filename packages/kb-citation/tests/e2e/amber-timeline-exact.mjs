/**
 * Exact click-relative timeline for the amber query-hit contract.
 *
 * Samples 0/1/2/3/5/10/15 s measured from the chip click (not from viewer readiness), then
 * writes one screenshot at the end. Diagnostic only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = process.env.KB_CITATION_CLIENT ?? resolve(HERE, '../../lib/client.js')
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts/exact')
const TOKEN = process.env.KB_CITATION_TOKEN ?? 'kb://doc/49/chunk/1fe09e0dbfb4184d'
const SESSION_TITLE = '董事会与经营班子会表决门槛差异'
const HOTSWAP = process.env.KB_CITATION_HOTSWAP !== '0'
mkdirSync(ARTIFACTS, { recursive: true })

async function patchBundle(page) {
  if (!HOTSWAP) return
  const source = readFileSync(CLIENT, 'utf8')
  console.log('PATCH CLIENT', CLIENT, source.length)
  await page.route(/\/plugins\/\?\?/, async route => {
    console.log('PATCH ROUTE', route.request().url().slice(0, 120))
    const response = await route.fetch()
    const body = await response.text()
    const idAt = body.indexOf('id: "@sparkelf/dsh-kb-citation"')
    console.log('PATCH IDAT', idAt)
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
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  await patchBundle(page)
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1500)
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await page.getByText(/展开其余 \d+ 个会话/).first().click().catch(() => undefined)
    await page.waitForTimeout(2500)
  }
  const rows = page.locator('[class*="sessionRow"]', { hasText: SESSION_TITLE })
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click()
    const found = await page.waitForFunction(
      token => document.querySelectorAll('button[data-kb-citation-token="' + token + '"]').length > 0,
      TOKEN, { timeout: 8000 },
    ).then(() => true).catch(() => false)
    if (found) break
  }
  await page.waitForTimeout(800)
  const chips = await page.evaluate(() => document.querySelectorAll('button[data-kb-citation-token]').length)
  console.log('CHIPS', chips)
  await page.evaluate(({ token }) => {
    const host = window
    host.__KB_CITATION_TIMING__ = true
    host.__amber = { t0: performance.now() }
    host.__amber.snapshot = () => {
      const hits = [...document.querySelectorAll('.kb-citation-hit')].map(hit => hit.getBoundingClientRect())
      const boxes = [...document.querySelectorAll('.kb-citation-box')].map(box => box.getBoundingClientRect())
      const scrollport = [...document.querySelectorAll('*')].find(el => /scrollport/.test(String(el.className)) && el.scrollHeight > el.clientHeight + 1)
      return {
        t: Math.round((performance.now() - host.__amber.t0) * 10) / 10,
        boxes: boxes.length,
        boxPage: boxes.length === 0 ? null : Number(document.querySelector('.kb-citation-box')?.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? 0),
        hits: hits.length,
        hitPages: [...document.querySelectorAll('.kb-citation-hit')].map(hit => Number(hit.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? 0)),
        hitVisible: hits.some(rect => rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.top < innerHeight),
        legend: document.querySelectorAll('.kb-citation-legend').length,
        pages: document.querySelectorAll('[data-pdf-page]').length,
        spans: document.querySelectorAll('[data-pdf-page] span').length,
        rendering: /文档渲染中|正在渲染/.test(document.body.innerText),
        scrollTop: scrollport?.scrollTop ?? null,
      }
    }
    document.querySelector('button[data-kb-citation-token="' + token + '"]').click()
  }, { token: TOKEN })

  const timeline = []
  for (const at of [0, 1000, 2000, 3000, 5000, 10000, 15000]) {
    await page.waitForFunction(ms => performance.now() - window.__amber.t0 >= ms - 5, at, { timeout: 60_000 }).catch(() => undefined)
    const sample = await page.evaluate(() => window.__amber.snapshot())
    timeline.push(sample)
    console.log('AT', at, 'actual', sample.t, 'boxes', sample.boxes, 'boxPage', sample.boxPage, 'hits', sample.hits, 'hitPages', JSON.stringify(sample.hitPages), 'visible', sample.hitVisible, 'legend', sample.legend, 'pages', sample.pages, 'spans', sample.spans, 'rendering', sample.rendering)
  }
  await page.screenshot({ path: resolve(ARTIFACTS, 'exact-15000ms.png') })
  await page.screenshot({ path: resolve(ARTIFACTS, 'exact-viewer.png'), clip: { x: 940, y: 40, width: 740, height: 1000 } })
  const debug = await page.evaluate(() => window.__kbCitationDebug ?? null)
  writeFileSync(resolve(ARTIFACTS, 'exact-timeline.json'), JSON.stringify({ hotswap: HOTSWAP, chips, timeline, hitDump: await page.evaluate(() => [...document.querySelectorAll('.kb-citation-hit')].map(hit => { const r = hit.getBoundingClientRect(); return { page: hit.closest('[data-pdf-page]')?.getAttribute('data-pdf-page'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })), debug }, null, 1))
  console.log('DEBUG', JSON.stringify(debug, null, 1)?.slice(0, 3000))
  console.log('WROTE', resolve(ARTIFACTS, 'exact-timeline.json'))
} finally {
  await browser.close()
}