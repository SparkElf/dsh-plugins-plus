# Univer 政府文档

先加载 `univer`，再加载 `univer-doc`。本 Skill 只补充政府文档模板与编辑规则；继续使用 `univer_new`、`univer_status`、`univer_worktree`、`univer_execute`、`univer_inspect`、`univer_screenshot` 和 `univer_export`，不存在政府文档专用 Tool。

## 模板

Skill 的 `resourceBase.path` 是本包根目录。把下列路径拼到该目录后传给 `univer_new.templateFile`：

- `assets/templates/general-government-v2.univer`：通用政务文档，以显式段落格式样板为主。
- `assets/templates/official-redhead-v4.univer`：正式红头文档，以固定占位锚点、红线和页内结构为主。

创建目标文件后调用 `univer_status` 读取 Doc Unit ID，再创建一个 draft worktree。两份模板都是 Traditional Doc；编辑前用 `doc.isTraditional()` 确认，不要把 Modern Doc 用空行模拟成分页文档。在同一 draft worktree 中完成全部编辑、检查、截图和导出，不需要为每次修改创建 worktree。

## GB/T 9704-2012 基线

两份模板按 A4、版心约 156 mm × 225 mm、上白边约 37 mm、左白边约 28 mm 建立页面几何。公文标题使用二号小标宋，正文使用三号仿宋，一级标题使用三号黑体，二级标题使用三号楷体，三级标题使用三号仿宋加粗，版记使用约四号仿宋。

## 通用政务文档

模板已经提供标题、副标题、一级标题、二级标题、三级标题、正文、附件和落款等显式格式样板。优先按占位文本找到段落并调用 `setText`；替换文字不会移除既有段落格式。

新增同类段落时，从最近的同角色模板段落读取 `paragraph.getInfo().paragraph.paragraphStyle`，再把该格式传给新段落的 `setStyle`。不要把标题、正文、落款全部重设成同一种格式，也不要依赖空格和空行控制版式。

## 正式红头文档

红头模板的主要锚点是：

- `【发文机关全称】文件`
- `【机关代字】〔【年份】〕【序号】号`
- `【公文标题第一行】`
- `【公文标题第二行（可删除）】`
- `【主送机关】：`
- `【发文机关全称】`
- `【成文日期】`
- `抄送：【抄送机关】。`
- `【发文机关办公室】    【印发日期】印发`

按完整占位文本定位并替换锚点，保留红色机关标志、文号下红线、版记上下边线和段落顺序。红色机关标志必须完整保持单行；机关名称更长时应在该段落上等比例减小字号，不能让“文件”或单个汉字另起一行。标题第二行不需要时可删除该段落；不要重建整个页头来修改一个字段。正文层级可复制模板中的一级标题、二级标题和正文样式。

## 字体与页码限制

插件随包提供已获授权的 `方正小标宋简体`、`FangSong_GB2312`、`KaiTi_GB2312` 和 `SimHei` 字体文件。模板直接引用这些准确 family；目标运行环境必须加载这些字体后再进行版式验收，不能接受 Arial、DejaVu 或 Noto 回退。

当前公开 Facade 没有经过验证的动态当前页码或总页数字段。模板不伪造动态页码；如交付要求自动页码，应明确报告这一能力缺口。静态输入“第 1 页”不算动态页码合规。

## 验证与交付

1. `univer_inspect` 读取段落文本与结构。
2. 用只读 `univer_execute` 核对 `doc.isTraditional()`、段落样式、section 和页面设置。
3. `univer_screenshot` 渲染并检查每一页的换行、分页、红线和版记。
4. 需要 Word 文件时，从同一 draft worktree 调用 `univer_export` 输出 DOCX。
5. 验证完成后可以保留 draft 供审阅；仅在明确需要交接状态时标记为 `ready`。本流程不要求 merge 或 discard。
