/** Inspect which spans the installed per-span amber matcher picks, and their geometry. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createAdminSession } from './lib/admin-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = process.env.KB_CITATION_ARTIFACTS ?? resolve(HERE, 'artifacts/dom')
const TOKEN = process.env.KB_CITATION_TOKEN ?? 'kb://doc/49/chunk/1fe09e0dbfb4184d'
const SESSION_TITLE = '董事会与经营班子会表决门槛差异'
mkdirSync(ARTIFACTS, { recursive: true })

const session = await createAdminSession()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } })
  await context.addCookies([session.cookie])
  const page = await context.newPage()
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
  await page.waitForTimeout(1000)
  await page.evaluate(token => document.querySelector('button[data-kb-citation-token="' + token + '"]').click(), TOKEN)
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-pdf-page]')].some(p => p.querySelectorAll('span').length > 0)
      && !/文档渲染中|正在渲染/.test(document.body.innerText),
    undefined, { timeout: 120_000, polling: 250 },
  ).catch(() => undefined)
  await page.waitForTimeout(4000)

  const report = await page.evaluate(() => {
    const terms = ['董事', '经营', '班子', '表决', '通过', '门槛', '使用', '知识', '工具']
    const norm = value => value.replace(/\s+/g, '').trim()
    const chain = element => {
      const parts = []
      let node = element
      while (node !== null && parts.length < 6) {
        parts.push(node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.split(/\s+/).slice(0, 2).join('.') : ''))
        node = node.parentElement
      }
      return parts.join(' < ')
    }
    const rectOf = element => {
      const r = element.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
    }
    const matched = []
    for (const pageEl of document.querySelectorAll('[data-pdf-page]')) {
      for (const span of pageEl.querySelectorAll('span')) {
        const text = norm(span.textContent ?? '')
        if (text === '') continue
        const hit = terms.filter(term => text.includes(term))
        if (hit.length === 0) continue
        matched.push({
          page: pageEl.dataset.pdfPage, terms: hit, text: text.slice(0, 60),
          rect: rectOf(span), chain: chain(span),
          style: span.getAttribute('style'), cls: span.className,
        })
      }
    }
    const hits = [...document.querySelectorAll('.kb-citation-hit')].map(hit => ({
      rect: rectOf(hit), style: hit.getAttribute('style'), parent: chain(hit),
      parentTransform: hit.parentElement ? getComputedStyle(hit.parentElement).transform : null,
    }))
    const pages = [...document.querySelectorAll('[data-pdf-page]')].map(pageEl => ({
      page: pageEl.dataset.pdfPage, rect: rectOf(pageEl),
      canvas: [...pageEl.querySelectorAll('canvas')].map(c => rectOf(c)),
      textLayers: [...pageEl.querySelectorAll('[class*="textLayer"], [class*="text-layer"]')].map(t => ({ cls: t.className, rect: rectOf(t) })),
    }))
    return { matched, hits, pages, blue: [...document.querySelectorAll('.kb-citation-box')].map(b => ({ rect: rectOf(b), parent: chain(b) })) }
  })
  writeFileSync(resolve(ARTIFACTS, 'amber-dom.json'), JSON.stringify(report, null, 1))
  console.log('MATCHED', report.matched.length)
  for (const m of report.matched.slice(0, 25)) console.log(JSON.stringify(m))
  console.log('HITS', JSON.stringify(report.hits))
  console.log('BLUE', JSON.stringify(report.blue))
  console.log('PAGES', JSON.stringify(report.pages.filter(p => p.page === '8')))
  await page.screenshot({ path: resolve(ARTIFACTS, 'amber-dom.png') })
} finally {
  await browser.close()
}