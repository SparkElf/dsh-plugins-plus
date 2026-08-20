# @sparkelf/dsh-mobile-bridge

## 中文

DeepSeek Harness 的独立移动连接插件。桌面端主动连接公网中继，手机通过一次性配对二维码访问本地 Harness；HTTP 与 Harness 应用 WebSocket 流量均使用端到端加密，中继服务器只读取外层设备路由 ID 并转发密文。手机登录页使用官方 DeepSeek 品牌和无外框布局，支持中英文及浅色/深色主题、深色可见网格和页面内相机扫码；相机会请求高分辨率后置画面，在设备支持时降低曝光并对可用焦距做一次清晰度评估后锁定最佳档位。decoder 按浏览器 capability 选择：原生 `BarcodeDetector` 由 `qr-scanner` 接入，其余浏览器在用户打开相机后才懒加载 ZXing-C++ WASM。两条路径都会框出识别到的二维码，首屏不下载 decoder JavaScript 或 WASM；手机在消费一次性票据前会确认 Service Worker 已接管页面。桌面端可设置手机关闭浏览器后的登录保持天数，默认 7 天。

插件同时拥有 Host 与 Client 两部分：Host 负责出站隧道与状态路由；Client 通过 Harness 的 `settings.section` Slot 注册“移动连接”，用于编辑服务器地址、本地端口、加密口令、所有者邮箱、扫码邮箱二因子和自动连接策略，并持续显示配对二维码和六位配对码；保存配置后会等待新票据就绪，票据会在过期前或手机配对后自动换新，换新期间显示刷新动效且不再展示旧二维码。已配对设备列表显示在线状态、IP、首次配对和最近连接时间，桌面端可以逐台下线；其他设备和下一张配对票据不受影响；被下线手机会暂停全部 Harness 隧道请求，在当前 Harness 页面弹出下线提示与重新扫码操作；没有打开页面时，下一次访问仍显示重新扫码页。插件不提供独立 HTML 配置面板。

### 安装

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.2.4
```

安装会通过包内 `dsh.bundle` 挂载 Host 插件，并通过 `dsh.client` 加载浏览器设置页面。手机端仅注入应用 WebSocket facade；Harness 界面的响应式样式继续由各界面所属包负责。禁用或移除该 bundle 会同时移除路由、连接和设置菜单。

### 配置

| 字段 | 含义 |
|---|---|
| `serverUrl` | 公网移动桥接服务器的 HTTPS 地址 |
| `localPort` | 本机 Harness Web 端口 |
| `userKey` | 可选加密口令；设置后手机扫码后仍需输入 |
| `ownerEmail` | 扫码邮箱二因子的收件地址 |
| `emailTwoFactor` | 是否要求扫码后输入邮箱验证码 |
| `sessionDays` | 手机关闭浏览器后的登录保持天数；默认 7，范围 1-365 |
| `autoConnect` | 启动时是否连接 |
| `autoReconnect` | 断线后是否重连 |

## English

An independent DeepSeek Harness mobile-connectivity plugin. The desktop dials the public relay, while a phone reaches the local Harness through a one-time pairing QR. HTTP and Harness application WebSocket traffic are end-to-end encrypted; the relay reads only the outer device-routing id and forwards ciphertext. The borderless phone login uses the official DeepSeek brand, supports Chinese/English, light/dark themes, a visible dark-theme grid, and in-page camera scanning. The scanner requests a high-resolution rear-camera stream and, when supported, lowers exposure, scores each available focus distance once, and locks the sharpest setting. Decoder selection follows browser capabilities: `qr-scanner` integrates native `BarcodeDetector`, while other browsers lazy-load ZXing-C++ WASM only after the user opens the camera. Both paths outline the detected QR, and the initial page downloads no decoder JavaScript or WASM. The phone confirms Service Worker control before consuming a one-time ticket. The desktop controls how many days a phone remains signed in after closing the browser; the default is seven days.

The package owns both halves of the capability: the Host provides the outbound tunnel and status route; the Client registers Mobile Bridge through the Harness `settings.section` Slot. The settings section edits the server URL, local port, optional passphrase, owner email, scan-time email second factor, and connection policy, and continuously displays the pairing QR with its six-character code; a save waits for a fresh ticket, and the ticket refreshes before expiry or immediately after a successful pairing while a visible progress state replaces the stale QR. The paired-device list shows live state, IP address, first pairing, and last connection time, and the desktop can take one device offline without affecting the others or the next ticket; the revoked phone suspends all Harness tunnel requests and opens an offline notice with a scan-again action over the current Harness page; when no page is open, the next visit still shows the rescan page. No standalone HTML configuration panel is shipped.

### Install

```sh
dsh plugin --profile web add @sparkelf/dsh-mobile-bridge@0.2.4
```

The package's `dsh.bundle` mounts the Host plugin and `dsh.client` loads the browser settings section. The phone injects only the application WebSocket facade; each Harness surface retains ownership of its responsive styles. Disabling or removing the bundle removes the routes, connection, and settings navigation entry together.

### Configuration

| Field | Meaning |
|---|---|
| `serverUrl` | HTTPS URL of the public mobile bridge server |
| `localPort` | Local Harness Web port |
| `userKey` | Optional passphrase; when set, the phone must enter it after scanning |
| `ownerEmail` | Inbox for scan-time email verification |
| `emailTwoFactor` | Require an email code after scanning |
| `sessionDays` | Days a phone remains signed in after closing the browser; defaults to 7, range 1-365 |
| `autoConnect` | Connect on startup |
| `autoReconnect` | Reconnect after disconnection |
