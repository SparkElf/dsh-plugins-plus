/**
 * Click-to-box timeline for a GenUI docx citation.
 *
 * Prints the requested 0/500/1000/2000/3000/5000/10000 ms checkpoints and saves every change.
 * This is diagnostic evidence for BBOX-LATENCY-FIX.md, not a pass/fail gate
 * (genui-latency.mjs owns the 3000 ms assertion).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = process.env.KB_CITATION_CLIENT ?? resolve(HERE, '../../lib/client.js')
const SESSION_TITLE = process.env.KB_CITATION_SESSION ?? '董事会与经营班子会表决门槛差异'
const TOKEN = process.env.KB_CITATION_TOKEN ?? 'kb://doc/51/chunk/e63b7f9eda2d86cb'
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts')
mkdirSync(ARTIFACTS, { recursive: true })

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
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  await patchBundle(page)
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1200)
  const expand = page.getByText(/展开其余 \d+ 个会话/).first()
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await expand.click().catch(() => undefined)
    await page.waitForTimeout(2200)
  }
  await page.waitForFunction(
    title => [...document.querySelectorAll('[class*="sessionRow"]')].some(row => (row.textContent ?? '').includes(title)),
    SESSION_TITLE,
    { timeout: 30_000 },
  )
  await page.locator('[class*="sessionRow"]', { hasText: SESSION_TITLE }).first().click()
  await page.waitForFunction(
    () => document.querySelectorAll('button[data-kb-citation-token] .kb-citation-suffix').length > 0,
    undefined,
    { timeout: 20_000 },
  )

  await page.evaluate(token => {
    const host = window
    host.__KB_CITATION_TIMING__ = true
    host.__timeline = { t0: performance.now(), samples: [] }
    const now = () => Math.round((performance.now() - host.__timeline.t0) * 10) / 10
    const snapshot = () => {
      const boxes = [...document.querySelectorAll('.kb-citation-box')]
      const box = boxes[0]
      const scrollport = [...document.querySelectorAll('*')]
        .find(element => /scrollport/.test(String(element.className)) && element.scrollHeight > element.clientHeight + 1)
      const view = scrollport?.getBoundingClientRect()
      const boxRect = box?.getBoundingClientRect()
      return {
        t: now(),
        pages: document.querySelectorAll('[data-pdf-page]').length,
        spans: document.querySelectorAll('[data-pdf-page] span').length,
        boxes: boxes.length,
        boxPages: boxes.map(element => Number(element.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? element.getAttribute('data-kb-citation-page'))),
        floatingBoxes: document.querySelectorAll('[data-kb-citation-floating="true"]').length,
        boxPage: box === undefined ? null : Number(box.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? box.getAttribute('data-kb-citation-page')),
        boxVisible: boxRect !== undefined && view !== undefined && boxRect.bottom > view.top + 2 && boxRect.top < view.bottom - 2,
        boxTop: boxRect === undefined ? null : Math.round(boxRect.top),
        boxHeight: boxRect === undefined ? null : Math.round(boxRect.height),
        scrollTop: scrollport?.scrollTop ?? null,
        scrollHeight: scrollport?.scrollHeight ?? null,
        clientHeight: scrollport?.clientHeight ?? null,
      }
    }
    host.__timeline.snapshot = snapshot
    let lastKey = ''
    host.__timeline.timer = setInterval(() => {
      const sample = snapshot()
      const key = JSON.stringify([sample.pages, sample.spans, sample.boxes, sample.boxVisible, sample.scrollTop])
      if (key !== lastKey) { lastKey = key; host.__timeline.samples.push(sample) }
    }, 100)
    const chip = document.querySelector('button[data-kb-citation-token="' + token + '"]')
    chip.click()
  }, TOKEN)

  let previous = 0
  for (const at of [0, 500, 1000, 2000, 3000, 5000, 10000]) {
    await page.waitForTimeout(at - previous)
    previous = at
    const sample = await page.evaluate(() => window.__timeline.snapshot())
    console.log(`AT ${String(at)}ms boxes=${String(sample.boxes)} pages=${JSON.stringify(sample.boxPages)} floating=${String(sample.floatingBoxes)} visible=${String(sample.boxVisible)} spans=${String(sample.spans)} scrollTop=${String(sample.scrollTop)}`)
  }
  const report = await page.evaluate(() => {
    clearInterval(window.__timeline.timer)
    return { target: location.origin, samples: window.__timeline.samples }
  })
  writeFileSync(resolve(ARTIFACTS, 'genui-timeline.json'), JSON.stringify(report, null, 1))
  console.log('WROTE', resolve(ARTIFACTS, 'genui-timeline.json'))
} finally {
  await browser.close()
}