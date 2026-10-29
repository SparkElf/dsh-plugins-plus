/**
 * Long-wait amber probe: tolerates a slow Office→PDF conversion and samples the required
 * 0/1/2/3/5/10/15 s after the viewer is actually ready.
 *
 * Diagnostic only. Writes artifacts under KB_CITATION_ARTIFACTS.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = process.env.KB_CITATION_CLIENT ?? resolve(HERE, '../../lib/client.js')
const SESSION_TITLE = process.env.KB_CITATION_SESSION ?? '董事会与经营班子会表决门槛差异'
const TOKEN = process.env.KB_CITATION_TOKEN ?? 'kb://doc/49/chunk/1fe09e0dbfb4184d'
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts/long')
const HOTSWAP = process.env.KB_CITATION_HOTSWAP !== '0'
const READY_TIMEOUT = Number(process.env.KB_CITATION_READY_TIMEOUT ?? 120000)
mkdirSync(ARTIFACTS, { recursive: true })

async function patchBundle(page) {
  if (!HOTSWAP) return
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
console.log('TARGET', session.targetOrigin, 'hotswap', HOTSWAP)
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.on('pageerror', error => { console.log('PAGEERROR', error.message.slice(0, 300)) })
  const consoleLines = []
  page.on('console', message => {
    consoleLines.push({ at: Date.now(), type: message.type(), text: message.text().slice(0, 600) })
  })
  const requests = []
  page.on('response', response => {
    const url = response.url()
    if (/office|pdf|preview|convert|document/i.test(url)) requests.push({ url: url.slice(0, 200), status: response.status() })
  })
  await patchBundle(page)
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1500)
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await page.getByText(/展开其余 \d+ 个会话/).first().click().catch(() => undefined)
    await page.waitForTimeout(2500)
  }
  await page.waitForFunction(
    title => [...document.querySelectorAll('[class*="sessionRow"]')].some(row => (row.textContent ?? '').includes(title)),
    SESSION_TITLE,
    { timeout: 30_000 },
  )
  const rows = page.locator('[class*="sessionRow"]', { hasText: SESSION_TITLE })
  const rowCount = await rows.count()
  for (let index = 0; index < rowCount; index += 1) {
    await rows.nth(index).click()
    const found = await page.waitForFunction(
      token => document.querySelectorAll('button[data-kb-citation-token="' + token + '"]').length > 0,
      TOKEN,
      { timeout: 8000 },
    ).then(() => true).catch(() => false)
    if (found) { console.log('OPENED ROW', index); break }
  }
  await page.waitForFunction(
    token => (document.querySelector('button[data-kb-citation-token="' + token + '"]')?.textContent ?? '').includes('.docx'),
    TOKEN,
    { timeout: 15_000 },
  )
  const chips = await page.evaluate(() => [...document.querySelectorAll('button[data-kb-citation-token]')].map(button => ({
    token: button.getAttribute('data-kb-citation-token'),
    text: (button.textContent ?? '').slice(0, 100),
  })))
  console.log('CHIPS', chips.length, JSON.stringify(chips))

  await page.evaluate(({ token }) => {
    const host = window
    host.__KB_CITATION_TIMING__ = true
    host.__amber = { t0: null, firstBoxAt: null, firstHitAt: null, lastSample: null }
    const now = () => (host.__amber.t0 === null ? 0 : Math.round((performance.now() - host.__amber.t0) * 10) / 10)
    const scrollport = () => [...document.querySelectorAll('*')]
      .find(element => /scrollport/.test(String(element.className)) && element.scrollHeight > element.clientHeight + 1) ?? null
    const snapshot = () => {
      const hits = [...document.querySelectorAll('.kb-citation-hit')]
      const boxes = [...document.querySelectorAll('.kb-citation-box')]
      const view = scrollport()
      const box = boxes[0]
      const boxRect = box?.getBoundingClientRect()
      const viewRect = view?.getBoundingClientRect()
      const state = {
        t: now(),
        pages: document.querySelectorAll('[data-pdf-page]').length,
        textPages: [...document.querySelectorAll('[data-pdf-page]')].filter(p => p.querySelectorAll('span').length > 0).length,
        spans: document.querySelectorAll('[data-pdf-page] span').length,
        boxes: boxes.length,
        boxPage: box === undefined ? null : Number(box.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? box.getAttribute('data-kb-citation-page')),
        boxVisible: boxRect !== undefined && viewRect !== undefined && boxRect.bottom > viewRect.top + 2 && boxRect.top < viewRect.bottom - 2,
        hits: hits.length,
        hitPages: hits.map(element => Number(element.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? '0')),
        legend: document.querySelectorAll('.kb-citation-legend').length,
        rendering: /文档渲染中|渲染中|正在渲染/.test(document.body.innerText),
        scrollTop: view?.scrollTop ?? null,
        scrollHeight: view?.scrollHeight ?? null,
        clientHeight: view?.clientHeight ?? null,
      }
      host.__amber.lastSample = state
      if (state.boxes > 0 && host.__amber.firstBoxAt === null) host.__amber.firstBoxAt = state.t
      if (state.hits > 0 && host.__amber.firstHitAt === null) host.__amber.firstHitAt = state.t
      return state
    }
    host.__amber.snapshot = snapshot
    const observer = new MutationObserver(() => { snapshot() })
    observer.observe(document.body, { childList: true, subtree: true })
    const chip = document.querySelector('button[data-kb-citation-token="' + token + '"]')
    host.__amber.t0 = performance.now()
    chip.click()
  }, { token: TOKEN })

  const ready = await page.waitForFunction(
    () => [...document.querySelectorAll('[data-pdf-page]')].some(page => page.querySelectorAll('span').length > 0)
      && !/文档渲染中|正在渲染/.test(document.body.innerText),
    undefined,
    { timeout: READY_TIMEOUT, polling: 250 },
  ).then(() => true).catch(() => false)
  const readyAt = await page.evaluate(() => window.__amber ? Math.round((performance.now() - window.__amber.t0) * 10) / 10 : null)
  console.log('READY', ready, 'at', readyAt)

  const timeline = []
  const checkpoints = [0, 1000, 2000, 3000, 5000, 10000, 15000]
  let previous = 0
  for (const at of checkpoints) {
    await page.waitForTimeout(at - previous)
    previous = at
    const sample = await page.evaluate(() => window.__amber.snapshot())
    timeline.push(sample)
    console.log(`AT ${String(at)}ms boxes=${String(sample.boxes)} hits=${String(sample.hits)} legend=${String(sample.legend)} pages=${String(sample.pages)} textPages=${String(sample.textPages)} spans=${String(sample.spans)} page=${String(sample.boxPage)} visible=${String(sample.boxVisible)} rendering=${String(sample.rendering)} scrollTop=${String(sample.scrollTop)}`)
    await page.screenshot({ path: resolve(ARTIFACTS, `shot-${String(at)}ms.png`) })
  }
  await page.screenshot({ path: resolve(ARTIFACTS, 'amber-probe-long.png') })
  await page.screenshot({ path: resolve(ARTIFACTS, 'amber-probe-long-viewer.png'), clip: { x: 940, y: 40, width: 740, height: 1000 } })
  const debug = await page.evaluate(() => window.__kbCitationDebug ?? null)
  const timing = await page.evaluate(() => window.__kbCitationTiming ?? null)
  const firsts = await page.evaluate(() => ({ firstBoxAt: window.__amber.firstBoxAt, firstHitAt: window.__amber.firstHitAt }))
  const pageDump = await page.evaluate(() => [...document.querySelectorAll('[data-pdf-page]')].map(p => ({
    page: p.getAttribute('data-pdf-page'),
    spans: p.querySelectorAll('span').length,
    text: [...p.querySelectorAll('span')].map(s => (s.textContent ?? '')).join('').slice(0, 500),
  })))
  const hitDump = await page.evaluate(() => [...document.querySelectorAll('.kb-citation-hit')].map(hit => {
    const rect = hit.getBoundingClientRect()
    const style = getComputedStyle(hit)
    return { page: hit.closest('[data-pdf-page]')?.getAttribute('data-pdf-page'), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), display: style.display, visibility: style.visibility, opacity: style.opacity, z: style.zIndex, bg: style.backgroundColor, border: style.borderTopColor }
  }))
  const report = { target: session.targetOrigin, hotswap: HOTSWAP, ready, readyAt, firsts, timeline, debug, timing, pageDump, hitDump, requests, consoleLines }
  writeFileSync(resolve(ARTIFACTS, 'amber-probe-long.json'), JSON.stringify(report, null, 1))
  console.log('FIRSTS', JSON.stringify(firsts))
  console.log('DEBUG', JSON.stringify(debug, null, 1)?.slice(0, 8000))
  console.log('HITS', JSON.stringify(hitDump))
  console.log('WROTE', resolve(ARTIFACTS, 'amber-probe-long.json'))
} finally {
  await browser.close()
}