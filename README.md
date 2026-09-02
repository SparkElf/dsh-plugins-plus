# dsh-plugins-plus

## 中文

这是由 SparkElf 维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）独立插件仓库。这里的插件通过 profile composition bundle 安装到上游 dsh（`dsh plugin --profile <name> add <package-or-git-spec>`；每个包自行声明 Cordis 插件入口），并且不依赖 `deepseek-harness-plus` 产品分支。

### 仓库边界

- `deepseek-harness-plus` 跟踪 dsh 与 Plus 产品，并通过固定版本的 manifest 组合第三方插件。
- 本仓库保存 SparkElf 自有插件的源码，使这些插件也能直接用于原版 dsh。所有权与分发规则记录在 [Plus 插件所有权与分发决策](https://github.com/SparkElf/deepseek-harness-plus/blob/master/.agents/notes/implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md) 中。

### 插件

- `@sparkelf/dsh-plugin-ping`：提供 `/ping` 连通性命令；无需模型调用即可回复 `pong`。
- `@sparkelf/dsh-mobile-bridge`：完整的 Host 与 Client 插件，提供出站 E2EE 隧道、配对二维码和一等公民的“移动连接”设置页。手机端只注入连接 facade；Harness 各功能包继续拥有自己的响应式界面。
- `@sparkelf/dsh-mobile-bridge-server`：多用户盲中继，支持邮箱验证码、可选的微信身份通道、页面内相机扫码和持久手机登录，让手机通过自有服务器访问本地 Harness。
- `@sparkelf/dsh-dataops-integration`：独立DSH的完整DataOps Host + Web Client连接插件，拥有Authorization Code + PKCE、持久target、session-lifetime access credential、Settings和generic MCP组合；不修改DSH core，也不在DataOps托管容器中挂载。
- `@sparkelf/dsh-dataops-managed`：DataOps托管workspace的JWT与HTTP MCP插件；复用当前DataOps会话权限，不发起OAuth，也不提供连接或断开操作。
- `@sparkelf/dsh-chart`：完整的 Host + Web Client 交互图表 capability。Host 记录可 durable replay 的完整 ECharts option，Client 在 Harness 消息流中渲染并负责 resize、主题切换和 disposal。当前为 opt-in 发布候选，不默认挂载，也不在正式发布前声明生产 npm pin。
- `@sparkelf/dsh-query-result-analysis`：有界分页、checkpoint和hierarchical reduction的独立DataOps query-result分析插件；每个模型批次和归并进入持久DSH子会话，由普通AgentLoop记录模型可见内容并拥有重试。
- `@sparkelf/dsh-univer-government-docs`：依赖 `dsh-univer-office` 的政府文档资产与 Skill 插件，注册通用政务和正式红头两份原生 Traditional `.univer` 模板，不新增模型 Tool。
- `@sparkelf/dsh-plugin-supervisor`：独立的 Plus runtime Supervisor，提供 Host Session捕获/恢复入口、`dsh-plus-supervisor` Node executable、local command socket和进度页；不依赖 Plus fork源码。

### CI / CD

- CI（`ci.yml`）：每次 push 和 PR 都执行 pnpm install、`tsc --noEmit`、Vitest 单元测试和可发布制品构建。
- CD（`publish.yml`）：`v*` tag 触发后，重新执行 typecheck、测试和构建，再使用 `NPM_TOKEN` secret 将包发布到 npm。
- UI 系统测试只断言可操作交互和可见状态变化；间距、对齐、像素几何、计算样式和截图由人在目标视口审查，截图不作通过条件。真实DataOps取数、分析、图表和刷新回放用例要求已配置且已连接的profile及显式业务prompt/marker；缺少输入时只记为skip，不作为验收通过。

### 添加插件

1. 创建 `packages/<name>`，按照 Cordis 插件模式实现 `name`、`inject` 和 `apply`；上游 dsh 的 `@deepseek-ai/dsh-command-compact` 可作为参考。
2. 在包旁添加不需要密钥的单元测试。
3. 插件不得依赖 `deepseek-harness-plus`；只能依赖已发布的上游包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`）。
4. 更新包版本，并通过 `v<repo-version>` tag 发布。
5. 根文档和面向用户的包 README 必须在同一 `README.md` 中维护“中文”和“English”两个对应章节，内容变更时同步更新。

## English

This repository contains independent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins maintained by SparkElf. The plugins install into upstream dsh through profile composition bundles (`dsh plugin --profile <name> add <package-or-git-spec>`; each package declares its own Cordis plugin entry) and never depend on the `deepseek-harness-plus` product fork.

### Repository boundaries

- `deepseek-harness-plus` tracks dsh and the Plus product, and composes third-party plugins through a version-pinned manifest.
- This repository owns the source of SparkElf plugins so they remain usable with vanilla dsh. The ownership and distribution rules are recorded in the [Plus plugin ownership and distribution decision](https://github.com/SparkElf/deepseek-harness-plus/blob/master/.agents/notes/implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md).

### Plugins

- `@sparkelf/dsh-plugin-ping`: provides the `/ping` connectivity command and replies with `pong` without a model call.
- `@sparkelf/dsh-mobile-bridge`: a complete Host and Client plugin providing an outbound E2EE tunnel, pairing QR, and first-class Mobile Bridge settings section. The phone injects only the connection facade; each Harness package retains ownership of its responsive UI.
- `@sparkelf/dsh-mobile-bridge-server`: a multi-user blind relay with email-code and optional WeChat identity channels, in-page camera scanning, and persistent phone sign-in, allowing phones to reach a local Harness through a self-hosted server.
- `@sparkelf/dsh-dataops-integration`: the complete Host + Web Client DataOps connection plugin for standalone DSH. It owns Authorization Code + PKCE, a persistent target, a session-lifetime access credential, Settings, and generic MCP composition; it changes no DSH core and is not mounted in DataOps-managed containers.
- `@sparkelf/dsh-dataops-managed`: the JWT and HTTP MCP plugin for DataOps-managed workspaces. It reuses current DataOps session permissions without OAuth or connect/disconnect controls.
- `@sparkelf/dsh-chart`: a complete Host + Web Client interactive-chart capability. The Host records a complete ECharts option for durable replay; the Client renders it in the Harness conversation and owns resize, theme changes, and disposal. It is currently an opt-in release candidate, is not mounted by default, and does not claim a production npm pin before an actual release exists.
- `@sparkelf/dsh-query-result-analysis`: an independent DataOps query-result analysis plugin with bounded paging, checkpoints, and hierarchical reduction. Each model batch and reduction runs in a durable DSH child session whose normal AgentLoop logs model-visible content and owns retry.
- `@sparkelf/dsh-univer-government-docs`: government-document assets and a Skill plugin for `dsh-univer-office`. It registers native Traditional `.univer` templates for general government and official redhead documents without adding a model-facing Tool.
- `@sparkelf/dsh-plugin-supervisor`: an independent Plus runtime Supervisor containing the Host Session capture/recovery entry, `dsh-plus-supervisor` Node executable, local command socket, and progress page without depending on Plus fork source.

### CI / CD

- CI (`ci.yml`): runs pnpm install, `tsc --noEmit`, Vitest unit tests, and publishable artifact builds on every push and PR.
- CD (`publish.yml`): on `v*` tags, repeats typecheck, tests, and builds before publishing packages to npm with the `NPM_TOKEN` secret.
- UI system tests assert only operable interactions and visible state changes. Humans review spacing, alignment, pixel geometry, computed CSS, and screenshots at target viewports; screenshots are not pass criteria. The real DataOps query, analysis, chart, and reload-replay case requires a configured connected profile plus explicit business prompt/markers; missing inputs produce only a skip and never acceptance evidence.

### Adding a plugin

1. Create `packages/<name>` and implement `name`, `inject`, and `apply` following the Cordis plugin pattern; upstream dsh's `@deepseek-ai/dsh-command-compact` is the reference.
2. Add keyless unit tests beside the package.
3. Keep the plugin independent of `deepseek-harness-plus`; depend only on published upstream packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-*`).
4. Bump the package version and publish through a `v<repo-version>` tag.
5. Root-facing and user-facing package documentation must keep matching “中文” and “English” sections in the same `README.md`, updated together whenever the content changes.
