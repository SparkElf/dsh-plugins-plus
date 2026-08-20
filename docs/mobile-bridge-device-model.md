# Mobile Bridge device model

## 中文

Mobile Bridge 将桌面身份、配对票据和手机设备分开管理。桌面插件首次运行时在自己的 Settings namespace 中生成并持久化稳定的 bridge id、bridge token 和 E2EE secret；bridge token 只用于桌面到服务器的认证操作，E2EE secret 只通过配对二维码交给手机。桌面或服务器重连不会改变这些值。

服务器始终为每个在线桌面保留一张未消费的五分钟一次性票据。票据过期前或被一台手机消费后，Host 使用私有 refresh token 签发下一张，并通过既有状态流发布刷新中的状态。Settings 在新票据到达前用固定尺寸的加载态替换旧二维码和六位码；轮换不会改变稳定 bridge id 或已配设备的 E2EE key。

每个完成配对的手机浏览器对应一条设备记录：设备 id、友好设备名、最近 IP、首次配对时间和最近连接时间持久化到 server store，在线状态由实时 client WebSocket 集合投影。Settings 通过 Host 的 SSE 状态流显示这些字段。桌面执行“下线”时，服务器验证 bridge token，撤销目标设备关联的全部 session token 并关闭它的 WebSocket；其他设备和当前配对票据不受影响。被下线手机的 Service Worker 清除持久配对状态，并在下一次请求显示重新扫码页面。

中继服务器会读取外层 relay id，以稳定 device id 前缀把桌面响应只送回发起请求的手机。HTTP 请求/响应和 Harness 应用 WebSocket 帧仍在 `blob` 中端到端加密，服务器不读取其 header、body、事件或 Harness 页面内容。反向代理必须把 `/bridge/`、`/ws/` 和精确路径 `/sw.js` 交给桥接服务；缺少 `/sw.js` 会让主站 HTML 以错误 MIME 返回并阻止 Service Worker 注册。

旧的无版本 store 在首次加载时迁移到 version 2：保留登录身份和邮箱验证码记录，清除旧 session/bridge 绑定。升级后的手机需要重新扫码一次，之后稳定 bridge identity 支持多设备和桌面重连。

## English

Mobile Bridge manages desktop identity, pairing tickets, and phone devices separately. On first run, the desktop plugin generates a stable bridge id, bridge token, and E2EE secret in its own Settings namespace. The bridge token authenticates desktop-only server operations; the E2EE secret reaches phones only through pairing QR payloads. Desktop and server reconnects do not replace these values.

The server keeps one unconsumed five-minute ticket for every online desktop. Before expiry or after a successful pairing, the Host uses its private refresh token to issue the next ticket and publishes the in-progress transition through the existing status stream. Settings replaces the stale QR and six-character code with a fixed-size loading state until the fresh ticket arrives, without changing the stable bridge id or existing device keys.

Each paired phone browser owns one durable device record: device id, friendly name, latest IP, first-paired time, and last-connected time. Live status comes from its client WebSocket set. Settings consumes the Host SSE status stream. Taking one device offline authenticates with the bridge token, revokes every session token for that device, and closes its WebSockets without affecting other devices or the active pairing ticket. The revoked phone's Service Worker clears durable pair state and returns a rescan page on its next request.

The relay reads the outer relay id so a stable device-id prefix routes each desktop response only to the phone that initiated it. HTTP requests, responses, and Harness application WebSocket frames remain E2EE ciphertext inside `blob`; the relay cannot read their headers, bodies, events, or page data. The reverse proxy must send `/bridge/`, `/ws/`, and exact path `/sw.js` to the bridge service; otherwise the main site can return HTML for the Service Worker and the browser will reject its MIME type.

The first load migrates the unversioned store to version 2. Login identities and email-code records remain, while old sessions and ephemeral bridge bindings are removed. Phones pair once after the upgrade; the stable bridge identity then supports multiple devices and desktop reconnects.
