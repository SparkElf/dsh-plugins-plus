# @sparkelf/dsh-officecli

## 中文

将官方 OfficeCLI 二进制接入 DeepSeek Harness。安装本包会安装固定版本的 `@officecli/officecli`，模型通过 `officecli` 工具提交结构化 argv；新增的 `officecli-create` 工具从样式包模板创建 DOCX。

适配器只在 `create` 上增加一层默认版式：`.docx` 默认复制 `gbt9704-2012` 样式包（GB/T 9704-2012 页边距、三号仿宋正文、二号小标宋标题、黑色 Heading 1–6/Title、22 行网格、奇偶页码），`--style-pack <name>` 切换（如 `red-header`），`--minimal` 保留官方原始基线。其余命令仍原样交给官方二进制并返回 stdout/stderr。OfficeCLI 本身没有全局样式包或默认模板开关，因此样式包是“模板 DOCX + create 包装器”，默认目录 `/opt/officecli/style-packs`（可用 `OFFICECLI_STYLE_PACKS_DIR` 覆盖）。

OfficeCLI 仍直接读取和写入 workspace 内原始 `.docx`、`.xlsx`、`.pptx`。本包不渲染预览、不生成中间格式。文档完成后，回复中的原件路径由 Better Sidebar 打开。

## English

This package connects the official OfficeCLI binary to DeepSeek Harness. Installing it brings in the pinned `@officecli/officecli` package, and the model submits structured argv through the `officecli` tool; the `officecli-create` tool creates a DOCX from a style-pack template.

The adapter adds one default to `create`: a `.docx` copies the `gbt9704-2012` style pack (GB/T 9704-2012 margins, 16 pt FangSong body, 22 pt XiaoBiaoSong title, black Heading 1–6/Title, 22-line grid, odd/even page-number footers). `--style-pack <name>` switches packs (for example `red-header`); `--minimal` keeps the official raw baseline. Every other command is passed to the official binary unchanged and its stdout/stderr is returned. OfficeCLI has no native global style-pack or default-template switch, so a pack is a template DOCX plus this create wrapper; the default directory is `/opt/officecli/style-packs` (override with `OFFICECLI_STYLE_PACKS_DIR`).

OfficeCLI still reads and writes original `.docx`, `.xlsx`, and `.pptx` files in the workspace. This package renders no preview and creates no intermediate format. Better Sidebar opens the original path returned in the final response.