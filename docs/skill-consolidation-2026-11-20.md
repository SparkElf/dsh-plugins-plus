# 技能合并与去重（2026-11-20）

## 结论

- **browser**：合并为 `dataops-managed/skills/browser/SKILL.md` + `references/{headless,bridge,chrome-install}.md`；旧的 `browser-headless`、`browser-bridge-companion`、`dataops/skills/browser-bridge-chrome-install` 已迁移并从技能目录删除。
- **knowledge-base**：仍由 `packages/knowledge-base/SKILL.md` 作为唯一入口；`kb-organize` / `kb-summarize` / `kb-vectorize` / `knowledge-graph` 的正文迁入 `packages/knowledge-base/references/`，四个旧技能目录删除。
- **memory**：合并为 `packages/knowledge-base/skills/memory/SKILL.md` + `references/{guardian,extract,sop-evaluate}.md`；三个旧技能目录删除。
- **office**：**未合并**。officecli 的 9 个技能与 `dataops/skills/{docx,pdf,ppt,xlsx}-creator` 不是同一套实现，且都被运行时/测试按名字直接引用；合并会破坏 `officecli load_skill <name>` 契约和 DataOps 内置文档技能包。审计证据见下文。
- 未提交、未推送。

## DSH 技能资源协议

核对 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-skill-filesystem`：

- 技能发现只扫描根目录下一层：`<root>/<skill>/SKILL.md` 或 `<root>/<name>.md`；技能目录内的子目录只是资源，不会成为新技能。
- 加载技能时 `renderSkillContent()` 会输出 `<skill_resources>`，其中给出 `resourceBase`（目录型技能为 `SKILL.md` 所在目录），并提示“按需加载相对路径资源”。
- 因此合并后的主 `SKILL.md` **必须显式写相对链接**，例如 `[references/headless.md](references/headless.md)`；资源目录不会被自动枚举。
- 校验脚本同时检查：frontmatter 的 `name` 为 kebab-case、`description` 非空、同一扫描范围内无重名、`references/` 下没有嵌套 `SKILL.md`、主文件的相对 `.md` 链接全部可解析。

## 文件变化

### browser（canonical：`dsh-plugins-plus/packages/dataops-managed/skills/browser/`）

新增/改写：

- `SKILL.md`：触发条件、模式选择、通用硬规则、按需加载、输出与成功判据。
- `references/headless.md`：原 `browser-headless/SKILL.md` 正文（Playwright 工作流、脚本模板、凭据、大屏抓取、失败处理）。
- `references/bridge.md`：原 `browser-bridge-companion/SKILL.md` 正文（Companion 探测、一键配对、`browser_*` 流程、安全边界、常见错误）。
- `references/chrome-install.md`：原 `dataops/skills/browser-bridge-chrome-install/SKILL.md` 正文（保留废弃提示）。
- `references/scripts/`：原 chrome-install 的 4 个脚本。
- `references/chrome-install.openai.yaml`：原 chrome-install 的 agent 元数据。

删除：

- `packages/dataops-managed/skills/browser-headless/SKILL.md`
- `packages/dataops-managed/skills/browser-bridge-companion/SKILL.md`
- `dataops/skills/browser-bridge-chrome-install/`（6 个文件）

注册与打包：

- `packages/dataops-managed/src/index.ts`：移除 `browser-bridge-companion`、`browser-headless` 两个 provider，只保留一个 `browser` provider；`resourceBase` 指向 `skills/browser/`。
- `packages/dataops-managed/package.json`：新增 `skills/browser/references/**/*`。
- `packages/dataops-managed/tests/activation.test.ts`：断言只注册一个 `browser`，并校验三个引用文件可读。

### knowledge-base（canonical：`packages/knowledge-base/`）

新增：

- `references/organize.md` ← `kb-organize`
- `references/summarize.md` ← `kb-summarize`
- `references/vectorize.md` ← `kb-vectorize`
- `references/graph.md` ← `knowledge-graph`

删除：

- `packages/knowledge-base/skills/kb-organize/`
- `packages/knowledge-base/skills/kb-summarize/`
- `packages/knowledge-base/skills/kb-vectorize/`
- `packages/knowledge-base/skills/knowledge-graph/`

注册与打包：

- `packages/knowledge-base/src/index.ts`：provider 从 7 个 candidate 收敛为 `knowledge-base` + `memory` 两个；`knowledge-base` 的 description 覆盖整理/摘要/向量化/图谱触发。
- `packages/knowledge-base/package.json`：新增 `references/**/*` 和 `skills/**/references/**/*`。
- 工具描述与提示中的 `kb-summarize` / `kb-vectorize` 改为指向 `knowledge-base` 的对应参考；更新 `README.md` 和测试。

### memory（canonical：`packages/knowledge-base/skills/memory/`）

新增：

- `SKILL.md`：触发条件、角色选择、通用硬规则、标准一轮、按需加载。
- `references/guardian.md` ← `memory-guardian`
- `references/extract.md` ← `memory-extract`
- `references/sop-evaluate.md` ← `memory-sop-evaluate`

删除：

- `packages/knowledge-base/skills/memory-extract/`
- `packages/knowledge-base/skills/memory-guardian/`
- `packages/knowledge-base/skills/memory-sop-evaluate/`

注册：

- `src/index.ts` 新增 `MEMORY_SKILL_NAME` / `memorySkillPath()`，注册单个 `memory` candidate。
- `src/guardianSession.ts`：守护会话第一步改为加载 `memory` 技能，再按指引读取 `references/guardian.md`。

### 镜像副本（DataOps 镜像）

`dataops/infra/docker-workspace/dataops-skills/` 现在只保留**翻译数据**（`<skill>/i18n/zh.json`），技能正文由已安装插件提供，不再手工维护副本；唯一例外是受保护、禁止改动的 `dataops-collect`。

- 删除重复的 `SKILL.md`：`admin-workspace-rescue`、`api-connector-authoring`、`artifact-app-authoring`、`browser`、`browser-bridge-companion`、`browser-headless`、`dataops-query`、`genui`、`kb-organize`、`kb-summarize`、`kb-vectorize`、`knowledge-graph`、`memory-extract`、`memory-guardian`、`memory-sop-evaluate`、`prefect-script-authoring`、`skill-provisioning`。
- 新增合并后的翻译：`browser/i18n/zh.json`、`knowledge-base/i18n/zh.json`、`memory/i18n/zh.json`。
- 未触碰 `dataops-collect`（另一个 agent 正在改）。
- `verify-workspace-image.mjs` 的检查从“19 个技能目录”改为“9 个 `i18n/zh.json` 翻译包”，并校验安装后的 `dataops-managed` 带有合并后的 browser 入口和两个模式参考。
- `Dockerfile.plus-cli-src` 注释改为“translation-only payload”。

## office 审计（未合并）

### officecli 的 9 个技能

- `packages/officecli/src/skills.ts` 的 `BUNDLED_SKILLS` 固定列出 `word / excel / pptx / word-form / morph-ppt / pitch-deck / academic-paper / data-dashboard / financial-model`。
- 每个名字单独注册 provider，并且 `officecli load_skill <name>` 会用同名文件回答；`packages/officecli/tests/style-packs.test.ts` 断言 `load_skill word` 返回定制文本。
- 合并成 `office/SKILL.md` 会破坏 CLI 的按名加载契约与 9 个独立 provider，属于 API 变更，不只是目录整理。

### `dataops/skills/{docx,pdf,ppt,xlsx}-creator`

- 由 `dataops/backend/src/ai/ai-builtin-workspace-skills.ts` 直接读取 `skills/<key>/SKILL.md`（`DOCX_CREATOR_KEY` 等，约 1696–1899 行），并打包 `scripts/`、`assets/`、`references/`。
- `backend/runtime-skill-packages/` 里有对应的 zip；`backend/tests/unit/ai-builtin-document-skill-packages.test.ts` 断言包内必须包含 `render_docx.py`、模板、字体等文件。
- 这套是“受限 YAML + 模板 + Python 渲染”的 DataOps 文档链路，和 officecli（原 DOCX/XLSX/PPTX CLI）不是同一实现，不能当成重复副本合并。

**结论**：office 家族保留现状；如果以后要统一，应先做一项独立的产品决策（选 officecli 还是 DataOps creator），再改运行时和测试，不能只在技能目录层合并。

## 验证

命令与结果：

```text
node scripts/validate-skills.mjs
ok: 21 skill file(s), 21 unique name(s)

vitest run packages/dataops-managed
Test Files  26 passed (26)
Tests       207 passed (207)

vitest run packages/officecli
Test Files  2 passed (2)
Tests       30 passed (30)

vitest run packages/knowledge-base/tests/memory-* tests/summary-* \
  tests/kb-outline.spec.ts tests/kb-file-tools.spec.ts tests/kb-summary-save.spec.ts
Test Files  23 passed (23)
Tests       339 passed (339)

tsc -p packages/knowledge-base/tsconfig.build.json --outDir /tmp/kb-types-check   # exit 0
tsc -p packages/dataops-managed/tsconfig.build.json --outDir /tmp/dm-types-check  # exit 0
npm pack --dry-run  # 两个包都包含 references/ 与 memory/SKILL.md
```

`packages/knowledge-base` 的完整测试套件有 64 个失败（5 个 spec 文件），在 HEAD 基线上同样失败（抽检 `knowledge-base.spec.ts`、`extraction-routes.spec.ts`、`workflow-publish-host.spec.ts` 均可在未改动时复现），与本次技能合并无关。

## 保留与后续

- `dataops/skills/browser/`、`dataops/skills/browser-headless/` 仍是 DataOps 内置工作区技能（由后端 `ai-builtin-workspace-skills.ts` 读取），不是 DSH 技能中心的条目；本次只清理了其中的悬空引用，未删除。
- `dataops/skills/dataops-collect/` 与 `dataops/infra/docker-workspace/dataops-skills/dataops-collect/` 未触碰。
- 未提交、未推送；所有改动都在工作树。