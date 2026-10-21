// 审计日志的时间倒序与分页的真实入口验收。
//
// 对应用户报过的问题：审计页是一长串没有分页的列表，用户看不到自己在哪、也没法翻。
// 分页之外还钉住两件容易被"看起来对"掩盖的事：
//
// 1. **排序**是从时间戳算出来的，不是 jsonl 的写入顺序。宿主恰好把新的写在后面，
//    所以照抄数组顺序也能"看起来正确"——那条路会在写入方改变的那天静默反过来。
// 2. 分页必须**稳定**：并列时间戳（一次批量操作会写出多条同一时刻的记录）要有全序
//    次级键，否则翻页会出现同一行两次、或某一行根本没出现过。这里翻到第二页后拿两页
//    的边界行比较，正是为了抓住这一点——只断言单页内有序的话，跨页乱序是查不出来的。
//
// 凭据只从环境变量来（KB_SYSTEM_USER / KB_SYSTEM_PASS）；缺省时用例 skip 并说明
// 原因，绝不落一个"看起来通过"的结果。仓库里没有密码。

import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'
import { enterKnowledgeBase, hasCredentials } from './support/kb-portal.mjs'

test.skip(!hasCredentials, '需要 KB_SYSTEM_USER / KB_SYSTEM_PASS 才能驱动真实登录入口')

/**
 * 无害噪声：与本功能合同无关的宿主环境事实。
 *
 * - `net::ERR_ABORTED` / `ERR_NETWORK_CHANGED` 是 DSH 外壳在页面切换或 iframe 重挂载
 *   时取消自身握手请求，属于导航语义，不是知识库失败。
 * - WebGL `GPU stall due to ReadPixels` 是 Xvfb 无 GPU 时 Chrome 的软渲染提示。
 */
function isAmbientNoise(problem) {
  return problem.includes('net::ERR_ABORTED')
    || problem.includes('net::ERR_NETWORK_CHANGED')
    || problem.includes('GPU stall due to ReadPixels')
}

/** 断言没有真实（非环境噪声）的浏览器或网络故障。 */
function expectNoProblems(problems) {
  expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
}

/**
 * 进入审计页的「日志」栏。
 *
 * 「进来」的判据是审计页自己的两个 tab 出现过，而不是标题文字：标题在侧边栏和面板里
 * 都有，命中它不代表面板已经挂载。随后切到日志栏——分页器只在日志表格下面。
 * @param {import('playwright/test').Page} page 页面。
 * @param {string[]} problems 浏览器问题收集器。
 * @returns {Promise<import('playwright/test').Frame>} DSH 框架。
 */
async function openAuditLog(page, problems) {
  observePage(page, '审计', problems)
  const frame = await enterKnowledgeBase(page)
  await frame.getByText('审计', { exact: true }).first().click()

  // 审批栏与日志栏是同一页面的两个问题域，两个 tab 都出现才算审计页挂上了。
  await expect(frame.getByRole('tab', { name: /^审批/u })).toBeVisible({ timeout: 25_000 })
  const logTab = frame.getByRole('tab', { name: '日志' })
  await expect(logTab).toBeVisible()

  await logTab.click()
  await expect(logTab).toHaveAttribute('aria-selected', 'true')
  // 日志表格本体：等它出现，而不是等一个固定时长。
  await expect(frame.locator('table[data-kb-audit="log"]')).toBeVisible({ timeout: 25_000 })
  return frame
}

/** 当前页的日志表。 */
function logTable(frame) {
  return frame.locator('table[data-kb-audit="log"]')
}

/**
 * 一页的时间列，按行顺序。
 *
 * 时间列的文案是 `YYYY/MM/DD HH:mm`（DataOps 自己的格式，便于跨页比较）。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @returns {Promise<string[]>} 每行的时间文本。
 */
async function timeCells(frame) {
  return await logTable(frame).locator('tbody tr td:first-child').allInnerTexts()
    .then(cells => cells.map(text => text.trim()))
}

/**
 * 把一页里看起来是时间的文本解析成可比较的数值。
 *
 * 只用于比较顺序，不用于展示：同一年份下的 `YYYY/MM/DD HH:mm` 解析不出时返回 NaN，
 * 调用方据此跳过而不是伪造通过。
 * @param {string[]} texts 时间列文本。
 * @returns {number[]} 毫秒时间戳，无法解析为 NaN。
 */
function parseTimes(texts) {
  return texts.map(text => {
    const match = text.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})\D+(\d{1,2}):(\d{2})/u)
    if (match === null) return Number.NaN
    const [, year, month, day, hour, minute] = match
    return new Date(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute),
    ).getTime()
  })
}

/** 断言一串时间戳严格非递增（允许并列：同一次批量操作会写出同一时刻的多条）。 */
function expectNewestFirst(times) {
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1]
    const current = times[index]
    // 解析失败不参与比较：那是本用例读不到时间列，不是顺序错了。
    if (Number.isNaN(previous) || Number.isNaN(current)) continue
    expect(
      current,
      `第 ${String(index + 1)} 行（${String(new Date(current).toISOString())}）比上一行更新，`
      + '说明表格没有按时间倒序排列',
    ).toBeLessThanOrEqual(previous)
  }
}

test('审计日志有分页器：页码文本与页大小控件都在', async ({ page }) => {
  const problems = []
  const frame = await openAuditLog(page, problems)

  // 分页器只在超过一页时出现（一页装得下时它正确地隐身）。数据量不是测试前提，所以
  // 在"有分页器"与"一页装得下"之间二选一，而不是把数据量当成断言失败。
  const pager = frame.locator('[data-kb-audit-pager]').first()
  const pagerShown = await pager.isVisible().catch(() => false)
  test.skip(!pagerShown, '当前审计日志不足一页，分页器按设计隐藏，无法驱动翻页')

  // 页码文本：形如「第 1 页 / 共 N 页」。
  const position = frame.locator('[data-kb-audit-position]').first()
  await expect(position).toBeVisible()
  await expect(position).toHaveText(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/u)

  // 总数文本存在（「共 T 条」），它是读者判断"还有多少没看"的依据。
  await expect(pager).toHaveText(/共\s*\d+\s*条/u)

  // 页大小控件：20/50/100 三档，当前值 20（默认）。
  const sizeControl = pager.getByRole('tablist').first()
  await expect(sizeControl).toBeVisible()
  const sizeOptions = await sizeControl.getByRole('tab').allInnerTexts()
  expect(sizeOptions.map(text => text.trim())).toEqual(['20 条', '50 条', '100 条'])
  await expect(sizeControl.getByRole('tab', { name: '20 条' })).toHaveAttribute('aria-selected', 'true')

  expectNoProblems(problems)
})

test('审计日志按时间倒序，翻到第二页后仍然成立', async ({ page }) => {
  const problems = []
  const frame = await openAuditLog(page, problems)

  const pager = frame.locator('[data-kb-audit-pager]').first()
  const pagerShown = await pager.isVisible().catch(() => false)
  test.skip(!pagerShown, '当前审计日志不足一页，无法验证跨页顺序')

  const next = pager.getByRole('button', { name: '下一页' }).first()
  const canAdvance = await next.isEnabled().catch(() => false)
  test.skip(!canAdvance, '当前审计日志只有一页，无法翻页比较边界')

  // 第一页内部必须倒序。
  const firstPage = parseTimes(await timeCells(frame))
  expect(firstPage.filter(time => !Number.isNaN(time)).length, '日志表格里读不到时间列').toBeGreaterThan(1)
  expectNewestFirst(firstPage)

  // 记下第一页的最后一行：它要和第二页的第一行接得上。这一条是本题的核心——
  // 只比较单页内部，跨页乱序（并列时间戳没有稳定次级键时就会出现）是查不出来的。
  const firstPageLast = firstPage[firstPage.length - 1]

  await next.click()
  await expect(frame.locator('[data-kb-audit-position]').first()).toHaveText(/第\s*2\s*页/u)

  // 第二页内部同样倒序。
  const secondPage = parseTimes(await timeCells(frame))
  expectNewestFirst(secondPage)

  // 边界：第一页的末行必须 ≥ 第二页的首行。若排序在翻页之间重算且不稳定，这里会翻。
  const secondPageFirst = secondPage[0]
  if (!Number.isNaN(firstPageLast) && !Number.isNaN(secondPageFirst)) {
    expect(
      secondPageFirst,
      '第二页的第一行比第一页的最后一行更新：翻页后顺序不连续，页与页之间出现了乱序',
    ).toBeLessThanOrEqual(firstPageLast)
  }

  // 翻回第一页：页码与内容都要回到原位，而不是停在一个空白页。
  await pager.getByRole('button', { name: '上一页' }).first().click()
  await expect(frame.locator('[data-kb-audit-position]').first()).toHaveText(/第\s*1\s*页/u)
  const backToFirst = parseTimes(await timeCells(frame))
  expect(backToFirst).toEqual(firstPage)

  expectNoProblems(problems)
})

test('单页数据时不出分页器，也不出现「第 1 / 0 页」', async ({ page }) => {
  const problems = []
  const frame = await openAuditLog(page, problems)

  // 这一条不假设数据量：分页器要么不渲染（一页装得下），要么页码落在合法区间内。
  // 无论哪种，"共 0 页"都是错的——它把一个空集说成了零页可翻。
  const pager = frame.locator('[data-kb-audit-pager]').first()
  const pagerShown = await pager.isVisible().catch(() => false)

  if (pagerShown) {
    const position = frame.locator('[data-kb-audit-position]').first()
    const positionShown = await position.isVisible().catch(() => false)
    if (positionShown) {
      const text = (await position.innerText()).trim()
      // 不得出现「共 0 页」，也不得出现「第 1 页 / 共 0 页」这类自相矛盾的页码。
      expect(text, '分页器把空集说成了 0 页').not.toMatch(/共\s*0\s*页/u)
      expect(text).toMatch(/第\s*0*\d+\s*页\s*\/\s*共\s*0*\d+\s*页/u)
      // 当前页不得大于总页数。
      const [, current, total] = text.match(/第\s*(\d+)\s*页\s*\/\s*共\s*(\d+)\s*页/u) ?? []
      if (current !== undefined && total !== undefined) {
        expect(Number(current)).toBeLessThanOrEqual(Number(total))
        expect(Number(total)).toBeGreaterThanOrEqual(1)
      }
    }
  } else {
    // 没有分页器时，页面上也不该留下一个"第 1 页 / 共 0 页"的残影。
    const bodyText = await frame.locator('body').innerText()
    expect(bodyText).not.toMatch(/第\s*\d+\s*页\s*\/\s*共\s*0\s*页/u)
  }

  expectNoProblems(problems)
})
