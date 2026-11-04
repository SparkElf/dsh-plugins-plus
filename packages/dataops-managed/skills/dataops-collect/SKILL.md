---
name: dataops-collect
description: 把表格 / Excel / CSV 建成可问数的数据资源，或把新表格追加到已有资源时使用。包含新建与追加的分岔、计划确认、建表写入、权限入口和结果汇报；确认计划前绝不建表。
---

# 数据采集（AI 建资源）

用户把一份表格交给 AI，AI 解析、出计划、用户确认后建表写数，最后得到一个能问数的资源。第一版只做一次性导入；一个会话一份文件、一个目标资源。

## 一、什么时候用

用户表达下面任一意图时使用本技能：

- 把这份表格建成能问数的资源
- 这个 Excel 帮我导进来
- 上传个表能问数吗
- 把这份数据加到已有的那个资源里
- 追加到 XX 资源
- 新建一个数据资源
- 表格导入 / 导入成表 / 建成资源
- 把 CSV 变成能查的表 / 能问数的表
- 这份数据帮我入库 / 建表
- 把这个 sheet 建成资源
- 这个表以后能用来问数吗
- 把这份销售表导入
- 把这份名单建成资源
- 加到门店销售明细里
- 追加一份月度数据
- 建个新资源，用这个文件
- 导入到数据中台
- 这个文件能建成资源吗
- 把附件建成资源
- 用这个表格建一张表

不适用：纯问数、取数、查数据（用 `dataops-query`）；只讨论表结构但不导入。

## 二、四个硬规则

1. **一次会话一份文件、一个目标资源。** 多文件批量不做。
2. **有引用 = 追加；无引用 = 先问，不默认新建。** 用户话里已经说清“新建”或“追加”的，跳过这一问；没说清又没引用，必须先出「新建资源 / 选择已有资源」二选一，不能直接出新建计划。
3. **计划确认是唯一硬闸。** 用户明确回复「确认」「开始吧」「可以」等之前，绝不调用 `dataops_collect_execute`，绝不建表、绝不写数。预览和计划工具本身不建表，可以放心调用。
4. **执行走原生工具流。** 不要自己造执行卡、进度卡；工具参数、结果、耗时、失败原因都在原生工具卡里。你只在旁边说人话。
5. **汇报不是交互。** 计划、结果、候选项用表格 + 文字说，不要生成按钮/表单；确认靠用户回一句话。

## 三、主流程

### 1. 找到文件

从当前消息的附件 / 系统上下文里取得表格在工作区的路径（通常是 `/workspace/...` 或 `temp/conversations/.../attachments/...`）。没有路径时，不要猜目录、不要扫全工作区；直接说“请把表格拖进输入框，或点输入框的 + 上传”，并给一个内联上传提示。

### 2. 预览，不要建表

调用：

`dataops_collect_preview({ file_path })`

返回 `sessionId`、`preview`、`dataSources`。用大白话复述：

> 看了下，明细 sheet 共 12,000 行、18 列；表头在第 2 行。我先按明细建资源。

文件读不出来也在这里说清楚：

> 这个 xlsx 读不出来，可能加密了。你换个文件，或者告诉我表头在第几行。

### 3. 先定去向

- 当前会话里有 `resource-ref` 引用块 → 追加到该资源；
- 用户说“新建 / 建个新资源 / 不要加到已有的” → 新建；
- 用户说“追加 / 加到 / 并到 / 合到” → 追加；没有具体资源时先让用户选；
- 都没有 → 用文字问一句「新建资源，还是追加到已有资源？」。选择已有资源时，调用 `dataops_collect_resources({ query, limit: 8 })`，用编号清单列最多 8 个候选（资源名、表名、行数），用户回序号或名字即可。
- `preview` 返回多个数据源时也一样：编号文字清单（名称 + 库名 + 一句适合放什么），用户回序号即可。
- 上面两处都不要调用提问工具（`ask_user_question`）出选项卡，也不要出 GenUI 选择卡：文字问、文字答。

### 4. 生成计划，不要执行

调用：

`dataops_collect_plan({ session_id, data_source_urn, target_schema?, target_table? })`

- 不传 `target_table` = 新建表（CREATE_TABLE）；
- 传 `target_schema` + `target_table` = 追加到已有表（EXISTING_TABLE）。

返回后检查 `plan`：
- 新建表：`plan.mode === 'CREATE_TABLE'`，有 `plan.createTable`、`plan.createSql`；
- 追加：`plan.mode === 'EXISTING_TABLE'`，有 `plan.mappings`，并在计划里多一行映射摘要（匹配 N 个字段、新增 N 个、N 个类型不兼容）。

### 5. 汇报计划

导入计划用 GenUI 的表格 + 文字汇报，不要生成按钮/表单。确认靠用户回一句话。

> 看了下，明细 sheet 共 <行数> 行、<列数> 列；我打算建成资源「<资源名>」，写到 `<schema>.<table>`，默认仅自己可见。

```dsh-ui
{"title":"导入计划","items":[{"type":"keyvalue","pairs":[{"key":"去向","value":"新建资源"},{"key":"导入数据源","value":"<数据源名>"}]},{"type":"table","columns":["原表头","目标字段","类型"],"rows":[["<原表头1>","<目标字段1>","<类型1>"],["<原表头2>","<目标字段2>","⚠️ 需确认"]]}]}
```

确认无误请回复「确认」或「开始吧」；要改表名、类型或资源名，直接说，我会重新出计划，不会执行。卡片 JSON 写不出来就直接发上面的文字，不要重试。

### 6. 执行

用户明确回复「确认」「开始吧」「可以」后，使用计划里展示、用户确认过的资源名/目标表/描述调用：

`dataops_collect_execute({ session_id, data_source_urn, mode, target_schema?, target_table?, create_plan_json, mappings_json, resource_name, resource_description, resource_tags?, ai_visible?, access_level? })`

- `mode` 用 `plan.mode`；
- 新建表：`create_plan_json` 传 `JSON.stringify(plan.createTable)`，`mappings_json` 传 `"[]"`；
- 追加：`mappings_json` 传 `JSON.stringify(plan.mappings)`；
- `resource_name` 用计划里展示、用户确认过的资源名；
- `access_level` 默认 `PRIVATE`；`ai_visible` 默认 `true`。

执行期间只说阶段小结，例如：

> 表建好了。现在写数据，一万两千行，估计一两分钟。
>
> 写完了，正在生成字段说明。

失败只说三类，并给一个动作：
- 文件问题 → 重新上传 / 告诉我表头在第几行；
- 字段问题 → 调整映射 / 改类型；
- 系统问题 → 重试。

### 7. 汇报结果 + 打开资源页签

执行成功后：

1. 调用 `dataops_open_resource_tab({ resource_id, resource_name, mode: 'focus' })`，让右侧栏自动打开 `dataops-resources` 页签并定位新资源；
2. 用表格 + 文字汇报资源名、目标表、行数、字段数、「已可问数」、可见范围（默认「仅自己可见」），并说明接下来可以回「分配权限」「问数」「详情」「操作记录」。不要生成按钮/表单。

用户接着说哪个，就做哪个：

- 分配权限 → `dataops_open_resource_tab({ resource_id, mode: 'grant' })`，侧栏资源卡定位并自动打开授权弹窗；
- 去问数 → 不要跳页，直接在对话里给 2-3 个可以问的问题示例，并说明资源已可被检索；
- 查看详情 → `dataops_open_resource_tab({ resource_id, mode: 'detail' })`；
- 查看操作记录 → `dataops_open_resource_tab({ resource_id, mode: 'audit' })`。

## 四、引用资源（追加）

引用可能来自输入框的资源 chip，也可能来自右侧栏资源卡的「添加到对话」。如果引用以结构化块出现，形如：

```resource-ref
{"kind":"dataops-resource","resourceId":123,"name":"门店销售明细","table":"dwd_store_sales"}
```

就把它当作本次追加目标，不要再问“新建还是追加”。如果用户在上传文件之前先引用了资源，直接按追加处理。

如果「添加到对话」降级成发送一条消息，消息里必须带这个 `resource-ref` 块；没有结构化块时，按“用户口头提到资源名”处理，先用 `dataops_collect_resources` 找到资源再确认，不要凭名字猜 id。

## 五、边界

- 不做定时采集、增量水位、失败重试策略；
- 不做多文件批量、文件夹上传；
- 不做覆盖（只追加）；
- 不在对话里做权限表单（GenUI 没有人员选择器）；
- 不在 DSH 里做审计弹窗；操作记录在 DataOps 资源详情 / 系统审计。