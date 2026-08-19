# @sparkelf/dsh-mobile-bridge

## 中文

DeepSeek Harness 的独立移动连接插件。桌面端主动连接公网中继，手机通过一次性配对二维码访问本地 Harness；应用流量使用端到端加密，中继服务器只转发密文。

插件同时拥有 Host 与 Client 两部分：Host 负责出站隧道、状态与窄屏样式路由；Client 通过 Harness 的 `settings.section` Slot 注册“移动连接”，用于编辑服务器地址、本地端口、加密口令、所有者邮箱、扫码邮箱二因子和自动连接策略，并显示配对二维码；未配对时，一次性二维码会在过期前自动续签。插件不提供独立 HTML 配置面板。

### 安装

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.1.4
```

安装会通过包内 `dsh.bundle` 挂载 Host 插件，并通过 `dsh.client` 加载浏览器设置页面。禁用或移除该 bundle 会同时移除路由、连接、窄屏样式和设置菜单。

### 配置

| 字段 | 含义 |
|---|---|
| `serverUrl` | 公网移动桥接服务器的 HTTPS 地址 |
| `localPort` | 本机 Harness Web 端口 |
| `userKey` | 可选加密口令；设置后手机扫码后仍需输入 |
| `ownerEmail` | 扫码邮箱二因子的收件地址 |
| `emailTwoFactor` | 是否要求扫码后输入邮箱验证码 |
| `autoConnect` | 启动时是否连接 |
| `autoReconnect` | 断线后是否重连 |

## English

An independent DeepSeek Harness mobile-connectivity plugin. The desktop dials the public relay, while a phone reaches the local Harness through a one-time pairing QR. Application traffic is end-to-end encrypted and the relay forwards ciphertext only.

The package owns both halves of the capability: the Host provides the outbound tunnel, status route, and narrow-screen stylesheet; the Client registers Mobile Bridge through the Harness `settings.section` Slot. The settings section edits the server URL, local port, optional passphrase, owner email, scan-time email second factor, and connection policy, and displays the pairing QR; while no phone is paired, the one-time QR renews before it expires. No standalone HTML configuration panel is shipped.

### Install

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.1.4
```

The package's `dsh.bundle` mounts the Host plugin and `dsh.client` loads the browser settings section. Disabling or removing the bundle removes the routes, connection, mobile stylesheet, and settings navigation entry together.

### Configuration

| Field | Meaning |
|---|---|
| `serverUrl` | HTTPS URL of the public mobile bridge server |
| `localPort` | Local Harness Web port |
| `userKey` | Optional passphrase; when set, the phone must enter it after scanning |
| `ownerEmail` | Inbox for scan-time email verification |
| `emailTwoFactor` | Require an email code after scanning |
| `autoConnect` | Connect on startup |
| `autoReconnect` | Reconnect after disconnection |
