# @sparkelf/dsh-knowledge-base

DeepSeek-Harness knowledge base: a left-sidebar destination, Settings configuration, and
index tooling over a mounted directory. Runs standalone or against a DataOps backend.


## 两种部署形态

同一个包，一份代码，由**有没有配置 `baseUrl`** 决定跑哪种形态。这不是一个运行期开关，
而是部署事实：`baseUrl` 为空就是个人版。

### 个人版（`baseUrl` 未配置）

一个操作者，一个本地目录，**没有任何 DataOps 依赖**。

**能做：**
- 新建 / 编辑 / 重命名 / 复制 / 移动 / 删除文档与目录
- 上传文件并自动提取 Markdown（MinerU 地址取本插件 `mineruBaseUrl`，或按 `mineruPort` 推导）
- 目录浏览、全文搜索、预览
- 收藏、置顶、视图模式、回收站、审计记录——都是本地文件，不依赖后端
- 模板的读写

**不能做（因为没有可询问的权威）：**
- **没有成员与账号体系**：不知道「我是谁」，只有一个固定的 `local` 身份
- **没有权限控制**：路径不按用户隔离；唯一的限制是「不能越出知识根目录」
- **没有共享配置**：没有管理员可以下发地址，MinerU 地址要自己填
- **没有授权与共享**：不能把文档授权给别人，也看不到别人的共享
- **没有成员目录**：无法列出用户 / 角色 / 部门作为授权对象
- **没有组织树**：视图只有一个平铺层级
- **不读取共享 OCR 地址**：不调用 `GET /api/ocr/config`，只用本插件自己的配置

**边界仍然存在：** 所有路径都相对知识根目录，`..`、绝对路径、NUL 字节一律拒绝并给出原因
（`checkLocalPath`）。「没有权限体系」不等于「没有边界」。

### 团队版（`baseUrl` 已配置）

装到 DataOps 工作区里的形态，行为与之前一致：账号、按路径授权的读写、共享 MinerU 地址、
成员目录、共享配置、按用户隔离的视图（`/nas/kb/views/<userId>` 符号链接到 `mountPoint`）。

路径校验、上传、提取、搜索、预览这些核心链路两种形态共用同一份实现——区别只是权限判据
从「问后端」变成「查本地边界」。

## 本地验证一个个人版

个人版不依赖任何后端，所以可以直接起一个临时 profile 验证四条链路：

```bash
mkdir -p ~/.dsh/profiles/kb-personal/plugins
cd ~/.dsh/profiles/kb-personal
# package.json 的 dsh.profile.bundles 里放 @deepseek-ai/dsh-base + dsh-web-app + 本插件
# cordis.patch.yml 里放 baseUrl: '' 和两个根目录（见下）
~/.dsh/.../bin.js --profile kb-personal --port 6688 --no-open
```

**`mountPoint` 必须等于 `actualRoot`。** 团队版靠 `pointMountAtView` 把两者用符号链接接起来；
个人版没有视图层，列表读 `mountPoint`、写入落 `actualRoot`，写成两个目录就会表现为
「上传成功了但文件不见了」。

### 验证端口不要用 Chrome 的保留端口

**6666、6667 这类端口 Chrome 会拒绝加载**（`ERR_UNSAFE_PORT`，浏览器硬限制，与本插件无关），
表现为 Playwright / 浏览器连不上而 curl 正常：

```
page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:6666/?token=...
```

选 6688 这类端口做本地验证。另外**起服务前先 `curl` 一次目标端口**再判断是否占用——
`ss` 显示空闲不代表绑定会成功（连续起停会有瞬时的绑定失败）。


## 引用契约

`kb_search` 的每个命中、`kb_chunk_get` 的每个响应都带一个稳定 token：

```
kb://doc/<docId>/chunk/<key>
```

`key` 是内容寻址的 `chunk_key`（16 位十六进制），旧索引里可能是数字 chunk id。模型回答时
**原样引用这个 token**，不要写 `:193`、`第N块`、`path:line`，也不要写 `.docx.md`/`.pdf.md`
派生路径。`kb_chunk_get` 接受完整 token，或 `docId` + `chunkId`（数字 id 或 chunk_key）。

`@sparkelf/dsh-kb-citation` 负责把 token 渲染成 `文件名:第N块`：点击后打开原始
`.docx/.pdf/.xlsx`，滚动到该 chunk 的首个命中页，并**每页只画 1 个 union 框**。source 面板、
正文、GenUI 三处共用同一解析与标签逻辑；旧 `.docx.md:line` 链接仅作兼容 fallback，新回答
不应再产生。

### 目录索引（INDEX.md）与 `kb_outline`

每篇文档建立 FTS 索引时会同步生成一份**导航结构**：目录（章/节/条）和章节行，
但**默认不生成摘要**。摘要是在用户明确要求时，由 agent 执行 `kb-summarize` 技能阅读原文后
调用 `kb_outline_save` 写入的。

- 文件：`<indexDir>/md/<docId>.INDEX.md`（默认 `/nas/kb/index/md/<docId>.INDEX.md`），
  与 `kb-index.sqlite` 同级，**不写入源文件目录**，也不进入任何用户的可见视图。
- 上传/抽取后：`kb_docs.summary` 为空，`kb_outline` 返回 `summaryStatus: "missing"` +
  `hint: "调用 kb-summarize 技能生成摘要"`；目录和 `kb_sections` 已可用。
- 显式生成：`kb_outline` 拿 `toc`/`sectionId`/`chunkIds` → 逐章 `kb_chunk_get` 读原文 →
  agent 生成 doc/section summary + keyFacts → `kb_outline_save` 校验并落库。
- 校验：摘要与 keyFacts 中的数字、比例、金额、条款号、责任主体必须能在对应 source chunks
  原文中找到（严格归一化）；不匹配返回 `rejected[]`，**不写任何半成品**。
- 存储：`kb_docs.summary` / `toc_json` / `summary_version` / `summary_kind`；章节行写入
  `kb_sections`；摘要与一级/全部章节摘要写入 `kb_summary_chunks` + `kb_summary_fts`
  （独立 FTS 表，不影响 `kb_chunks_fts`）。
- 兼容：0.1.9 的抽取式摘要保留为 `summary_kind='extractive'`；`outline.autoGenerate=true`
  可恢复旧的自动抽取式行为（默认 `false`）。显式保存后整篇文档覆盖为 `summary_kind='llm'`。
- 重建条件：源文件 hash 或 `CHUNKER_VERSION` 变化会重建目录结构并使旧摘要失效；旧索引升级时只补
  outline 行，**不重分块、不换 chunk id**，已有 citation token 仍然有效。

`kb_outline(docId | kb://doc/<docId>/chunk/<key>)` 返回
`{docId,path,summary,summaryKind,summaryStatus,toc,sections,indexPath}`，不返回整章全文。
`summaryStatus` 为 `missing` 时摘要为空，不应伪造；`kb_search` 命中在索引有摘要时附带
`sectionId/sectionPath/sectionSummary/docSummary`；摘要类结果永远不带 `citation`，只用于导航。
引用仍只能使用原文 chunk 的 `kb://doc/<docId>/chunk/<key>` token。

`kb-summarize` 作为第二个 bundled skill 注册在同一个 skill provider 下；`list()` 同时返回
`knowledge-base` 与 `kb-summarize` 两个 candidate。

### 分块与 bbox 契约

- `kb_chunk_boxes` 按提取块（段落/表格行/OCR block）逐条保存 provenance，供排查与
  重新聚合使用，**不是**前端绘制粒度。
- `POST /knowledge-base/api/chunk`、`/api/resolve` 与 `kb_search` 的 `boxes` 字段均为
  **每页 1 个 union**；`kb_chunk_unions` 缓存该结果，旧索引没有缓存时由 API 现算。
- 分块以结构优先：`第X章/第X节`、`第X条`、Markdown/`一、` 标题、表格行都会开启新 chunk，
  章标题/条标题不会被并入上一块；`（一）` 等条内列表可以合并，但不得跨章。430 字只是软目标，
  上限 800 字只用于切分超长段落。`CHUNKER_VERSION` 变化会触发重建。
- 重建后旧 `chunk_key` 通过 `kb_chunk_key_aliases` 按文本重叠率（≥20%，短块要求完全一致）
  重映射；内容已被改写/删除的旧 token 解析为 404，引用侧显示「引用已失效」，不会落到相邻块。


## MinerU 部署（`scripts/deploy-mineru.mjs`）

知识库的文档索引依赖 MinerU 提供 Markdown 提取。这个脚本把「准备离线包」和
「装到目标机」拆成两步，因为这两件事通常不在同一台机器上发生：打包的机器有外网，
要部署的机器往往没有。

```bash
# 1) 在有外网的机器上：把镜像（和可选的模型缓存）打成一个可搬运的目录
node scripts/deploy-mineru.mjs fetch --image mineru:4 --output ./mineru-bundle

# 2) 把 ./mineru-bundle 拷到目标机后：加载镜像并起服务
node scripts/deploy-mineru.mjs deploy --host root@10.0.0.12 --bundle ./mineru-bundle

# 3) 用插件真正发送的请求验证一次
node scripts/deploy-mineru.mjs verify --url http://10.0.0.12:8000
```

每个子命令都支持 `--dry-run`：只打印将要执行的命令与产物路径，不下载、不复制、
不启动任何东西。第一次对某台机器操作前建议先跑一遍。

### 部署后的请求契约

`verify` 发送的就是知识库插件实际使用的形态，不是旧文档里的写法：

```
POST {base}/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto
Content-Type: multipart/form-data
body: 只有 files 一个字段
```

MinerU 4.x 以 `max_fields=0` 解析 multipart，body 里多一个字段就会被拒绝
（`Too many fields. Maximum number of fields is 0.`），所有解析选项都从 query 串读取。
`output_formats` 没有默认值必须显式传；`tier` 不传时服务器会自行选择 `standard`，
同一个单页 PDF 实测 17.8 秒对 `basic` 的 2.0 秒，所以脚本固定传 `tier=basic`。

### 幂等与凭据

- 重复执行安全：bundle 已存在则跳过重建（`--force` 才重做）；目标机上镜像已加载
  则跳过 `docker load`；容器已存在且未给 `--force` 时保持原样。
- SSH 只用密钥、ssh-agent 或 `~/.ssh/config`。需要密码时用
  `MINERU_DEPLOY_SSH_PASSWORD` 环境变量配 `--ask-pass`，**任何密码都不会写入文件或
  出现在命令行参数里**（helper 脚本从环境读，用后即删）。
- 退回到无 Docker 的机器用 `fetch --mode=wheels`：下载 wheel 与模型，但目标机仍需
  Python 3.10+ 与 venv；缺什么会在 `deploy` 时明确报出来，不会假装成功。

### 镜像从哪来

MinerU 官方发布的是 Dockerfile 而不是可直接 pull 的 tag：`docker/compose.yaml` 里用的
是本地构建的 `mineru:4`。所以 `fetch` 依次尝试「本地已有镜像 → `--build-from <仓库>`
构建 → `docker pull`」，并在最后一步失败时把构建命令打出来：

```bash
git clone https://github.com/opendatalab/MinerU
docker build -f docker/global/Dockerfile -t mineru:4 .
```

国内网络用 `docker/china/Dockerfile`（DaoCloud vllm 基底 + 阿里云 PyPI + ModelScope），
`fetch --model-source modelscope` 是默认值。
