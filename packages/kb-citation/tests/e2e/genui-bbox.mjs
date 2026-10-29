/**
 * Real GenUI card regression for the docx bbox path.
 *
 * This drives the live DataOps admin UI (or any DSH instance that has the `dsh-genui` card
 * session and the knowledge-base fixture) and hot-swaps only the kb-citation client bundle via
 * a Playwright route. The admin process is never restarted or re-installed.
 *
 * Usage:
 *   KB_CITATION_BASE=http://127.0.0.1:3098/ \
 *   KB_CITATION_SESSION='董事会与经营班子会表决门槛差异' \
 *   node packages/kb-citation/tests/e2e/genui-bbox.mjs
 *
 * The target session must contain the real `dsh-ui` artifact whose source list cites
 * `kb://doc/51/chunk/e63b7f9eda2d86cb`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = process.env.KB_CITATION_CLIENT ?? resolve(HERE, '../../lib/client.js')
const session = process.env.KB_CITATION_BASE === undefined ? await createAdminSession() : undefined
const BASE = process.env.KB_CITATION_BASE ?? session.targetOrigin + '/'
const SESSION_TITLE = process.env.KB_CITATION_SESSION ?? '董事会与经营班子会表决门槛差异'
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts')
const TOKEN = 'kb://doc/51/chunk/e63b7f9eda2d86cb'

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

/** Open the GenUI card through the sidebar's recent-session row, as a reader would. */
async function openCard(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)
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

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  if (session !== undefined) await context.addCookies([session.cookie])
  const page = await context.newPage()
  page.on('console', message => { if (message.text().includes('[kbtiming]')) console.log(message.text()) })
  await patchBundle(page)
  await openCard(page)

  const chip = page.locator(`button[data-kb-citation-token="${TOKEN}"]`).first()
  assert.equal(await chip.count(), 1, 'the GenUI card must render exactly one target citation chip')
  // The chunk endpoint upgrades the fallback filename to `filename:第N块` asynchronously.
  await chip.locator('.kb-citation-suffix').waitFor({ state: 'visible', timeout: 8000 })
  const chipState = await chip.evaluate(element => {
    const style = getComputedStyle(element)
    const suffix = element.querySelector('.kb-citation-suffix')
    return {
      className: element.className,
      text: element.textContent,
      token: element.getAttribute('data-kb-citation-token'),
      icon: element.querySelector('svg.kb-citation-file-link-icon') !== null,
      badge: element.querySelector('.kb-citation-fileicon') !== null,
      color: style.color,
      fontWeight: style.fontWeight,
      textDecoration: style.textDecorationLine,
      suffixColor: suffix === null ? null : getComputedStyle(suffix).color,
      styleAttribute: element.getAttribute('style'),
    }
  })
  assert.match(chipState.className, /kb-citation-file-link/)
  assert.match(chipState.className, /fileLink/, 'the chip must carry the official fileLink class')
  assert.equal(chipState.token, TOKEN)
  assert.equal(chipState.icon, true, 'the chip must use the official paper file glyph')
  assert.equal(chipState.badge, false, 'no custom W/X/PDF badge may be rendered')
  assert.equal(chipState.styleAttribute, null, 'native styling must come from classes, not inline styles')
  assert.equal(chipState.textDecoration, 'none', 'official fileLink is not underlined at rest')
  assert.equal(chipState.fontWeight, '500')
  assert.notEqual(chipState.suffixColor, chipState.color, 'the :第N块 suffix must be muted')
  await page.screenshot({ path: resolve(ARTIFACTS, 'genui-chip-native.png') })

  await page.evaluate(() => { window.__KB_CITATION_TIMING__ = true })
  await chip.click()
  // Measure from the dispatched click, not from Playwright's pre-click actionability wait.
  const clickAt = Date.now()
  await page.waitForFunction(() => document.querySelectorAll('.kb-citation-box').length > 0, undefined, { timeout: 15_000 })
  const firstBoxMs = Date.now() - clickAt
  // Timing is asserted by genui-latency.mjs with a page-side observer; this test owns the
  // bbox/style contract and records the same number for the report.
  await page.waitForTimeout(600)

  const viewer = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.kb-citation-box')]
    const first = boxes[0]
    const scrollport = document.querySelector('[class*="scrollport"]')
    const boxRect = first.getBoundingClientRect()
    const viewRect = scrollport.getBoundingClientRect()
    return {
      boxes: boxes.length,
      pages: boxes.map(box => Number(box.closest('[data-pdf-page]')?.getAttribute('data-pdf-page') ?? box.getAttribute('data-kb-citation-page'))),
      box: { top: boxRect.top, bottom: boxRect.bottom, left: boxRect.left, right: boxRect.right, width: boxRect.width, height: boxRect.height },
      view: { top: viewRect.top, bottom: viewRect.bottom, left: viewRect.left, right: viewRect.right },
      scrollTop: scrollport.scrollTop,
      scrollHeight: scrollport.scrollHeight,
      clientHeight: scrollport.clientHeight,
    }
  })
  assert.ok(viewer.boxes >= 1, 'at least one paragraph box must be painted')
  assert.ok(viewer.box.width > 1 && viewer.box.height > 1, 'the first box must have real geometry')
  assert.ok(viewer.pages[0] > 1, 'the first box must be on the chunk page, not page 1')
  assert.ok(viewer.box.bottom > viewer.view.top && viewer.box.top < viewer.view.bottom,
    'the first box must be inside the viewer viewport')
  assert.ok(viewer.scrollTop < viewer.scrollHeight - viewer.clientHeight - 100,
    'the viewer must not be left on the last page')
  await page.screenshot({ path: resolve(ARTIFACTS, 'genui-viewer-box.png') })

  console.log(JSON.stringify({ ok: true, firstBoxMs, chip: chipState, viewer }, null, 2))
} finally {
  await browser.close()
}