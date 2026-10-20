---
name: knowledge-base
description: "Read and change the shared knowledge base: browse, search, create, upload, rename, move and delete documents in the 全局 / 部门 / 个人 trees. Use whenever the user asks about a document in the knowledge base, wants to add a file to it, or asks what the team has documented."
---

# 知识库 — 增删改查

知识库是一个**共享文档存储**，不是聊天附件、不是临时工作区。用户看到的是他自己的一份视图：`/workspace/kb`（宿主侧 `viewRoot`）。这份视图里的三个顶层文件夹决定了文档的可见范围：

| 文件夹 | 谁能看到 | 用来放 |
| --- | --- | --- |
| `global` | 所有人 | 公司制度、通用规范、全员参考 |
| `department` | 本部门的人 | 部门流程、值班表、本部门台账 |
| `personal` | 只有自己 | 草稿、个人笔记、未定稿调研 |

**新建文档前先想清楚它属于哪一层。** 放错层的后果是可见范围错了，而移动文档需要写权限——用户可能没有那个权限去纠正。

## 一、查（读与检索）

### 浏览与读取

用户界面里看到的就是这份视图，你也可以直接读同一批文件：

```bash
ls /workspace/kb/global/
cat /workspace/kb/global/规范.md
```

三层都要看的时候：

```bash
find /workspace/kb -name "*.md" -not -path "*/.*" | head -50
```

### 用 grep 全文检索

**这是知识库最重要的用法**：所有上传的文档在上传时都会自动生成一份 `.md` 文本副本（同名加 `.md`，例如 `报告.docx` 旁边有 `报告.docx.md`），所以 grep 能直接搜到 Word 和 PDF 里的正文：

```bash
grep -rl "关键字" /workspace/kb --include="*.md"
grep -rn "关键字" /workspace/kb --include="*.md" | head -20
```

搜到了原文，再决定要不要读整个文件。不要一上来就 `cat` 大文件。

### 搜索的局限

- 图片里的文字搜不到（解析不覆盖 OCR）
- 扫描件 PDF 只有 MinerU 能读出文字，读不出时该文件没有 `.md` 副本
- `.doc`/`.xls`/`.ppt` 老格式靠 LibreOffice 转换，可能丢失表格结构

## 二、增（新建与上传）

### 新建一个文本文件

```bash
cat > /workspace/kb/personal/调研笔记.md <<'EOF'
# 标题

正文。
EOF
```

**路径必须在三个桶之内**，写到 `/workspace/kb/` 根下会落在视图外层、不再受分桶与权限约束。

### 上传现成的文档

用户拖进知识库的 `docx`/`pdf`/`xlsx`/`pptx` 会自动解析出 `.md` 副本。你也可以自己复制文件进来：

```bash
cp /root/projects/报告.docx /workspace/kb/department/运维/
```

**用命令直接复制不会触发解析**，没有 `.md` 副本，grep 搜不到内容。需要检索的文档请走界面上传，或在复制后自行转出文本。

### 文件名的约定

- 中文、空格、括号都能用，但**不要**在文件名里放 `/`
- 以 `.` 开头的文件被视为隐藏文件，不会出现在列表里
- 不要手工编辑 `*.docx.md` 这类副产物：下次上传同名文件会重新生成

## 三、改（改名与内容修订）

```bash
# 改名
mv /workspace/kb/personal/草稿.md /workspace/kb/personal/定稿.md

# 改写内容（整篇替换）
cat > /workspace/kb/personal/定稿.md <<'EOF'
新内容
EOF
```

改名或移动时**保持在同一层内**：跨层（例如 `personal/` → `global/`）等于改变可见范围，需要用户明确同意，且调用者的写权限必须覆盖目标层。

大范围改写前先备份：

```bash
cp /workspace/kb/global/规范.md /workspace/kb/global/规范.md.bak
```

## 四、删（删除与恢复）

**删除是高风险操作，先确认再执行。**

```bash
rm /workspace/kb/personal/废弃草稿.md
```

删除前必须做到：

1. **确认路径**：把完整路径念一遍给用户听，不要凭记忆删
2. **确认归属层**：删 `global/` 里的东西影响所有人
3. **不要用通配符删**：`rm *.md` 在知识库里几乎一定是错的
4. **先想能不能改名保留**：不确定时改名成 `废弃-*.md` 比删除安全

**知识库的回收站目前尚未支持恢复**（功能在设计中）。删除即不可逆，所以：**只要用户没有明确说「删掉」，就不要删。**

## 五、权限

调用者的可见范围由 DataOps 的授权决定，不是你按目录推断出来的：

- 你看得到的文件，是调用者被授权读的文件
- 写、改、删各自需要对应的授权，读权限不等于写权限
- 没有权限时操作会失败——**这是正确行为，不要绕过它**

如果用户要求访问看不到的文档，正确回答是「你没有该文档的权限，需要管理员授权」，而不是去找别的路径读它。

## 六、常见错误

| 错误 | 为什么错 | 正确做法 |
| --- | --- | --- |
| 把文档写到 `/workspace/kb/` 根下 | 脱离三个桶，权限与可见性都不受控 | 先选层，再写进对应文件夹 |
| 用 `rm *.md` 清理 | 知识库不是临时目录 | 明确指定单个路径 |
| 假设 `department/` 里是自己部门的文件 | 目录名是桶名，具体部门在数据层区分 | 以实际列出的内容为准 |
| 上传后立刻 grep 搜正文 | 解析是异步完成的，且只对可解析格式生效 | 确认旁边有 `.md` 副本再搜 |
| 读不到文件就去翻 `/nas/kb` 原始库 | 那是权威存储，绕过视图等于绕过权限 | 尊重当前视图的可见范围 |

## 七、给用户写操作前的自检

动手改任何东西之前，问自己三句：

1. **这个路径属于哪一层？** 全局、部门、还是个人？
2. **用户明确要求了吗？** 还是我在推测他想改？
3. **改坏了能恢复吗？** 不能的话先备份。

三条都清楚再动手。
