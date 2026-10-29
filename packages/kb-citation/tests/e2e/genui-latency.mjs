/**
 * Real-admin latency regression for a GenUI docx citation click.
 *
 * The assertion is the product requirement: the first citation box must be painted *and* inside
 * the PDF viewport within 3000 ms of the click, without scanning to the last page. A second click
 * on the same chip must reuse the confirmed page and land even faster.
 *
 * Usage:
 *   node packages/kb-citation/tests/e2e/genui-latency.mjs
 *
 * The script signs in to DataOps, opens the managed DSH target, hot-swaps only the built
 * kb-citation client bundle through a route, and never restarts or reinstalls the admin.
 */
import assert from 'node:assert/strict'
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
const FIRST_BOX_BUDGET_MS = Number(process.env.KB_CITATION_BUDGET_MS ?? 3000)
const REPEAT_BUDGET_MS = Number(process.env.KB_CITATION_REPEAT_BUDGET_MS ?? 1500)
mkdirSync(ARTIFACTS, { recursive: true })

/** Serve the freshly built client bundle instead of the installed tarball. */
async function patchBundle(page) {
  const source = readFileSync(CLIENT, 'utf8')
  assert.match(source, /id: "@sparkelf\/dsh-kb-citation"/, 'built client bundle is missing the module id')
  await page.route(/\/plugins\/\?\?/, async route => {
    const response = await route.fetch()
    const body = await response.text()
    const idAt = body.indexOf('id: "@sparkelf/dsh-kb-citation"')
    if (idAt === -1) return route.fulfill({ response, body })
    const start = body.lastIndexOf('window.__ModuleLoader__.load({', idAt)
    const next = body.indexOf('window.__ModuleLoader__.load({', idAt)
    assert.notEqual(start, -1, 'combined plugin bundle did not expose a module boundary')
    const patched = body.slice(0, start) + source + '\n;\n' + body.slice(next === -1 ? body.length : next)
    await route.fulfill({
      status: response.status(),
      headers: { ...response.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      body: patched,
    })
  })
}

/** Open the GenUI card through the sidebar's recent-session rows. */
async function openCard(page) {
  await page.goto(process.env.KB_CITATION_BASE ?? page.__base, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[class*="sessionRow"]').length > 0, undefined, { timeout: 45_000 })
  await page.waitForTimeout(1200)
  // Older sessions sit behind「展开其余 N 个会话」once the sidebar has more than a screenful.
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
  const rows = page.locator('[class*="sessionRow"]', { hasText: SESSION_TITLE })
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click()
    const found = await page.waitForFunction(
      () => document.querySelectorAll('button[data-kb-citation-token]').length > 0,
      undefined,
      { timeout: 15_000 },
    ).then(() => true).catch(() => false)
    if (found) return
  }
  throw new Error('no GenUI card with a kb citation was found')
}

/**
 * Install the page-side probe and click one chip.
 *
 * `firstBox` is the first `.kb-citation-box` mutation; `firstVisible` is the first sample where
 * that box intersects the PDF scrollport. Both use one clock started immediately before the
 * click, so the JSON is directly comparable to the 3000 ms budget.
 */
async function clickAndTime(page, label) {
  const started = await page.evaluate(token => {
    const host = window
    host.__KB_CITATION_TIMING__ = true
    host.__kbt = { t0: performance.now(), marks: [], firstBox: null, firstVisible: null, samples: [] }
    const now = () => Math.round((performance.now() - host.__kbt.t0) * 10) / 10
    const scrollport = () => [...document.querySelectorAll('*')]
      .find(element => /scrollport/.test(String(element.className)) && element.scrollHeight > element.clientHeight + 1)
      ?? null
    const describe = () => {
      const box = document.querySelector('.kb-citation-box')
      const view = scrollport()
      const boxes = document.querySelectorAll('.kb-citation-box').length
      if (box === null || view === null) {
        const layer = document.getElementById('kb-citation-floating-layer')
        return { boxes, page: null, visible: false, hasBox: box !== null, hasScrollport: view !== null, floating: layer === null ? null : layer.childElementCount }
      }
      const rect = box.getBoundingClientRect()
      const viewRect = view.getBoundingClientRect()
      return {
        boxes,
        hasBox: true,
        hasScrollport: true,
        page: Number(box.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? box.getAttribute('data-kb-citation-page')),
        floating: (() => { const layer = document.getElementById('kb-citation-floating-layer'); return layer === null ? null : layer.childElementCount })(),
        visible: rect.bottom > viewRect.top + 2 && rect.top < viewRect.bottom - 2,
        box: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
        view: { top: Math.round(viewRect.top), bottom: Math.round(viewRect.bottom) },
        scrollTop: view.scrollTop,
        scrollHeight: view.scrollHeight,
        clientHeight: view.clientHeight,
        p14: (() => {
          const page = [...document.querySelectorAll('[data-pdf-page]')].find(element => element.getAttribute('data-pdf-page') === '14')
          if (page === undefined) return null
          const pageRect = page.getBoundingClientRect()
          return { top: Math.round(pageRect.top), bottom: Math.round(pageRect.bottom), height: Math.round(pageRect.height), spans: page.querySelectorAll('span').length }
        })(),
      }
    }
    host.__kbt.describe = describe
    const record = name => {
      const state = describe()
      if (state.hasBox && state.hasScrollport && host.__kbt.firstBox === null) {
        host.__kbt.firstBox = { at: now(), name, ...state }
        requestAnimationFrame(() => { if (host.__kbt.rafAt === undefined) host.__kbt.rafAt = now() })
      }
      if (state.visible === true && host.__kbt.firstVisible === null) {
        host.__kbt.firstVisible = { at: now(), name, ...state }
      }
    }
    const observer = new MutationObserver(() => { record('mutation') })
    observer.observe(document.body, { childList: true, subtree: true })
    host.__kbt.observer = observer
    const poll = setInterval(() => {
      const state = describe()
      if (state.hasBox) host.__kbt.samples.push({ at: now(), ...state })
      record('poll')
      if (host.__kbt.firstVisible !== null) clearInterval(poll)
    }, 50)
    host.__kbt.poll = poll
    const chip = document.querySelector('button[data-kb-citation-token="' + token + '"]')
    if (chip === null) throw new Error('citation chip disappeared')
    chip.click()
    return now()
  }, TOKEN)
  void started
  const deadline = Date.now() + FIRST_BOX_BUDGET_MS + 5000
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      firstBox: window.__kbt.firstBox,
      firstVisible: window.__kbt.firstVisible,
    }))
    if (state.firstVisible !== null) break
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(600)
  const result = await page.evaluate(() => {
    clearInterval(window.__kbt.poll)
    window.__kbt.observer.disconnect()
    const samples = window.__kbt.samples
    return {
      firstBox: window.__kbt.firstBox,
      firstVisible: window.__kbt.firstVisible,
      final: window.__kbt.describe(),
      rafAt: window.__kbt.rafAt ?? null,
      samples: samples.filter((sample, index) => index % 2 === 0).slice(0, 120),
    }
  })
  console.log(label, JSON.stringify({ firstBox: result.firstBox, firstVisible: result.firstVisible }, null, 1))
  return result
}

const session = await createAdminSession()
console.log('TARGET', session.targetOrigin, 'PID', session.dsh?.pid)
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.__base = session.targetOrigin + '/'
  const timingLines = []
  page.on('console', message => {
    const text = message.text()
    if (text.includes('[kbtiming]')) timingLines.push({ at: Date.now(), text })
  })
  await patchBundle(page)
  await openCard(page)
  const chip = page.locator(`button[data-kb-citation-token="${TOKEN}"]`).first()
  assert.equal(await chip.count(), 1, 'the GenUI card must render exactly one target citation chip')
  // Wait for the chunk endpoint to enrich the label: this is the state a reader sees.
  await chip.locator('.kb-citation-suffix').waitFor({ state: 'visible', timeout: 10_000 })

  const cold = await clickAndTime(page, 'COLD')
  console.log('TIMING', timingLines.map(line => line.text).join('\n'))
  if (cold.firstBox === null) {
    console.log('NODOX', JSON.stringify(await page.evaluate(() => ({
      pages: document.querySelectorAll('[data-pdf-page]').length,
      spans: document.querySelectorAll('[data-pdf-page] span').length,
      boxes: document.querySelectorAll('.kb-citation-box').length,
      tabs: [...document.querySelectorAll('[class*="tabTitle"]')].map(el => el.textContent),
      body: document.body.innerText.slice(0, 500),
    })), null, 1))
    await page.screenshot({ path: resolve(ARTIFACTS, 'genui-latency-nodebug.png') })
  }
  assert.notEqual(cold.firstBox, null, 'a citation box must be painted')
  assert.ok(cold.firstBox.at < FIRST_BOX_BUDGET_MS,
    `first box took ${String(cold.firstBox.at)}ms, budget ${String(FIRST_BOX_BUDGET_MS)}ms`)
  assert.notEqual(cold.firstVisible, null, 'the first box must end inside the PDF viewport')
  assert.ok(cold.firstVisible.at < FIRST_BOX_BUDGET_MS,
    `first visible box took ${String(cold.firstVisible.at)}ms, budget ${String(FIRST_BOX_BUDGET_MS)}ms`)
  assert.equal(cold.final?.visible, true, `the first box must still be inside the viewport after layout settles (${JSON.stringify(cold.final)})`)
  assert.ok(cold.firstVisible.page > 1, 'the box must be on the chunk page, not page 1')
  assert.ok(cold.firstVisible.scrollTop < cold.firstVisible.scrollHeight - cold.firstVisible.clientHeight - 100,
    'the viewer must not be left on the last page')
  await page.screenshot({ path: resolve(ARTIFACTS, 'genui-latency-cold.png') })

  // Repeat click: clear the old overlay, click the same chip and require the confirmed page to
  // be reused. This is the path a reader takes when they click a second citation in the answer.
  await page.evaluate(() => { for (const box of document.querySelectorAll('.kb-citation-box')) box.remove() })
  const warm = await clickAndTime(page, 'WARM')
  assert.notEqual(warm.firstVisible, null, 'the repeat click must reveal its box')
  assert.equal(warm.final?.visible, true, `the repeat box must still be inside the viewport after layout settles (${JSON.stringify(warm.final)})`)
  assert.ok(warm.firstVisible.at < REPEAT_BUDGET_MS,
    `repeat click took ${String(warm.firstVisible.at)}ms, budget ${String(REPEAT_BUDGET_MS)}ms`)
  assert.equal(warm.firstVisible.page, cold.firstVisible.page, 'the repeat click must land on the confirmed page')

  const report = {
    ok: true,
    target: session.targetOrigin,
    budgetMs: FIRST_BOX_BUDGET_MS,
    repeatBudgetMs: REPEAT_BUDGET_MS,
    cold: { firstBoxMs: cold.firstBox.at, firstVisibleMs: cold.firstVisible.at, page: cold.firstVisible.page },
    warm: { firstBoxMs: warm.firstBox.at, firstVisibleMs: warm.firstVisible.at, page: warm.firstVisible.page },
    timing: timingLines,
    coldSamples: cold.samples,
  }
  writeFileSync(resolve(ARTIFACTS, 'genui-latency.json'), JSON.stringify(report, null, 1))
  console.log('RESULT', JSON.stringify({ cold: report.cold, warm: report.warm }, null, 1))
  console.log('TIMING', timingLines.map(line => line.text).join('\n'))
} finally {
  await browser.close()
}