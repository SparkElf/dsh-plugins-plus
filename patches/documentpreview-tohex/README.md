# documentpreview-tohex

`@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.2.1-rc.2` 的 PDF.js
指纹路径调用 `calculateMD5(...).toHex()`；Windows Chrome 没有
`Uint8Array.prototype.toHex`，因此打开 `.docx` 时显示
“无法显示 PDF：h.toHex is not a function”。Playwright 自带的 Headless
Chromium 实现了该方法，所以之前的 UI 回归测不到。

这里是一个 **纯数据层补丁**：在 `client.pdf.js` 最前加一段幂等
`Uint8Array.prototype.toHex/toBase64` polyfill，不改 PDF.js 业务逻辑，也不改
package 版本。

## 目标文件

运行中的两套树（共四份，其中 `/workspace` 两份内容相同）：

- `dataops-ai-admin`
  - `/opt/dsh-plus/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js`
  - `/workspace/.dataops/dsh/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js`
- `dataops-ai-admin-dsh-runtime`
  - `/opt/dsh-plus/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js`
  - `/workspace/.dataops/dsh/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js`

`dataops-ai-admin-dsh-runtime` 的 `/opt` 树自带的 PDF.js 版本较新，内部已有
core-js 的 `toHex` polyfill；本补丁仍然幂等跳过，不会重复插入。

## 应用

在容器内（或镜像 build 中的对应文件路径）执行：

```bash
node /path/to/patches/documentpreview-tohex/apply.mjs \
  /opt/dsh-plus/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js \
  /workspace/.dataops/dsh/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js
```

脚本只做三件事：读目标文件、若不含 `task-121` 标记则前置
`polyfill.js`、原子替换；第二次执行输出 `0 file(s) patched`。

## 镜像 fold

当前运行树是热修，不能作为重建来源。镜像 build（工作区模板
`/opt/dataops-dsh-profile-template` 和 `/opt/dsh-plus`）应在 DSH 安装完成后、
`finalize-extra-plugins`/`materialize-npm-patches` 之后增加一步：

```dockerfile
COPY patches/documentpreview-tohex /usr/local/lib/documentpreview-tohex
RUN node /usr/local/lib/documentpreview-tohex/apply.mjs \
      /opt/dsh-plus/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js \
      /opt/dataops-dsh-profile-template/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js
```

如果镜像只保留模板一份（运行容器启动时复制到 profile），至少要对模板和
`/opt/dsh-plus` 两处都执行；否则 fresh volume 会回到未修补的 PDF.js。

## 回滚

热修前的原始文件已备份到：

`/root/projects/.artifacts/task121/backup/`

按容器/树对应关系 `docker cp` 回原路径即可；回滚不需要重启 DSH，重新打开
文档标签页会重新取静态 bundle。镜像回滚则回退到上一版镜像。

- `dataops-ai-admin` `/opt`：`dataops-ai-admin-opt-dsh-plus-client.pdf.js`
  （原 sha `9902ee44697a32f02916c1955e96e0baeba55f079660ba1cf27f7ea237cfa760`）
- `dataops-ai-admin` `/workspace`：`dataops-ai-admin-workspace-profile-client.pdf.js`
  （原 sha `67992f97bcab1011db33800bf95abccd2f813b0a0b75210b8ee35deebc71296c`）
- `dataops-ai-admin-dsh-runtime` `/opt`：`dataops-ai-admin-dsh-runtime-opt-dsh-plus-client.pdf.js`
  （原 sha `592bbdaac712b38e5883babf4ad466481c918b123b604b578cb809b0f74b88b3`）
- `dataops-ai-admin-dsh-runtime` `/workspace`：`dataops-ai-admin-dsh-runtime-workspace-profile-client.pdf.js`
  （原 sha `67992f97bcab1011db33800bf95abccd2f813b0a0b75210b8ee35deebc71296c`）

## 验证

`/root/projects/PDF-DOCX-EVIDENCE.md` 记录了真实 8080/32008 打开
`.docx` 的结果：Playwright 在页面脚本执行前删除原生
`Uint8Array.prototype.toHex/toBase64`，打开文档后
`del=true`、`toHex`/`toBase64` 均为 `function`，正文渲染，无
“无法显示 PDF”/`toHex` 错误。