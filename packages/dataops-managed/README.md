# @sparkelf/dsh-dataops-managed

## 中文

这是DataOps托管工作区使用的DeepSeek Harness集成插件。它接收当前DataOps会话JWT，并通过credential-backed HTTP MCP提供DataOps工具；DSH Settings显示只读的DataOps身份与权限说明。

本包不发起OAuth，也不提供连接、重新授权或断开按钮。DataOps父页面把现有JWT交给固定Host route；插件把它存入DSH credential，MCP transport在每次请求前读取当前值。DataOps API根据该JWT对应的当前角色和资源授权决定可执行范围。

本包只应安装到DataOps托管profile。独立DSH需要用户授权时使用@sparkelf/dsh-dataops-integration，两者不应同时安装。

### 万相品牌

DataOps设置中的“应用万相品牌”默认开启，并在本机浏览器中持久化。开启时，侧栏、折叠导航、新会话欢迎页、浏览器标题和favicon使用万相数据平台品牌；关闭后立即恢复DSH官方品牌。欢迎页四单元Logo在支持hover且未启用减少动态效果时播放轻微的等距展开动画。

### 模型体验

本包增加命名空间化DataOps MCP tool schema，但不把JWT写入system prompt、tool参数、结果或session log。认证本身不增加token或改变KV cache。

### 已知限制

- JWT尚未同步或DataOps拒绝当前权限时，MCP client直接呈现对应连接或工具错误。

## English

This is the DeepSeek Harness integration plugin for DataOps-managed workspaces. It accepts the current DataOps session JWT and provides DataOps tools through credential-backed HTTP MCP; DSH Settings shows a read-only identity and permission summary.

The package starts no OAuth flow and exposes no connect, reauthorize, or disconnect control. The DataOps parent supplies its existing JWT to one fixed Host route; the plugin stores it as a DSH credential, and the MCP transport resolves the current value before every request. DataOps APIs decide the allowed operations from the JWT principal's current roles and resource grants.

Install this package only in a DataOps-managed profile. Standalone DSH deployments that need user authorization use @sparkelf/dsh-dataops-integration; the two packages must not be installed together.

### Wanxiang Branding

The Apply Wanxiang branding setting defaults on and persists in the local browser. When enabled, the sidebar, collapsed rail, New Session welcome view, document title, and favicon use the Wanxiang Data Platform identity; disabling it immediately restores the official DSH identity. The four-unit welcome mark animates a subtle isometric expansion only on hover-capable devices when reduced motion is not requested.

### Model Experience

The package adds namespaced DataOps MCP tool schemas but never places the JWT in the system prompt, tool arguments, results, or Session log. Authentication adds no model tokens and does not affect the KV cache.

### Known Limitations

- Before JWT synchronization, or when DataOps rejects current permissions, the MCP client exposes the corresponding connection or tool error.
