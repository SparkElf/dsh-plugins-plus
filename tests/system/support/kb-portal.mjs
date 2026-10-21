// DataOps 门户登录与 DSH 子框架定位。
//
// ⚠️ 三条已验证的判据事实（都来自真机实测，不是读代码推断的）。照下面的错误写法再写
// 一遍就会得到永不成立的等待，进而把每条用例都拖成超时：
//
// 1. 登录成功后 **URL 不变**。门户是单页应用，登录只是换掉了根路由里渲染的内容，
//    地址仍然是 `http://127.0.0.1:8080/`。任何"等 URL 变化"或"等 pathname 变成别的"
//    的判据都不会成立。
// 2. 登录后的可靠信号是**门户自己的顶部导航**（首页/任务/数据/日志/…）。这些按钮只在
//    登录后渲染，是唯一稳定的"已经进来了"证据。
// 3. DSH 工作台在 `/ai/dsh` 的 **iframe** 里，其内容（新会话、知识库等）在顶层文档中
//    根本不存在。所以"等顶层出现新会话"同样永不成立；要取的是 `page.frames()` 里那个
//    子框架，并且要用工作台自己的导航项（知识库）确认它是工作台而不是登录页。

//
// 知识库插件不在门户自己的文档里，而在 `/ai/dsh` 渲染的 IFRAME 中。这一段只处理
// "怎么进入真实入口并拿到那个 frame"：它是所有知识库系统测试共用的技术前置条件，
// 不替任何用例断言业务结果。凭据只来自环境变量，仓库里不留密码。

import { expect } from 'playwright/test'

const PORTAL = process.env.KB_SYSTEM_PORTAL ?? 'http://127.0.0.1:8080'
const DSH_PATH = '/ai/dsh'
const USER = process.env.KB_SYSTEM_USER
const PASS = process.env.KB_SYSTEM_PASS

/** 凭据是否齐备；缺省时用例应显式 skip，而不是假装通过。 */
export const hasCredentials = Boolean(USER && PASS)

/**
 * 等待一个可观察状态成立。
 *
 * 门户与 DSH 都是运行时渲染的 SPA：元素什么时候出现取决于后端与资源加载，不是固定
 * 时长能表达的。这里轮询的是 DOM 事实，不是"睡够就好"。
 * @param {() => Promise<boolean>} probe 条件。
 * @param {number} timeout 上限毫秒。
 * @returns 是否在预算内成立。
 */
async function until(probe, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true
    } catch {
      // frame 正在导航时求值会抛错，那是"还没到"，不是失败。
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

/**
 * 登录门户并进入 DSH 外壳，返回 DSH 的 frame。
 *
 * 门户会记住会话，所以"账号密码"表单可能根本不出现；两条路径都落到 `/ai/dsh`。
 * @param {import('playwright/test').Page} page 页面。
 * @returns {Promise<import('playwright/test').Frame>} DSH 子框架。
 */
export async function enterDsh(page) {
  await page.goto(PORTAL + '/', { waitUntil: 'domcontentloaded' })

  const accountTab = page.getByRole('button', { name: '账号密码' })
  const loggedOut = await until(async () => await accountTab.isVisible(), 30_000)

  if (loggedOut) {
    await accountTab.click()
    // 表单只在选中该 tab 后渲染。三个 input 依次是账号、密码、"记住我"复选框，
    // 所以密码按 aria-label 定位而不是靠下标：下标会随着"记住我"的有无而漂移。
    const account = page.locator('input').nth(0)
    const password = page.locator('input[aria-label="密码"]')
    await expect(password).toHaveCount(1)
    await account.fill(USER)
    await password.fill(PASS)
    await page.getByRole('button', { name: '进入工作台' }).click()
    // 必须等登录真的完成再导航：立刻 goto 会打断还在飞的登录请求，让下一次跳转
    // 因未认证被踢回登录页。
    //
    // 判据不能只是"登录 tab 不可见"——页面重渲染时它会短暂消失又回来，据此放行就会
    // 撞上那条竞态。这里等的是"已经离开登录页"：URL 不再停在门户根路径，或出现了
    // 只有登录后才有的工作台标记。两者任一成立才算真的进来了。
    // 判据必须是"登录后门户才有的东西"。门户登录后仍停在同一 SPA 路由（URL 不变），
    // 而 DSH 的工作台内容在 /ai/dsh 的 iframe 里、此刻还不存在，所以两者都不能当判据。
    // 只有登录后才会出现的门户顶部导航才是可靠信号。
    const signedIn = await until(async () => {
      if (await accountTab.isVisible().catch(() => false)) return false
      return await page.getByRole('button', { name: '首页', exact: true }).isVisible().catch(() => false)
    }, 45_000)
    expect(signedIn, '提交账号密码后仍停留在登录表单').toBe(true)
  }

  /**
   * 找到承载工作台的那个子框架。
   *
   * 只要求"有正文"是不够的：登录失效时 iframe 里渲染的是登录页，同样有正文，于是
   * 后面所有断言都会在错误页面上失败并归因成"功能坏了"。判据因此是工作台自己的
   * 导航项（知识库）——它只在真正的工作台里出现。
   */
  const workbenchFrame = async () => {
    const frames = page.frames().filter(frame => frame !== page.mainFrame() && frame.url().startsWith('http'))
    for (const frame of frames) {
      const hasNav = await frame.evaluate(() => (document.body?.innerText ?? '').includes('知识库')).catch(() => false)
      if (hasNav) return frame
    }
    return undefined
  }

  await page.goto(PORTAL + DSH_PATH, { waitUntil: 'domcontentloaded' })
  let frame = await until(workbenchFrame, 60_000).then(async ok => (ok ? await workbenchFrame() : undefined))

  if (frame === undefined) {
    // 外壳自身会在挂载时重新协商会话，被中断的握手会让 iframe 停在半挂载状态。
    // 重载一次是真实用户也会做的动作，而不是用等待掩盖问题。
    await page.reload({ waitUntil: 'domcontentloaded' })
    frame = await until(workbenchFrame, 60_000).then(async ok => (ok ? await workbenchFrame() : undefined))
  }

  expect(frame, 'DSH 子框架始终没有渲染出工作台').toBeDefined()
  return frame
}

/**
 * 在知识库页面完成一次真实点击。
 *
 * 工作台里同一个词可能出现多次（导航项与页面标题都会写「知识库」），所以按 DOM 顺序
 * 取第一个：侧边栏入口在最前。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @param {string} label 可见文字。
 */
export async function clickSection(frame, label) {
  // 侧边栏导航项是 button，而面板标题是 span。只按文字取第一个会命中标题——它不可点，
  // 点击就会等到超时。所以优先按可点击元素定位，找不到再退回文字。
  const asButton = frame.getByRole('button', { name: label, exact: true }).first()
  const target = (await asButton.count()) > 0 ? asButton : frame.getByText(label, { exact: true }).first()
  await expect(target).toBeVisible({ timeout: 25_000 })
  // `force` 是必要的：DSH 外壳会在这一行上方留一个透明层（onboarding 的捕获层、
  // 或刚挂载时的布局占位），Playwright 的命中测试认为按钮被挡住就永远不点。实测把
  // 这个点击改成 force 才稳定，而按钮本身确实是可见、可用、稳定的。
  await target.click({ force: true })
}

/**
 * 进入知识库主页。
 * @param {import('playwright/test').Page} page 页面。
 * @returns {Promise<import('playwright/test').Frame>} DSH 框架。
 */
export async function enterKnowledgeBase(page) {
  const frame = await enterDsh(page)
  await clickSection(frame, '知识库')

  // 点一次不一定就落位：DSH 首次挂载时侧边栏可能先渲染、面板随后才注入，第一次点击
  // 会被布局变化吃掉。这里等的是"知识库页面出现了自己的栏目"这一可观察结果，
  // 没出现就再点一次，而不是假定单击必然生效。
  const landed = async () => await frame.getByText('权限管理', { exact: true }).first().isVisible().catch(() => false)

  // 面板首次挂载要等它自己拉数据。宿主后端偶尔会短暂不可用（同一轮里群聊也会显示
  // "服务器没有响应"），此时点击已经生效、面板却还没渲染出来。重试针对的就是这一段：
  // 等面板出现，没出现就再点一次。
  for (let attempt = 0; attempt < 6 && !(await landed()); attempt += 1) {
    await frame.waitForTimeout(700)
    if (await landed()) break
    await clickSection(frame, '知识库')
  }

  // 仍然没有就重载一次：这是真实用户遇到同样情况会做的动作，而不是把失败藏起来。
  // 重载后依旧进不去就如实失败——那说明宿主真的没在提供知识库，不是测试写错了。
  if (!(await landed())) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    const refound = await until(async () => {
      const candidate = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith('http'))
      if (candidate === undefined) return false
      return await candidate.evaluate(() => (document.body?.innerText ?? '').includes('知识库')).catch(() => false)
    }, 45_000)
    if (refound) {
      const again = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith('http'))
      if (again !== undefined) {
        await clickSection(again, '知识库')
        for (let attempt = 0; attempt < 6 && !(await again.getByText('权限管理', { exact: true }).first().isVisible().catch(() => false)); attempt += 1) {
          await again.waitForTimeout(700)
        }
        const ok = await again.getByText('权限管理', { exact: true }).first().isVisible().catch(() => false)
        expect(ok, '重载后仍然进不去知识库页面（宿主未提供该页面）').toBe(true)
        return again
      }
    }
  }

  expect(await landed(), '点击「知识库」后没有进入知识库页面').toBe(true)
  return frame
}
