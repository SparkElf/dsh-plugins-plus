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
| `kg_add` | `kind: topic` 新增一条线（文件夹 + 卡）；`kind: link` 新增一条关系 |
| `kg_get` | 不带 `graph`/`id` 返回全部图谱总览；带 `graph` 返回该图谱；带 `graph`+`id` 返回卡、文档、关系 |
| `kg_set` | 改一个主题的 `status` / `depth` / `title` / `domain` / 摘要 / 正文 |
| `kg_del` | 把主题移到 `<graph>/_trash/`；有关联关系时需 `force: true` 一并移走，**不真删** |

### 五个剧本

1. **新建一条线**：`kg_get` 看当前图谱 → `kg_add {kind:"topic"}` 草稿 → 用户确认 → `confirm:true`。
2. **接续**：`kg_get {graph,id}` 读卡与关系 → 更新正文/摘要 → `kg_set` 草稿 → 确认。
3. **寻址**：`kg_get` 不带 id 看总览 → 按名称找 graph → `kg_get {graph,id}` 读一条线；不要用 `find`/`map` 另造工具。
4. **沉淀**：把一次会话的结论写成文档（`kb_file_write` 到主题文件夹），再用 `kg_set` 更新卡摘要；图谱不复制文档内容。
5. **复盘**：`kg_get` 总览 → 对每条线读 `kg_get {graph,id}` → 把 `status`/`depth` 调整回真实状态；`kg_del` 只移 `_trash`，不删。

## 4. 扫历史会话（shell，不配工具）

需要从旧会话里找线索时，直接读会话日志，不要新建 `scan` 工具：

```sh
zstd -dc ~/.dsh/sessions/<session>.jsonl.zst \
  | rg -i '任务总线|group-chat|kg' \
  | head -80
```

把命中的原文片段带回当前对话，再由 agent 写成主题卡或文档；工具只负责图谱的四个动作，不负责扫描历史。
