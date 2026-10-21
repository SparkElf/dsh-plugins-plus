// 知识库拖放上传的真实入口验收。
//
// 这条用例回答的问题只有一个人能问出来：「我把文件从桌面拖进知识库侧边栏，为什么
// 没反应？」所以它必须走真实入口、真实登录、真实 iframe，并用真实的 `DataTransfer`
// 触发浏览器事件 —— 用 mock 或直接调接口都证明不了「拖」这件事能work。
//
// 唯一被构造的东西是那个拖放事件本身：Playwright 不能在操作系统层面拖动文件，所以
// `File` 与 `DataTransfer` 在页面里造出来再 `dispatchEvent`。这是浏览器提供给页面的
// 同一套 API，页面收到的对象与真实拖放同构，因此「事件到达后会发生什么」是被真实验证
// 的；没有被验证的只是「操作系统把一个文件交给浏览器」这一段，而那不是本插件的代码。
//
// 凭据只来自环境变量（KB_SYSTEM_USER / KB_SYSTEM_PASS），缺失时 skip 并说明原因。
//
// ## 这条用例抓到过的真实 bug（留在这里，因为它是「为什么要写系统测试」的证据）
//
// 上线前的 31 条单测全绿，而拖放上传在真机上 100% 失败：普通文件的
// `webkitRelativePath` 是**空字符串**（不是 undefined），代码写的是
// `webkitRelativePath ?? file.name`，`??` 对空串不回退，于是文件名整个丢掉，目标路径
// 变成 `personal/<uid>/`，服务端判为逃逸根目录并返回 400。
//
// 单测为什么没抓到：它们用 `{ file: { name }, relativePath }` 这样的**伪造输入**，
// 直接给了 `relativePath`，从来没有走过「从一个真实 `File` 推导出 relativePath」那一段。
// **伪造输入的形状会掩盖真实输入的形状错误** —— 这正是这条用例必须构造真实
// `File` + 真实 `DataTransfer` 的理由。
//
// ## 清理
//
// 这个插件没有真正的删除路由：`trash.remove` 只写墓碑（trash.ts 的注释说明在硬链接
// 共享树上 unlink 表达不了这件事），`list` 并不过滤墓碑，所以调它不会让文件消失。
// 因此每个上传的文件名都带本次运行的唯一标记，用例结束时输出一份残留清单（文件名 +
// 目标目录），由验收者统一处理 —— 一份如实的清单，比一个假装清理干净的 teardown 有用。

import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'
import { enterKnowledgeBase, hasCredentials } from './support/kb-portal.mjs'

test.skip(!hasCredentials, '需要 KB_SYSTEM_USER / KB_SYSTEM_PASS 才能驱动真实登录入口')

/** 本次运行所有上传的文件的标记，用来给每一行一个唯一名字并汇报残留。 */
const RUN_TAG = 'kbdrop' + Date.now().toString(36)

/** 本次运行上传过的文件名，`afterAll` 用来汇报残留。 */
const uploaded = []

/**
 * 与本功能合同无关的宿主环境事实。
 *
 * 与 `knowledge-base.spec.mjs` 同一套判据：导航语义的中断、Xvfb 下的 WebGL 提示。
 * 其余 console/网络问题仍然让用例失败。
 * @param {string} problem 一条采集到的问题。
 * @returns 是否属于环境噪声。
 */
function isAmbientNoise(problem) {
  return problem.includes('net::ERR_ABORTED')
    || problem.includes('net::ERR_NETWORK_CHANGED')
    || problem.includes('GPU stall due to ReadPixels')
}

/**
 * 进入知识库主页，并等到表格已经列出内容。
 * @param {import('playwright/test').Page} page 页面。
 * @param {string[]} problems 诊断收集。
 * @param {string} label 诊断标签。
 * @returns {Promise<import('playwright/test').Frame>} DSH 框架。
 */
async function openHome(page, problems, label) {
  observePage(page, label, problems)
  const frame = await enterKnowledgeBase(page)
  await expect(frame.getByText('主页', { exact: true }).first()).toBeVisible({ timeout: 25_000 })
  // 主页的复选标记：表格头部的第一列是「标题」。等它出现说明这次读取已经回来了，
  // 否则下面的「拖入后 3 秒内出现」会跟首屏加载赛跑，测的就不是上传了。
  await expect(frame.getByRole('columnheader', { name: '标题' })).toBeVisible({ timeout: 25_000 })
  return frame
}

/**
 * 在页面里造一个 `File` 和一个带上它的 `DataTransfer`。
 *
 * 返回 `DataTransfer` 的句柄，供后续 `dispatchEvent` 使用。必须在页面上下文里构造：
 * Node 侧的 `File` 与浏览器里的不是同一个类，`DataTransfer` 更是只有浏览器有。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @param {Array<{ name: string, content: string }>} files 要造的文件。
 * @returns {Promise<import('playwright/test').JSHandle>} `DataTransfer` 句柄。
 */
async function makeTransfer(frame, files) {
  return frame.evaluateHandle((entries) => {
    const transfer = new DataTransfer()
    for (const entry of entries) {
      transfer.items.add(new File([entry.content], entry.name, { type: 'text/markdown' }))
    }
    return transfer
  }, files)
}

/**
 * 把 `DataTransfer` 依次以 `dragover` 与 `drop` 派发到一个元素上。
 *
 * `dragover` 必须先发：组件的 handler 在 `dragover` 里 `preventDefault` 才允许随后
 * 的 `drop`，直接发 `drop` 会绕过它要验证的那条判断。两个事件都用 `bubbles: true`，
 * 因为监听挂在行/容器上而不是派发目标本身。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @param {import('playwright/test').Locator} target 接收拖放的元素。
 * @param {import('playwright/test').JSHandle} transfer `DataTransfer` 句柄。
 */
async function dropOn(frame, target, transfer) {
  const handle = await target.elementHandle()
  if (handle === null) throw new Error('drop target has no element handle')
  // `dispatchEvent` 只接受可序列化的 init，`dataTransfer` 必须按句柄传进去。
  await frame.evaluate(({ element, transferHandle }) => {
    const init = { bubbles: true, cancelable: true, dataTransfer: transferHandle }
    element.dispatchEvent(new DragEvent('dragenter', init))
    element.dispatchEvent(new DragEvent('dragover', init))
    element.dispatchEvent(new DragEvent('drop', init))
  }, { element: handle, transferHandle: transfer })
}

/**
 * 知识库主页的那张文档表。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @returns {import('playwright/test').Locator} 表格。
 */
function homeTable(frame) {
  return frame.locator('table').first()
}

/**
 * 等某个文件名出现在主页表格里。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @param {string} name 文件名。
 * @param {number} timeout 上限毫秒。
 * @returns {Promise<boolean>} 是否出现了。
 */
async function waitForRow(frame, name, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const visible = await frame.getByText(name, { exact: true }).first().isVisible().catch(() => false)
    if (visible) return true
    await frame.waitForTimeout(200)
  }
  return false
}

test.describe('拖放上传', () => {
  test.afterAll(() => {
    // 残留清单：文件名 + 它落到的目录。没有删除路由可用（见文件头），所以如实报告，
    // 由验收者统一处理。
    if (uploaded.length > 0) {
      console.log('[kb-upload] 本次运行在知识库中留下 ' + String(uploaded.length) + ' 个文件（无删除路由，需人工处理）:')
      for (const entry of uploaded) {
        console.log('[kb-upload]   ' + entry.dir + '/' + entry.name)
      }
    }
  })

  test('把一个 md 拖到主页表格后，文件出现在列表里', async ({ page }) => {
    const problems = []
    const frame = await openHome(page, problems, '拖放上传')

    const name = RUN_TAG + '-single.md'
    uploaded.push({ name, dir: 'personal/<uid>' })
    const transfer = await makeTransfer(frame, [{ name, content: '# dropped\n\nvia drag and drop\n' }])

    await dropOn(frame, homeTable(frame), transfer)
    await transfer.dispose()

    // 断言的是「文件出现在列表里」，不是「高亮出现了」：高亮只是事件到了的证据，
    // 用户要的是文件真的在。3 秒是本条用例的核心时限 —— 上传不等提取，落盘即可见。
    const appeared = await waitForRow(frame, name, 3_000)
    expect(appeared, '拖入后 3 秒内文件没有出现在主页列表里').toBe(true)

    expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
  })

  test('一次拖两个文件，两行都在', async ({ page }) => {
    const problems = []
    const frame = await openHome(page, problems, '多文件拖放')

    const first = RUN_TAG + '-multi-a.md'
    const second = RUN_TAG + '-multi-b.md'
    uploaded.push({ name: first, dir: 'personal/<uid>' }, { name: second, dir: 'personal/<uid>' })
    const transfer = await makeTransfer(frame, [
      { name: first, content: '# a\n' },
      { name: second, content: '# b\n' },
    ])

    await dropOn(frame, homeTable(frame), transfer)
    await transfer.dispose()

    // 两个都要在：只到一个说明批次被中断了，而读者会以为文件都传上去了。
    const sawFirst = await waitForRow(frame, first, 5_000)
    const sawSecond = await waitForRow(frame, second, 5_000)
    expect(sawFirst, '第一个文件没有出现').toBe(true)
    expect(sawSecond, '第二个文件没有出现').toBe(true)

    expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
  })

  test('上传时出现行内进度区，而不是弹窗', async ({ page }) => {
    const problems = []
    const frame = await openHome(page, problems, '进度区')

    const name = RUN_TAG + '-progress.md'
    uploaded.push({ name, dir: 'personal/<uid>' })
    const transfer = await makeTransfer(frame, [{ name, content: '# progress\n' }])

    // 观察必须从 drop 之前开始：一个 md 上传在本地是毫秒级的，等 drop 回来再找进度区
    // 会与"已经折叠/卸载"赛跑，测到的永远是没看见。所以这里在拖放之前就把"进度区
    // 出现过"变成一次可见性等待，让 Playwright 自己捕获中间那一帧。
    const strip = frame.locator('section[aria-label="进度"], section[aria-label="Progress"]').first()
    const stripSeen = strip.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)

    await dropOn(frame, homeTable(frame), transfer)
    await transfer.dispose()

    // 两个可接受的结果，都要求"区域真的存在过"：
    //   - 传输慢：进度区在传输期间可见；
    //   - 传输快：它已折叠成一行摘要，但仍在 DOM 里（折叠不等于消失）。
    const sawStrip = await stripSeen
    const attachedAfter = await strip.count() > 0
    expect(
      sawStrip || attachedAfter,
      '拖放上传后没有任何行内进度区域出现（用户看不到上传在进行）',
    ).toBe(true)

    // 用户明确不要弹窗。只看知识库面板范围内的 dialog：整个页面里别的插件
    // （分享、确认框、命令面板）会合法地开 dialog，那与本需求无关。
    const panelDialogs = await frame.locator('section[aria-label="进度"] [role="dialog"], section[aria-label="Progress"] [role="dialog"]').count()
    expect(panelDialogs, '进度展示被做成了弹窗，用户明确要求侧边栏底部的行内区域').toBe(0)

    expect(problems.filter(problem => !isAmbientNoise(problem))).toEqual([])
  })

  test('重名上传会显示带原因的失败文案', async ({ page }) => {
    const problems = []
    const frame = await openHome(page, problems, '失败原因')

    // 先把一个文件传上去，再传同名的一个：第二次必然被 upload 路由拒绝（它以
    // `flag:'wx'` 写入，已存在就是拒绝），于是失败行必须说明原因。
    const name = RUN_TAG + '-dupe.md'
    uploaded.push({ name, dir: 'personal/<uid>' })
    const first = await makeTransfer(frame, [{ name, content: '# first\n' }])
    await dropOn(frame, homeTable(frame), first)
    await first.dispose()
    expect(await waitForRow(frame, name, 5_000), '第一次上传就没有成功，无法构造重名场景').toBe(true)

    // 第一次必须**彻底结束**才能发第二次。`busy={uploadBusy}` 在上传期间会让 drop 被
    // 忽略（这是对的：两批同时写同一目录会让进度计数失去意义），所以只等「文件出现在
    // 列表里」是不够的——列表刷新可能早于 busy 复位，此时第二次拖放会被静默丢掉，
    // 于是进度区显示「1 已上传 0 失败」，看起来像重名没有被拒绝。
    const stripBeforeSecond = frame.locator('section[aria-label="进度"], section[aria-label="Progress"]').first()
    const firstSettled = await (async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const text = await stripBeforeSecond.innerText().catch(() => '')
        if (/1 个已上传/u.test(text) || /1 uploaded/u.test(text)) return true
        await frame.waitForTimeout(200)
      }
      return false
    })()
    expect(firstSettled, '第一次上传没有在 20 秒内报完成，无法构造重名场景').toBe(true)

    const second = await makeTransfer(frame, [{ name, content: '# second\n' }])
    await dropOn(frame, homeTable(frame), second)
    await second.dispose()

    // 必须等这一次的结果落定再读进度区。上传是异步的，drop 只是派发事件；早读的
    // 时候行还停在「正在上传…」，而那正是诊断里看到的情形。等的是"不再显示进行中"，
    // 不是固定时长。
    const stripEarly = frame.locator('section[aria-label="进度"], section[aria-label="Progress"]').first()
    const settled = await (async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const text = await stripEarly.innerText().catch(() => '')
        // 一旦出现「失败」计数即为终态；轮询中也会看到「正在上传」，那说明还没完。
        if (/[1-9]\d* 个失败/u.test(text) || /\d+ failed/u.test(text)) return true
        await frame.waitForTimeout(200)
      }
      return false
    })()
    expect(settled, '第二次（重名）上传一直没有落到终态，20 秒内仍显示进行中').toBe(true)

    // 失败文案必须带原因，而且必须在**进度区里**——整页正则会被别处的文案蒙混过关。
    //
    // 进度区在整批任务到达终态时会**自动折叠成一行摘要**，摘要里只有计数、没有原因。
    // 这是刻意的设计（做完就收起，不长期占位），所以断言前必须先展开它——这不是
    // 绕过问题，而是按用户真实会做的动作去读那条原因：他看到「1 个失败」会点开看是哪个。
    const strip = frame.locator('section[aria-label="进度"], section[aria-label="Progress"]').first()
    const expand = strip.getByRole('button', { name: /展开|Expand/u }).first()
    if (await expand.count() > 0 && await expand.isVisible().catch(() => false)) {
      await expand.click({ force: true })
      await frame.waitForTimeout(300)
    }

    // 诊断优先：断言失败时把进度区的完整文本、以及「进度区到底存不存在」都带出来。
    // 上一次正是靠这句实际文本才定位到「占位符没替换」，而不是去猜上传路由。
    const stripCount = await strip.count()
    const stripText = stripCount > 0 ? await strip.innerText().catch(() => '') : ''
    const failureText = await frame.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(line => line.trim()).filter(line => line !== '')
      return lines.filter(line => /fail|失败|exist|already|too large|超大|已存在|超出|拒绝|refus/i.test(line)).slice(0, 8)
    })

    const diagnosis = [
      '进度区存在: ' + String(stripCount),
      '进度区文本: ' + JSON.stringify(stripText.slice(0, 500)),
      '页面上与失败相关的行: ' + JSON.stringify(failureText),
    ].join(' | ')

    // 已存在时 Host 的回答来自 createKnowledgeEntry 的 EEXIST → 文案含 exist/already。
    // 同时要求那一行带着这个文件名，证明原因属于这次重名、不是页面别处的旧文案。
    const hasReason = /exist|already|too large|超大|已存在|超出|EACCES|write access/i.test(stripText)
    const namesTheFile = stripText.includes(name)
    expect(
      hasReason && namesTheFile,
      '进度区没有显示可操作的原因（需要同时有原因文案和出问题的文件名）。' + diagnosis,
    ).toBe(true)

    // 这条测试**故意**制造一次 409（重名被拒），浏览器把它记成 console error。
    // 那是被测行为本身，不是环境故障，所以只在这一条里豁免、并且豁免得尽量窄：
    // 必须是 upload 路由、状态码 409 的那一条，其它任何 console error 仍然失败。
    const expectedConflict = (problem) => problem.includes('knowledge-base/api/upload')
      && problem.includes('409')
      && problem.includes('console error')
    expect(problems.filter(problem => !isAmbientNoise(problem) && !expectedConflict(problem))).toEqual([])
  })
})
