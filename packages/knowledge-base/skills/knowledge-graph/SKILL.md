---
name: knowledge-graph
description: 读写团队知识库里的知识图谱：主题卡、关系文档、四个动作和五个剧本。
---

# knowledge-graph

知识图谱是知识库的导航层，不是第二套文档库。它只有三样东西：**图谱**（一个可见文件夹）、**主题**（图谱下的可见子文件夹 + `index.md` 卡）、**关系**（`index.md` 之间的一篇文档）。

## 1. 目录长什么样

```text
<scope>/知识图谱/<graph>/
  <主题>/
    index.md                 # 主题卡：front-matter + 摘要 + 自由正文
    <document>.md            # 文档，知识库能搜、能预览、能分享
  .kg/
    links/<a>--<b>.md        # 关系文档，点开头，KB 文件树和 FTS 跳过
```

- `<scope>` 是 `global` / `department/<部门链>` / `personal/<uid>`；个人路径由 Host 解析，**不要让模型拼 uid**。
- 主题文件夹名可读、可改；关系引用 `index.md` 里的 `id`，不引用文件夹名，所以改名不断边。
- 一个图谱一条 grant，覆盖主题文档与 `.kg`；写操作走 `kg_add` / `kg_set` / `kg_del`，不要用 shell 直接写文件。

当前图谱模型同时支持 graph-json（新建图谱默认用它）：

```text
<scope>/.graphs/<graph-id>/graph.json          # 拓扑与元数据：nodes/edges + name/scope/visibility
<scope>/.graphs/<graph-id>/links/<edge-id>.md  # 可选的关系正文
<scope>/<分类>/<文档>.md                       # 节点正文，仍是普通知识库文档
```

- 节点属性（type/authority/origin/reviewStatus/tags）写在节点文档的 front matter，`graph.json` 只存 `{id,path}` 与边。
- 图谱页把每个节点投影成一张卡片；空图谱也会出现在图谱树里，加上第一个节点后画布就有内容。
- `.graphs/` 是隐藏目录，不要用文件树或 shell 直接编辑；新建用 `kg_add kind=graph`，改拓扑用 `kg_add` / `kg_set` / `kg_del`。

## 2. 主题卡与关系文档

主题卡好例子：

```markdown
---
id: task-bus
title: 任务总线
status: active
depth: 4
domain: dsh
tags: [任务, 状态机]
updated: 2026-10-31
---

# 任务总线

DSH 的跨来源任务底座，任务卡是唯一状态载体。

## 现在
v0.1 设计稿评审完，正在拆实现任务。
```

坏例子：没有 `id`（关系会指向文件夹名，改名断边）；把全部正文塞进摘要（卡片会变成一堵墙）；`status` 写成自由文本（画布只能识别 active/paused/done）。

关系文档好例子：

```markdown
---
a: task-bus
b: group-chat
label: 任务来源
updated: 2026-10-31
---

# 任务来源

群聊把讨论转成任务；任务总线承接状态，不反向写群聊。
```

坏例子：`a`/`b` 指向不存在的 id（画布会丢弃这条边）；一篇文档写三段互不相关的关系（关系文档只表达两端之间的一件事）。

## 3. 四个动作

工具名与 `kg.py` 对齐：`kg_add` / `kg_get` / `kg_set` / `kg_del`。所有写动作**先返回草稿**，把草稿给用户看，用户确认后再带 `confirm: true` 调用。

| 动作 | 做什么 |
|---|---|
| `kg_add` | `kind: graph` 新建 graph-json 图谱；`kind: topic` 新增一条线（文件夹 + 卡）；`kind: link` 新增一条关系；`kind: node` / `kind: edge` 给 graph-json 图谱加节点/关系 |
| `kg_get` | 不带 `graph`/`id` 返回全部图谱总览；带 `graph` 返回该图谱；带 `graph`+`id` 返回卡、文档、关系 |
| `kg_set` | 改一个主题的 `status` / `depth` / `title` / `domain` / 摘要 / 正文；graph-json 图谱改节点/关系字段 |
| `kg_del` | 把主题移到 `<graph>/_trash/`；有关联关系时需 `force: true` 一并移走，**不真删** |

### 新建图谱（graph-json）

`.graphs/<id>/graph.json` 是当前图谱模型。新建图谱**不需要先有可见文件夹**，也不要手工拼路径或写 shell：

1. `kg_add {"kind":"graph","scope":"personal","id":"nenghui-governance","name":"能汇制度图谱"}`
   返回完整 manifest 草稿（`schemaVersion/id/name/scope/visibility/nodes/edges`），此时不写盘。
2. 把草稿给用户看；确认后同参数再加 `"confirm":true`，写入 `<scope>/.graphs/<id>/graph.json`。
   写成功后图谱页/`kg_get` 概览立刻能看到它（`format: "graph-json"`）。
3. 继续加内容：`kg_add {"graph":"personal/.graphs/nenghui-governance","kind":"node","id":"policy-1","path":"制度/采购制度.md","title":"采购制度","type":"policy"}`，
   同样是先草稿、再 `confirm:true`。节点正文是普通 `.md` 文档，图谱只记录 `{id,path}` 拓扑。

- `scope`：`personal`（默认，写调用者自己的个人范围）、`department`（复用已有部门图谱的部门路径；首次可显式传 `department/<部门链>`）、`global`（通常需要管理员写权限）。权限由 Host 的 `canWrite` 判定，越权返回 `forbidden`。
- `id` 只能是小写字母、数字、连字符；同一范围内重复 id **或重名**都会返回 `exists`。
- `kg_add` / `kg_get` 报 `no readable graph matches ...` 时，按错误里的提示先用 `kind:"graph"` 建图；不要用 `find`/`map` 或 shell 绕开工具。
- 新建图谱的 `status` 是 `draft`；发布/审核是后续动作，不要为了“让它出现”改 manifest。

### 六个剧本

1. **新建图谱**：`kg_get` 总览里没有目标图谱（或 `kg_add` 报 `no readable graph matches`）→ `kg_add {kind:"graph"}` 草稿 → 用户确认 → `confirm:true` 建出 `.graphs/<id>/graph.json`。
2. **新建一条线**：`kg_get` 看当前图谱 → `kg_add {kind:"topic"}` 草稿 → 用户确认 → `confirm:true`。
3. **接续**：`kg_get {graph,id}` 读卡与关系 → 更新正文/摘要 → `kg_set` 草稿 → 确认。
4. **寻址**：`kg_get` 不带 id 看总览 → 按名称找 graph → `kg_get {graph,id}` 读一条线；不要用 `find`/`map` 另造工具。
5. **沉淀**：把一次会话的结论写成文档（`kb_file_write` 到主题文件夹），再用 `kg_set` 更新卡摘要；图谱不复制文档内容。
6. **复盘**：`kg_get` 总览 → 对每条线读 `kg_get {graph,id}` → 把 `status`/`depth` 调整回真实状态；`kg_del` 只移 `_trash`，不删。

## 4. 扫历史会话（shell，不配工具）

需要从旧会话里找线索时，直接读会话日志，不要新建 `scan` 工具：

```sh
zstd -dc ~/.dsh/sessions/<session>.jsonl.zst \
  | rg -i '任务总线|group-chat|kg' \
  | head -80
```

把命中的原文片段带回当前对话，再由 agent 写成主题卡或文档；工具只负责图谱的四个动作，不负责扫描历史。
