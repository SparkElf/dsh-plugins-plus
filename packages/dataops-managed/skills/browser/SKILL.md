---
name: browser
description: 浏览器自动化总入口。默认用工作区 Playwright headless 抓取网页/大屏；只有用户明确要求“本地浏览器/已登录 Chrome/companion”才使用 Browser Bridge。账号密码登录走凭据插件，不强制 Companion。
---

# Browser

## 先选模式

```text
默认：headless
只有用户明确要求本地浏览器 → companion
```

| 用户意图 | 模式 |
|---|---|
| “抓取这个大屏/网页/表格” | headless |
| 给了账号密码 | headless + 凭据插件 |
| “用我电脑上的浏览器” | companion |
| “用我已经登录的 Chrome” | companion |
| “用 companion” | companion |

Agent 不得自行切 companion；需要时先询问。

## Headless

先读 `browser-headless` 技能，然后：

1. 写 Playwright 脚本；
2. 用工作区 Chromium 运行；
3. 产出 `result.json` + `screenshot.png`；
4. 校验数据条数/字段/接口状态。

## Companion

只有用户明确要求本地浏览器时：

1. 先 `browser_bridge_status`；
2. 未连接则 `browser_bridge_connect`；
3. 用 `browser_navigate` / `browser_snapshot` 等现有工具；
4. 不要用 headless 脚本冒充 companion。

## 凭据

- 账号密码存凭据插件，Agent 只拿 `secretRef`；
- 密码不得出现在 prompt、脚本、日志、截图；
- headless 通过环境变量/secretRef 登录；
- 登录失败先询问，不自动切 companion。

## 安全

- 只访问用户明确给出的域名；
- 禁止 localhost、127.0.0.1、169.254.169.254、内网管理端口；
- 并发 1，默认超时 60s；
- 不持久化 cookie；
- 提交/下单/删除/发布前必须用户确认。

## 输出

- `result.json`：数据、来源 URL、抓取时间；
- `screenshot.png`：关键页面；
- 摘要：条数、字段、异常；
- 不以“点击成功”作为成功判据。

## 相关技能

- `browser-headless`：默认 headless 实现；
- `browser-cdp-automation`：接管真实 Chrome/CDP；
- `browser-bridge-companion`：Companion 工具；
- `browser-bridge-chrome-install`：Companion 安装。