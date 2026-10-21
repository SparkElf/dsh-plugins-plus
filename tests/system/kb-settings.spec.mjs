// DSH 全局设置 → 知识库分节：真机系统验收。
//
// 这一节是「知识库」插件唯一挂在全局设置里的界面（侧边栏「设置」→ 左栏「知识库」），
// 所以它是用户唯一能看到这些控件的地方。测的是用户目标，不是内部实现：从 DataOps 门户
// 真实登录、进入 /ai/dsh 的内嵌 DSH、点开设置、点开知识库分节，然后读页面上真实渲染
// 出来的东西。
//
// 不 mock、不调接口、不读源码。凭据只从环境变量来（KB_SYSTEM_USER / KB_SYSTEM_PASS），
// 缺省时整份 skip 并说明原因——绝不落一个「看起来通过」的结果。
//
// 覆盖的四条都是这一轮被用户指出的实际缺陷：
// 1. 四处解释性文案（用户红笔划掉）不应再出现。
// 2. 同屏曾有两个「保存」按钮，现在只允许一个。
// 3. MinerU 地址在「按端口推导」时曾显示为空白输入框——推导了就必须显示推导结果。
// 4. 本地模式 + 无 SSH 主机时，「部署」整块曾只剩一个悬空标题。

import { expect, test } from 'playwright/test'
import { observePage } from './support/browser-health.mjs'
import { enterKnowledgeBase, hasCredentials } from './support/kb-portal.mjs'

test.skip(!hasCredentials, '需要 KB_SYSTEM_USER / KB_SYSTEM_PASS 才能驱动真实登录入口')

/**
 * 被用户划掉的四段解释文字，按原文断言它们不存在。
 *
 * 用原文而不是 key：key 名是内部标识，删掉引用但字典里还留着词条时，只有原文能证明
 * 用户真的看不见它们。中英各取一条代表句——这四条在中文界面下渲染，所以中文是主判据；
 * 英文句一并列上，防止有人只删了一半字典却让语言切换后的页面继续显示。
 */
const STRUCK_OUT_COPY = [
  // 1. 顶部说明：整句删。
  '浏览已挂载的知识目录',
  // 2. 存储模式下面：本地与远程两个分支都是同一句的一部分。
  '保存在工作区本地目录',
  '文档保存在共享的 NFS 视图中',
  // 3. 部署整段：讲解句与「远程部署会做什么」小标题。
  '部署步骤在远程主机上执行',
  '远程部署会做什么',
  '远程部署会从共享的 NFS 或 SSHFS 导出同步文档',
  // 4. MinerU 上方：整句删。
  '文档解析服务的位置',
]

/*
 * ── 噪声判据（写在最前，免得下一个人以为过滤是随意的）────────────────────────────
 *
 * 默认规则是「浏览器控制台/网络有任何错误就不算通过」。这条规则必须守得住：真的断了
 * 连接、真的 500、真的渲染异常，都要让用例红。所以过滤只能是**窄匹配**——按具体的
 * 路径前缀点名豁免，而不是按状态码或错误类型笼统放过。
 *
 * 被豁免的只有三个路径，且只豁免 502 与 chunked 截断这两类：
 *
 *   1. `/dsh-group-chat/api/`     群聊插件自己的接口（`me` / `preferences` / `rooms`）
 *   2. `/sidebar/api/session.phase`、`/sidebar/api/session.cwd`
 *                                 sidecar 的会话相位探测
 *   3. `/plugins/events`          插件清单的 SSE/长轮询连接
 *
 * 它们与本用例要验的四条用户可见结果无关，且都在 iframe 重挂载的瞬间被网关掐断。
 *
 * ⚠️ 反过来必须守住的：`/knowledge-base/api/` 是**本插件自己**的路由。实测里它在同一次
 * 抖动中也回过 502——那条绝不能被当成噪声吞掉，否则「知识库设置读不出来」会被静默放行。
 * 所以下面的匹配用 `startsWith` 精确到前缀，并且 `/knowledge-base/` 不在名单里。
 *
 * 每忽略一条都要 `console.log` 一行，让跑测试的人看得见「一共吞了几条、吞的是什么」。
 * 静默过滤比不过滤更危险：它把「我没看见」伪装成「没有问题」。
 */

/** 允许豁免的路径前缀，逐条点名。给一个明确的名字，便于日志与评审。 */
const NOISE_PATHS = [
  '/dsh-group-chat/api/',
  '/sidebar/api/session.phase',
  '/sidebar/api/session.cwd',
  '/plugins/events',
]

/**
 * 从一条问题描述里取出它指向的路径。
 *
 * `observePage` 产出的字符串形如 `label 类别: <url> <细节>`，URL 在 `http://host:port/…`
 * 里。取 pathname 就够了；取不到就返回空串，调用方据此判为「无法定位 → 不算噪声」。
 * @param {string} problem 一条浏览器或网络问题。
 * @returns {string} 路径，取不到时为空串。
 */
function pathOf(problem) {
  const match = problem.match(/https?:\/\/[^/\s]+(\/[^\s]*)?/u)
  if (match === null) return ''
  return match[1] ?? '/'
}

/*
 * ── 另一组：浏览器/渲染层的环境事实（与上面的传输噪声分开，理由不同）──────────────
 *
 * 这三类不是「某个接口失败了」，而是**这台无头浏览器本身**的行为，任何页面都会出现，
 * 与本次要验的 UI 无关：
 *
 *   - `net::ERR_ABORTED`          页面/iframe 导航时浏览器撤销自己还在飞的请求
 *   - `net::ERR_NETWORK_CHANGED`  iframe 重挂载时网络栈换栈的统一报错
 *   - `GPU stall due to ReadPixels`
 *                                 Xvfb 无 GPU，Chrome 走软渲染的性能提示
 *
 * 它们与 `knowledge-base.spec.mjs` 同口径。注意这三条与 502 的区别：502 是**服务端
 * 真的答了错误**，只是错在别的插件；这三条是浏览器在正常导航语义下的产物，服务端
 * 没有出错。所以分开写，判据也分开。
 */
const AMBIENT_BROWSER_FACTS = [
  'net::ERR_ABORTED',
  'net::ERR_NETWORK_CHANGED',
  'GPU stall due to ReadPixels',
]

/**
 * 判断一条问题是否属于上面点名的窄噪声。
 *
 * 三道闸门同时成立才算噪声：命中路径前缀、属于 502 或 chunked 截断、不是本插件的路由。
 * 任何一条不满足都返回 false，用例照常失败。
 * @param {string} problem 一条浏览器或网络问题。
 * @returns {boolean} 是否可以忽略。
 */
function isNamedTransportNoise(problem) {
  // 环境事实先判：它们与具体路径无关，是浏览器行为。
  if (AMBIENT_BROWSER_FACTS.some(fact => problem.includes(fact))) return true
  const path = pathOf(problem)
  if (path === '') return false
  // 本插件自己的路由永不豁免，哪怕它的前缀恰好被别的规则覆盖。
  if (path.startsWith('/knowledge-base/')) return false
  const onNamedPath = NOISE_PATHS.some(prefix => path.startsWith(prefix))
  if (!onNamedPath) return false
  const isChunked = problem.includes('net::ERR_INCOMPLETE_CHUNKED_ENCODING')
  // 502 有两种写法：`observePage` 记响应时写 `HTTP 502:`，浏览器为同一个响应记的
  // 控制台回声则写 `status of 502 (Bad Gateway)`。两种都要认，否则回声漏网。
  const is502 = problem.includes('HTTP 502') || problem.includes('status of 502')
  if (!isChunked && !is502) return false
  return true
}

/** 已经打印过的噪声，避免同一条重连日志刷屏。 */
const reportedNoise = new Set()

/**
 * 过滤噪声，并把每一条忽略显式打印出来。
 *
 * @param {string[]} problems 收集到的问题。
 * @returns {string[]} 仍然必须让用例失败的问题。
 */
function realProblems(problems) {
  return problems.filter((problem) => {
    if (isNamedTransportNoise(problem)) {
      const path = pathOf(problem)
      const reason = problem.includes('GPU stall due to ReadPixels') ? 'Xvfb 软渲染提示'
        : problem.includes('net::ERR_ABORTED') ? '导航取消请求'
          : problem.includes('net::ERR_NETWORK_CHANGED') ? 'iframe 重挂载换栈'
            : problem.includes('net::ERR_INCOMPLETE_CHUNKED_ENCODING') ? 'chunked 截断'
              : 'HTTP 502'
      const key = path + ' ' + reason
      if (!reportedNoise.has(key)) {
        reportedNoise.add(key)
        console.log('已忽略噪声：' + path + ' ' + reason)
      }
      return false
    }
    return true
  })
}

/** 断言没有真实（非环境噪声）的浏览器或网络故障。 */
function expectNoProblems(problems) {
  // 只放过上面点名的三类传输噪声，其余一律失败；被忽略的每一条都已经在
  // `realProblems` 里 console.log 过，跑测试的人能看见吞了什么。
  expect(realProblems(problems)).toEqual([])
}

/**
 * 从门户进入「设置 → 知识库」分节，返回知识库分节的定位器。
 *
 * 登录与进入知识库复用共用封装；这里只补「怎么点到设置里的知识库」这一段——
 * 全局设置的入口在 DSH 外壳的侧边栏，而分节在弹窗左栏，两者都是工作台 frame 里的元素。
 *
 * 判据落在分节自己的控件上（存储模式单选组），而不是「弹窗出现了」：弹窗会先渲染
 * 骨架再注入各插件分节，只等弹窗会读到一片空白。
 *
 * @param {import('playwright/test').Page} page 页面。
 * @param {import('playwright/test').Frame} frame DSH 框架。
 * @returns {Promise<import('playwright/test').Frame>} 同一个 frame，分节已就绪。
 */
async function openKnowledgeSettings(page, frame) {
  // 设置入口是外壳侧边栏的按钮。它可能因为侧边栏折叠而不可见，先确保展开。
  const openSettings = async () => {
    const button = frame.getByRole('button', { name: /^(设置|Settings)$/u }).first()
    if (!(await button.isVisible().catch(() => false))) {
      const expand = frame.getByRole('button', { name: /展开侧边栏|Expand sidebar/u }).first()
      if (await expand.isVisible().catch(() => false)) await expand.click()
    }
    await expect(button).toBeVisible({ timeout: 25_000 })
    await button.click()
  }

  await openSettings()

  // 弹窗左栏的「知识库」分节项。工作台里「知识库」出现多次（侧边栏入口、页面标题、
  // 设置分节项），取最后一个：分节项在弹窗内，是 DOM 顺序里最后注入的一处。
  const sectionItem = frame.getByText('知识库', { exact: true }).last()
  await expect(sectionItem).toBeVisible({ timeout: 25_000 })
  await sectionItem.click()

  // 分节的真实就绪信号：存储模式的单选组。它是这一节第一个控件，出现即说明分节挂载完。
  const modeGroup = frame.getByRole('radiogroup', { name: '存储' })
  await expect(modeGroup).toBeVisible({ timeout: 25_000 })
  return frame
}

test('设置里的知识库分节：被划掉的解释文字都不再出现', async ({ page }) => {
  const problems = []
  observePage(page, '知识库设置', problems)
  const frame = await enterKnowledgeBase(page)
  await openKnowledgeSettings(page, frame)

  // 逐句断言不存在。用 count() === 0 而不是 not.toBeVisible()：后者会在元素根本不存在时
  // 也通过，但语义模糊；0 个节点才是「这行文案已经不在页面上」的精确表述。
  const body = await frame.evaluate(() => document.body?.innerText ?? '')
  for (const copy of STRUCK_OUT_COPY) {
    expect(await frame.getByText(copy, { exact: false }).count(), `不该再出现解释文案：${copy}`).toBe(0)
    expect(body, `页面正文里不该再有：${copy}`).not.toContain(copy)
  }

  // 反向对照：控件本身必须还在。只删文案却连控件一起删掉，是另一种失败。
  await expect(frame.getByRole('radiogroup', { name: '存储' })).toBeVisible()
  await expect(frame.getByRole('radio', { name: '本地' })).toBeVisible()

  expectNoProblems(problems)
})

test('设置里的知识库分节：整块只有一个保存按钮', async ({ page }) => {
  const problems = []
  observePage(page, '知识库设置-保存', problems)
  const frame = await enterKnowledgeBase(page)
  await openKnowledgeSettings(page, frame)

  // 同屏曾有两个「保存」——存储模式一个、MinerU 一个，用户认为重复。
  // 合并后整节只允许一个。用 role=button 精确匹配而不是按文字包含：「保存设置」之类
  // 的文案会误伤，而这里要的是数量断言。
  const saveButtons = frame.getByRole('button', { name: /^(保存|Save)$/u })
  await expect(saveButtons).toHaveCount(1, { timeout: 25_000 })

  // 那一个必须是可点的真实控件，不是禁用占位。
  await expect(saveButtons.first()).toBeEnabled()

  expectNoProblems(problems)
})

test('设置里的知识库分节：MinerU 输入框回填推导地址而不是空白', async ({ page }) => {
  const problems = []
  observePage(page, '知识库设置-MinerU', problems)
  const frame = await enterKnowledgeBase(page)
  await openKnowledgeSettings(page, frame)

  const field = frame.locator('#kb-mineru-base-url')
  await expect(field).toBeVisible({ timeout: 25_000 })

  // 核心断言：为空就是这一轮要修的缺陷。用 toHaveValue + 正则一起卡住「非空」和
  // 「形如 http(s) 地址」两件事，避免只满足了其中一件。
  await expect(field).not.toHaveValue('')
  await expect(field).toHaveValue(/^https?:\/\/.+/u)

  // 值来自推导还是显式配置，页面必须说清楚——否则读者会以为推导值是自己存过的地址。
  const derived = frame.getByText(/当前按.*端口推导/u)
  const explicit = frame.getByText(/使用上面填写的地址/u)
  expect(await derived.count() + await explicit.count(), 'MinerU 来源状态必须给出一种说明').toBeGreaterThan(0)

  expectNoProblems(problems)
})

test('设置里的知识库分节：本地模式不渲染部署块，也不留悬空标题', async ({ page }) => {
  const problems = []
  observePage(page, '知识库设置-部署', problems)
  const frame = await enterKnowledgeBase(page)
  await openKnowledgeSettings(page, frame)

  // 前提确认：当前是本地模式。远程模式下部署块应当出现，那一条不在本用例范围内。
  const local = frame.getByRole('radio', { name: '本地' })
  await expect(local).toBeVisible()
  expect(await local.isChecked(), '本用例断言的是本地模式的形态').toBe(true)

  // 删掉解释文字后，本地分支若还画标题就只剩一个孤零零的「部署」。
  // 两种都不允许：旧的说明块、以及新的悬空标题。
  await expect(frame.locator('[data-testid="kb-deploy-local-note"]')).toHaveCount(0)

  // 「部署」这个词只能作为标题出现；本地模式下连标题都不该有。
  // 用 heading 定位，避免误伤「远程部署」这类正文里可能出现的词。
  const deployHeading = frame.getByRole('heading', { name: /^(部署|Deployment)$/u })
  await expect(deployHeading).toHaveCount(0)

  expectNoProblems(problems)
})
