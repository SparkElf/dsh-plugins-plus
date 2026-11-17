---
name: office-government-docs
description: Create and revise Chinese government DOCX, XLSX, and PPTX originals with OfficeCLI. Use for government-document hierarchy, page layout, redhead composition, official fonts, black headings, GB/T 9704-2012 style packs, validation, and clickable original-file delivery.
---

# OfficeCLI 政务文档

用于创建、修改和验收中文政务 `.docx`、`.xlsx`、`.pptx` 原件。调用 `officecli` / `officecli-create`；编辑 DOCX/XLSX/PPTX 前分别用 `load_skill word`、`load_skill excel`、`load_skill pptx` 取得当前说明，再按需调用 `help <format> <element> --json`。不得改走 Univer、Host 渲染或中间 HTML/PNG 预览产物。

## 文件合同

- OfficeCLI 直接写最终 Office 原件；所有后续修改继续针对同一路径。
- 工具命令中的文件路径使用当前 workspace 内绝对路径，避免 MCP 进程工作目录歧义。
- 不用另一个格式冒充预览文件，不创建 `.univer`。
- 完成回复必须单列原件绝对路径，例如：`产物：/workspace/材料/通知.docx`。该路径由聊天文件链接和 Better Sidebar 直接打开。

## 创建：必须用样式包包装器

OfficeCLI 本身**没有**全局样式包、默认模板或 `config` 切换入口：`create` 只生成 Word 基线（Normal，Heading 样式未定义或为 Word 蓝色），`merge` 只替换 `{{占位符}}`，`style` 只改当前文档的 `/styles`。因此本项目用「模板 DOCX + 包装器」提供默认版式：

- 创建 DOCX 一律调用 `officecli-create`，不要用裸 `officecli create`。
- 默认样式包：`gbt9704-2012`（《党政机关公文格式》GB/T 9704-2012），普通 Word 文档与政务文档都默认使用。
- 红头文件：`officecli-create <文件> --style-pack red-header`。
- 用户提供模板、单位现行规范或明确版式要求时，直接编辑用户原件，不套用样式包；但仍须保证标题为黑色。
- `.xlsx` / `.pptx` 仍用 `officecli create`；只有显式 `--minimal` 的 DOCX 才走 OfficeCLI 原始基线（仅用于格式边界测试）。

工具参数：`file` 必填；`style_pack` 默认 `gbt9704-2012`；`force` 覆盖已有文件；`list` 列出已安装样式包。命令行等价形式：`officecli-create <文件> [--style-pack <name>] [--force]`。

## GB/T 9704-2012 基线（gbt9704-2012 模板已内置）

正式公文默认 A4；版心约 156 mm x 225 mm；上白边 37 mm，下白边 35 mm，左白边 28 mm，右白边 26 mm；每页 22 行、每行 28 字。

- 公文标题：二号方正小标宋简体（22 pt），居中，黑色。
- 正文：三号仿宋_GB2312（16 pt），固定行距 28.9 pt，首行缩进 2 字。
- 一级标题：三号黑体（16 pt）。
- 二级标题：三号楷体_GB2312（16 pt）。
- 三级标题：三号仿宋_GB2312（16 pt）加粗。
- 版记：约四号仿宋_GB2312（14 pt）。
- 页码：四号宋体（14 pt），数字左右各一条一字线（`— 1 —`）；单页码居右、双页码居左。

模板内已定义 `Title`、`Heading1`–`Heading6`，其 `w:color` 全部为 `000000`。正文层级直接用这些 style id，不要再用空格、空行或手工属性模拟缩进、段距和分页。

## 标题颜色铁律

- 所有标题、副标题、公文标题的 run/style 颜色必须是黑色 `000000`；未显式设置时也必须继承黑色。
- 禁止 `w:themeColor`、`accent1`、`2F5496`、`365F91`、`1F4E79` 等 Word 主题蓝。Word 的 Heading 1 默认就是 accent1 蓝，这正是本样式包要消除的问题。
- 用户模板已有蓝色标题时，先改成黑色再交付；不要只在预览里看起来是黑色就通过。
- 禁止对任意既有文档做批量 XML 后处理；修复应落在创建入口（模板/包装器）或该文档自己的 `/styles`。

## 通用政务文档

先确认样式包中的标题、副标题、一级标题、二级标题、三级标题、正文、附件和落款角色，再写内容。相同角色复用同一 style。

正文层级、附件说明、落款与日期分别建段落。表格使用真实单元格合并、边框、列宽和段落样式；不以文本空格拼表格。

## 正式红头文档

1. 用 `--style-pack red-header` 创建。
2. 保持下列页内顺序：发文机关标志 → 发文字号 → 红色分隔线 → 公文标题 → 主送机关 → 正文 → 发文机关署名与成文日期 → 附注、抄送与版记。
3. `red-header` 额外提供样式：`FawenJiguan`（发文机关标志，二号方正小标宋，红色）、`FawenZihao`（发文字号，三号仿宋，居中）、`HongXian`（红色分隔线，下边框 2.25 pt 红色）、`BanJi`（版记，四号仿宋，上下黑色边框）。

发文机关标志必须完整单行；名称较长时等比例调整该段字号，不让“文件”或单个汉字另起一行。红线、版记上下边线使用真实段落边框或 shape，不使用下划线字符拼接。标题行数随内容排版，不保留无内容占位段落。

## 验收

- 内容：标题、文号、主送、正文层级、附件、落款、日期、抄送完整。
- 几何：纸张、页边距、缩进、段距、行距、表格宽度与分页符合要求；`officecli get <文件> /section[1] --json` 的 `marginTop/Bottom/Left/Right` 应为 3.7/3.5/2.8/2.6 cm。
- 字体：标题二号小标宋、正文三号仿宋、一级黑体、二级楷体、三级仿宋加粗；无回退字体造成的换行漂移。
- 颜色：`officecli raw <文件> /styles` 中不得出现 `themeColor`、`accent1` 或蓝色 `w:color`；`Heading1`–`Heading6`、`Title` 必须存在且为 `000000`。`officecli raw <文件> /document` 中标题 run 不得带非黑色 `w:color`。
- 结构：`officecli validate --json` 成功，`officecli view <文件> issues --json` 无待修问题。若只报 `Body paragraph missing first-line indent`（工具未解析 Normal 样式继承），在该段补 `firstLineIndent=32pt` 后重验。
- 交付：仅列最终 Office 原件，路径可点击并由 Better Sidebar 打开。