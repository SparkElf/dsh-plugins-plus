# @sparkelf/dsh-dataops-integration

## 中文

`@sparkelf/dsh-dataops-integration`是SparkElf维护的DeepSeek Harness独立DataOps连接插件。一个owner package同时包含Host授权routes、Web Settings、credential生命周期和generic MCP client组合；DSH core不包含DataOps身份、endpoint或授权逻辑。

当前branch是发布候选源码，本文不声明已发布npm版本或生产pin。正式发布状态以仓库CI、打包产物和实际npm publication为准。

### 用户路径

安装package后，DSH Settings出现DataOps页面。用户点击“连接DataOps”，在DataOps原生页面完成登录、MFA和明确账号选择，批准后回到DSH并看到已绑定账号。一次delegated access token在其DataOps `AuthSession`有效期间持续工作，不做后台refresh、周期轮换或周期remount。

同一`DSH_HOME`只生成一个持久`target_ref`。DataOps首次批准会把它永久绑定到所选owner；后续“重新授权”只能更新同一owner的access credential，并且只在该次用户操作后重挂一次DataOps MCP child。退出登录、session过期或撤销、账号停用、权限变更和Disconnect由DataOps现有管理机制即时执行。

Disconnect先让DataOps撤销当前delegated access token；成功后再卸载DataOps工具并清除本地access credential。`target_ref`和owner绑定保留，因此重新连接仍回到同一账号。

### 配置

Bundle默认使用DataOps本地origin `http://127.0.0.1:3000`、MCP namespace `dataops`、access credential `DATAOPS_MCP_TOKEN`和target credential `DATAOPS_DSH_TARGET`。生产或其他内网部署在profile patch中替换`baseUrl`：

```yaml
- id: dataops-integration
  config:
    baseUrl: http://dataops.internal.example
```

可信内网HTTP是默认合同。外网部署显式使用HTTPS；DSH对外发布时还必须显式配置同协议的`callbackOrigin`，并在DataOps `AUTH_DSH_REDIRECT_ORIGINS`登记。HTTPS不回落到HTTP。DSH origin的访问控制由部署网络或入口代理拥有，plugin不以TCP peer必须是loopback来破坏已声明的非loopback部署。

DataOps托管容器不安装本package；托管模式使用DataOps-owned Unix broker，DSH进程不持有delegated token，Settings也没有独立连接控件。

### Model Experience

**Prompt impact:** package本身不增加system prompt文本。授权成功后，generic MCP client向模型注册DataOps提供的八个工具schema；package不改写工具名、参数或结果。

**Token impact:** token使用量只来自DataOps MCP工具schema和实际tool result。access credential、target owner、user ID和权限字段不进入模型上下文或tool arguments。

**KV-cache impact:** DataOps工具挂载或卸载会改变后续请求的tool-schema前缀；一个有效AuthSession内没有周期性卸载或重挂，因此不会制造后台cache抖动。

### 组合与分发

- Cordis plugin：`@sparkelf/dsh-dataops-integration`
- npm publication：计划发布为SparkElf package
- source owner：`SparkElf/dsh-plugins-plus`
- default composition：安装bundle后挂载；Plus默认profile不内置DataOps-specific源码
- upstream dependency：只使用已发布的DSH credential、Web route、Settings slot和generic MCP client扩展点

### 已知限制与后续工作

一个`DSH_HOME`没有账号切换、target unbind或owner重置。绑定owner的DataOps `AuthSession`结束后，用户在Settings重新连接；package不在后台延长DataOps session。完整八工具取数、chart和analysis的用户验收由真实DataOps与DSH Playwright路径统一完成。

## English

`@sparkelf/dsh-dataops-integration` is an independent DataOps connection plugin for DeepSeek Harness maintained by SparkElf. One owner package contains the Host authorization routes, Web Settings, credential lifecycle, and generic MCP client composition. DSH core contains no DataOps identity, endpoint, or authorization logic.

The current branch is release-candidate source. This document does not claim an npm publication or production pin; release status is established by repository CI, packaged artifacts, and an actual npm publication.

### User journey

After installation, DSH Settings contains a DataOps page. The user selects Connect DataOps, completes login, MFA, and explicit account selection on the native DataOps page, then returns to DSH and sees the bound account. One delegated access token remains usable while its DataOps `AuthSession` remains active. There is no background refresh, periodic rotation, or periodic remount.

One `DSH_HOME` creates one persistent `target_ref`. The first DataOps approval permanently binds it to the selected owner. Later authorization can only replace the same owner's access credential and remounts the DataOps MCP child once after that explicit action. Logout, session expiry or revocation, account disablement, permission changes, and Disconnect remain owned by existing DataOps administration.

Disconnect first asks DataOps to revoke the current delegated access token. After success it removes the DataOps tools and clears the local access credential. The `target_ref` and owner binding remain, so reconnecting returns to the same account.

### Configuration

The bundle defaults to the local DataOps origin `http://127.0.0.1:3000`, MCP namespace `dataops`, access credential `DATAOPS_MCP_TOKEN`, and target credential `DATAOPS_DSH_TARGET`. Production and other trusted-LAN deployments replace `baseUrl` in the profile patch:

```yaml
- id: dataops-integration
  config:
    baseUrl: http://dataops.internal.example
```

Trusted-LAN HTTP is the default contract. Internet-facing deployments explicitly use HTTPS. A published DSH origin also sets the same-scheme `callbackOrigin` and registers it in DataOps `AUTH_DSH_REDIRECT_ORIGINS`. HTTPS never falls back to HTTP. Deployment networking or the ingress proxy owns access to the DSH origin; the plugin does not break declared non-loopback deployments by requiring the TCP peer itself to be loopback.

A DataOps-managed container does not install this package. Managed mode uses the DataOps-owned Unix broker, keeps delegated credentials out of the DSH process, and exposes no standalone connection controls.

### Model Experience

**Prompt impact:** the package adds no system-prompt text. Once authorized, the generic MCP client registers the eight tool schemas supplied by DataOps; this package does not rewrite their names, inputs, or results.

**Token impact:** token use comes only from DataOps MCP tool schemas and actual tool results. The access credential, target owner, user ID, and permission fields never enter model context or tool arguments.

**KV-cache impact:** mounting or removing the DataOps tools changes the tool-schema prefix on later requests. There is no periodic removal or remount during an active AuthSession, so the package creates no background cache churn.

### Composition and distribution

- Cordis plugin: `@sparkelf/dsh-dataops-integration`
- npm publication: planned as a SparkElf package
- source owner: `SparkElf/dsh-plugins-plus`
- default composition: mounted by its installed bundle; the Plus default profile does not absorb DataOps-specific source
- upstream dependency: published DSH credential, Web route, Settings slot, and generic MCP client extension points only

### Known Limitations and Deferred Work

One `DSH_HOME` has no account switch, target unbind, or owner reset. When the bound owner's DataOps `AuthSession` ends, the user reconnects from Settings; the package does not extend that session in the background. The complete eight-tool query, chart, and analysis user acceptance is covered through the real DataOps and DSH Playwright path.
