# image-hoist 上生产变更记录

日期：2026-09-30 20:44 – 20:56
执行方式：official `dsh plugin add` + profile patch insert + supervisor 重启

## 变更内容

| # | 文件 | 变更 |
|---|---|---|
| 1 | `/root/.dsh/profiles/plus/package.json` | 新增依赖 `@sparkelf/dsh-image-hoist: file:/root/projects/dsh-image-hoist` |
| 2 | `/root/.dsh/profiles/plus/cordis.patch.yml` | 新增 `insert` 挂载 `image-hoist`，`config.providers: [tokensfree_ds]` |
| 3 | `/root/.dsh/profiles/plus/pnpm-lock.yaml` | pnpm 自动更新（+15 packages） |

`/root/.dsh/cordis.patch.yml`（DSH_HOME 层）**未改动**。

## 为什么用 file: 依赖而不是复制目录

`releases/plus/plus-rc32/profile/` **未被 git 跟踪**（`git status` 显示 `?? profile/`），
是 `dsh-plus-mirror` 的构建产物。直接放包进去会在 release 刷新时丢失。
`file:` 依赖写进 profile 的 `package.json`，重建时会重新链接，所以升级安全。

**前提**：`/root/projects/dsh-image-hoist` 必须保留。

## 备份

```
/root/.dsh/backups/hoist-prod-20260930-204426/
  package.json  cordis.patch.yml  pnpm-lock.yaml  pnpm-workspace.yaml
  .npmrc  baseline-hashes.txt
```

profile patch 另有线上备份：`profile/cordis.patch.yml.bak-20260930-204708`

## 回滚

```bash
BK=/root/.dsh/backups/hoist-prod-20260930-204426
cp "$BK/package.json" "$BK/cordis.patch.yml" "$BK/pnpm-lock.yaml" /root/.dsh/profiles/plus/
cd /root/.dsh/releases/plus/plus-rc32
DSH_HOME=/root/.dsh node apps/cli/lib/bin.js plugin --profile plus install < /dev/null
/root/.dsh/dsh-3080-restart
```

或者只停用而不卸载：把 `cordis.patch.yml` 里 `config.providers` 改成 `[]`
（默认空数组 = 不改变任何行为），然后重启。

## 验证结果

配置层：
- YAML 合法（9 entries，`image-hoist` entry 正确）
- `--dump-config` 组装成功，插件解析为 `@sparkelf/dsh-image-hoist`
- 模块可从 profile 解析，导出 `Config/apply/inject/name`

运行时（**生产 3080 实测**）：
- web pid 从 5705 → 426992，端口占用者 == supervisor `webPid`（单实例）
- profile 指纹一致（`accepted == current: yes`）
- HTTP 200，unit active

端到端（生产 3080 上真实会话 `session-160644ce-0546-4a75-8482-3848a0f2ebc7`）：

```
user      : 用 read_image 读取 /tmp/hoist-probe.png，只回答图片里的四位数
tool/call : read_image {"file_path":"/tmp/hoist-probe.png"}
image/hoist: {"targets":[{"targetSeq":19,"userSeq":8}]}     ← 插件自动写入
provider  : tokensfree_ds / deepseek-v4.1-flash
answer    : 7391                                            ← 正确
inputTokens: 2675, 3136                                     ← 正常，未爆炸
```

对照（镜像，同 provider 同图，唯一差异是插件）：
无插件 → `4217`（错）；有插件 → `7391`（对）。

## 重启方式与依据

用 `systemd-run --unit=hoist-restart-verify` 起独立 transient unit 执行，
因为目标 unit 是 `KillMode=control-group`，会话内直接重启会把验证脚本一起杀掉
（`nohup`/`setsid` 都不脱离 cgroup）。

用了 **supervisor 模式**（`dsh-3080-restart`，不带 `--unit`），因为本次只改
`cordis.patch.yml` 与 profile 依赖，不影响 supervisor 自身的 env/cwd/命令行。

验证脚本：`/root/.dsh/hoist-prod-restart-verify.sh`，日志 `/tmp/hoist-prod-restart.log`。

## 遗留

- 测试会话 `session-160644ce-0546-4a75-8482-3848a0f2ebc7`（28 events）保留未删，供查验。
- 镜像环境 `/root/.dsh-mirror-hoist`（3.1 MB）保留，3081 已停。
- 上游修复后，把 `providers` 改成 `[]` 即可停用，无需卸载。
