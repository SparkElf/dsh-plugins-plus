/**
 * Amber query-hit probe for a real GenUI docx citation.
 *
 * Reproduces the reported symptom: the blue chunk union lands, but `.kb-citation-hit` stays 0.
 * Samples the required 0/1/2/3/5/10 s checkpoints and dumps the page-side diagnostic hook the
 * built client bundle installs (`window.__kbCitationDebug`). Diagnostic only, no assertions.
 *
 * Usage:
 *   node packages/kb-citation/tests/e2e/amber-probe.mjs
 *   KB_CITATION_HOTSWAP=0 node ...   # use the installed bundle instead of lib/client.js
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
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts')
const HOTSWAP = process.env.KB_CITATION_HOTSWAP !== '0'
const NO_TERMS = process.env.KB_CITATION_NO_TERMS === '1'
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
    console.log('PATCH BUNDLE', 'moduleChars', next - start, 'newChars', source.length)
    await route.fulfill({
      status: response.status(),
      headers: { ...response.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      body: body.slice(0, start) + source + '\n;\n' + body.slice(next === -1 ? body.length : next),
    })
  })
}

const session = await createAdminSession()
console.log('TARGET', session.targetOrigin, 'PID', session.dsh?.pid, 'hotswap', HOTSWAP)
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.on('pageerror', error => { console.log('PAGEERROR', error.message.slice(0, 400)) })
  const consoleLines = []
  page.on('console', message => {
    consoleLines.push({ at: Date.now(), type: message.type(), text: message.text().slice(0, 800) })
  })
  await patchBundle(page)
  await page.goto(session.targetOrigin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // The admin session list hydrates ~9 s after first paint.
  await page.waitForFunction(
    () => document.querySelectorAll('[class*="sessionRow"]').length > 0,
    undefined,
    { timeout: 45_000 },
  )
  await page.waitForTimeout(1500)
  // The sidebar collapses older sessions behind「展开其余 N 个会话」; the target is one of them.
  const expand = page.getByText(/展开其余 \d+ 个会话/).first()
  if (await page.getByText(/展开其余 \d+ 个会话/).count() > 0) {
    await expand.click().catch(() => undefined)
    await page.waitForTimeout(2500)
  }
  await page.waitForFunction(
    title => [...document.querySelectorAll('[class*="sessionRow"]')].some(row => (row.textContent ?? '').includes(title)),
    SESSION_TITLE,
    { timeout: 30_000 },
  )
  // Several sessions share this title prefix; the one that owns the citation chip is the target.
  const rows = page.locator('[class*="sessionRow"]', { hasText: SESSION_TITLE })
  const rowCount = await rows.count()
  console.log('CANDIDATE ROWS', rowCount)
  for (let index = 0; index < rowCount; index += 1) {
    console.log('TRY ROW', index, JSON.stringify((await rows.nth(index).textContent() ?? '').slice(0, 80)))
    await rows.nth(index).click()
    const found = await page.waitForFunction(
      token => document.querySelectorAll('button[data-kb-citation-token="' + token + '"]').length > 0,
      TOKEN,
      { timeout: 8000 },
    ).then(() => true).catch(() => false)
    if (found) { console.log('OPENED ROW', index); break }
  }
  // Wait for the chunk endpoint to enrich the label; this is the state a reader clicks.
  await page.waitForFunction(
    token => (document.querySelector('button[data-kb-citation-token="' + token + '"]')?.textContent ?? '').includes('.docx'),
    TOKEN,
    { timeout: 15_000 },
  )
  const chipCount = await page.locator(`button[data-kb-citation-token="${TOKEN}"]`).count()
  console.log('CHIP COUNT', chipCount)
  const allChips = await page.evaluate(() => [...document.querySelectorAll('button[data-kb-citation-token]')].map(button => ({
    token: button.getAttribute('data-kb-citation-token'),
    text: (button.textContent ?? '').slice(0, 120),
  })))
  console.log('CHIPS', JSON.stringify(allChips, null, 1))

  await page.evaluate(({ token, noTerms }) => {
    const host = window
    if (noTerms) {
      // Prove the no-fake-amber contract: with no user prompt in the DOM there is no term,
      // and the citation must show only the blue union.
      for (const row of document.querySelectorAll('[data-chat-flow-kind="user"]')) row.setAttribute('data-chat-flow-kind', 'hidden-user')
    }
    host.__KB_CITATION_TIMING__ = true
    host.__amber = { t0: performance.now(), firstBoxAt: null, firstHitAt: null, lastSample: null }
    const now = () => Math.round((performance.now() - host.__amber.t0) * 10) / 10
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
    host.__amber.observer = observer
    const chip = document.querySelector('button[data-kb-citation-token="' + token + '"]')
    chip.click()
  }, { token: TOKEN, noTerms: NO_TERMS })

  const checkpoints = [0, 1000, 2000, 3000, 5000, 10000]
  let previous = 0
  const timeline = []
  for (const at of checkpoints) {
    await page.waitForTimeout(at - previous)
    previous = at
    const sample = await page.evaluate(() => window.__amber.snapshot())
    timeline.push(sample)
    console.log(`AT ${String(at)}ms boxes=${String(sample.boxes)} hits=${String(sample.hits)} legend=${String(sample.legend)} pages=${String(sample.pages)} spans=${String(sample.spans)} page=${String(sample.boxPage)} visible=${String(sample.boxVisible)} rendering=${String(sample.rendering)} scrollTop=${String(sample.scrollTop)}`)
  }
  await page.screenshot({ path: resolve(ARTIFACTS, 'amber-probe.png') })
  await page.screenshot({
    path: resolve(ARTIFACTS, 'amber-probe-viewer.png'),
    clip: { x: 940, y: 40, width: 740, height: 1000 },
  })
  const debug = await page.evaluate(() => window.__kbCitationDebug ?? null)
  const firsts = await page.evaluate(() => ({ firstBoxAt: window.__amber.firstBoxAt, firstHitAt: window.__amber.firstHitAt }))
  const htmlSnippet = await page.evaluate(() => {
    const pageElement = [...document.querySelectorAll('[data-pdf-page]')].find(element => element.querySelectorAll('span').length > 0)
    return pageElement === undefined ? null : {
      page: pageElement.getAttribute('data-pdf-page'),
      spans: [...pageElement.querySelectorAll('span')].slice(0, 40).map(span => (span.textContent ?? '').slice(0, 60)),
    }
  })
  const report = { target: session.targetOrigin, hotswap: HOTSWAP, noTerms: NO_TERMS, firsts, timeline, debug, htmlSnippet, consoleLines }
  writeFileSync(resolve(ARTIFACTS, 'amber-probe.json'), JSON.stringify(report, null, 1))
  console.log('FIRSTS', JSON.stringify(firsts))
  console.log('DEBUG', JSON.stringify(debug, null, 1)?.slice(0, 5000))
  console.log('WROTE', resolve(ARTIFACTS, 'amber-probe.json'))
} finally {
  await browser.close()
}