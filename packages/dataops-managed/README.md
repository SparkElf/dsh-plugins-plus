# @sparkelf/dsh-dataops-managed

## 中文

这是DataOps托管工作区使用的DeepSeek Harness呈现插件。安装后，DSH Settings显示只读的DataOps页面，说明当前Harness由DataOps工作区托管、身份与权限由当前DataOps会话管理、DataOps工具由工作区自动提供。

本包不读取DataOps账号，不注册HTTP路由，不发起OAuth，不持有access token、refresh token或DataOps JWT，也不提供连接、重新授权或断开按钮。实际DataOps工具仍由部署方配置的DataOps-owned Unix broker和通用MCP client提供。

本包只应安装到DataOps托管profile。独立DSH需要用户授权时使用@sparkelf/dsh-dataops-integration，两者不应同时安装。

### 模型体验

本包只贡献Settings呈现，不增加system prompt、tool schema、模型输入或session log事件。token和KV cache均不受影响。

### 已知限制

- 页面说明部署所有权，不探测broker实时状态；实际工具错误由MCP client和DataOps工作区链路呈现。

## English

This is the DeepSeek Harness presentation plugin for DataOps-managed workspaces. Once installed, DSH Settings includes a read-only DataOps page explaining that the current Harness is managed by the DataOps workspace, identity and permissions belong to the current DataOps session, and DataOps tools are supplied automatically by the workspace.

The package reads no DataOps account, registers no HTTP route, starts no OAuth flow, holds no access token, refresh token, or DataOps JWT, and exposes no connect, reauthorize, or disconnect control. The deployment-owned Unix broker and the generic MCP client continue to provide the actual DataOps tools.

Install this package only in a DataOps-managed profile. Standalone DSH deployments that need user authorization use @sparkelf/dsh-dataops-integration; the two packages must not be installed together.

### Model Experience

The package contributes Settings presentation only. It adds no system prompt, tool schema, model input, or session-log event, and has no token or KV-cache effect.

### Known Limitations

- The page explains deployment ownership rather than probing live broker state. MCP client and DataOps workspace errors remain the source for actual tool failures.
