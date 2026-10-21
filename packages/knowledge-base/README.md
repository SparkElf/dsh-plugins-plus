# @sparkelf/dsh-knowledge-base

DataOps-backed knowledge base for DeepSeek Harness: a left-sidebar destination,
Settings configuration, and index tooling over a mounted NAS view.

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
