# dsh-image-hoist

把工具结果里的图片搬到用户消息上，只对上游读不到 `function_call_output` 图片的路由生效。

## 为什么需要它

有些 OpenAI 兼容上游**声称**支持图片输入，但没实现 Responses API 里
`function_call_output.output` 的数组形式。图片以 data URL 到达工具结果后，会被**当成一段
base64 文本计费**，而不是按图片计价。两个后果都比"直接报错"更糟：

1. **请求爆炸** —— 实测一张 502 KB PNG 在该路由上算出 **466,303** prompt tokens；
   同样的字节挂到用户消息上只算 **991**。
2. **模型根本没看到图** —— 它只能从 base64 字符里瞎猜。探针图 `7391`，
   该路由答 `4217`，另一轮答 `7639`，都是看起来很合理的错误答案。

而且失败是静默的：上游把 400 包装成 `500 Upstream gateway error` 返回，
`isContextWindowExceededError()` 认不出这句话，所以既不会触发上下文超限恢复，
压缩也救不回来（压缩请求本身要发全部历史，同样被打回）。

## 它做什么

对配置里点名的路由，在**模型可见投影**里把图片从工具结果搬到最近的前置用户消息。
**持久化日志不动**：图片仍然属于产出它的那个工具结果，所以 Web UI、导出、
以及后来读这个会话的人看到的都还是原样。

```
read_image → tool/result（含 ImageBlock）
    ↓ session/event 观察（不 append）
    ↓ agent/pre-step：append 一条 image/hoist{targets}
    ↓ registerMessageProjection：把图片搬到用户消息
下一次 llm/stream：deriveMessages() 与请求一致 → 官方不变量通过
```

## 两条被实测纠正的机制

实现前我读过源码并跑了探针，两个"显然"的做法其实是错的：

- **不能把投影注册在 `tool/result` 上。** 标准 surface 事件挂了投影后会从 surface
  节点列表里消失，工具结果整条从历史里掉出去。只有非 surface 事件能拥有
  "改写其他消息"的投影，所以插件写的是自己的 `image/hoist` 行。
- **不能在 `session/event` 里 append。** 那个回调发生在会话自己的 append 发布窗口内，
  再 append 会抛 `session append cannot reenter`。所以搬运放在 `agent/pre-step`：
  循环在每次 `step/start` 前、以及随后的请求之前都会 await 它，且它在任何 append 窗口之外。

## 两个来自真实会话的顺序事实

- **surface 是模型可见顺序，不是 seq 顺序。** 一次 compaction 替换或 system prompt
  重写都会 splice 节点，列表可能长成 `931, 880, 469, …`。所以前后关系按**节点下标**判断，
  绝不能比较 seq 数值。
- **不是每个 `user/message` 都是用户的消息。** 目录每步注入 `time-context` 快照，
  compaction 插入 checkpoint，两者都是 user 角色行，而且**最近的那个通常是注入**。
  把图片挂到时钟行上会让它出现在 "Time sampled while preparing turn N" 下面，
  并在下一步被搬走。只有 `source.kind === 'user'` 的行才是候选。

当工具结果之前没有真实用户轮次时，图片属于**已被压缩替换掉的历史**，
此时承载它的 checkpoint 是诚实的落点：它是那段历史的摘要，位置稳定，
而且和 `time-context` 不同，它只写一次。跳过反而会把这些图片留在工具结果位置，
而那正是本插件要消除的形态。

## 配置

```yaml
- insert:
    - id: image-hoist
      name: '@sparkelf/dsh-image-hoist'
      config:
        providers:            # 空数组 = 完全禁用搬运
          - tokensfree_ds
        maxUserLookback: 200  # 向前搜索承载消息的节点上限
```

**默认完全不改变行为**：不点名 provider 就只是注册投影（用于回放已记录的搬运），
不做任何新的搬运。

## 验证

```bash
node test/projection.test.mjs        # 13 项折叠级检查，跑真实 foldSurface
node test/dryrun-real-session.mjs    # 对真实失败会话 dry-run
```

对真实失败会话（session-8303fedf，1445 事件）的 dry-run 结果：

```
before: {"user":1, "tool":8}   ← 8 张图卡在工具结果里
after : {"user":6, "tool":0}   ← 全部搬到用户消息，工具结果清零
surface nodes unchanged: true (331 -> 331)
node identity preserved: true
replay determinism on real data: true
```

镜像端到端（独立 DSH_HOME + 3081 端口，不碰生产）：

| | 插件 | 模型回答 | 说明 |
|---|---|---|---|
| 控制组 | 无 | **4217** | 错的数字，典型症状 |
| 实验组 | 有 | **7391** | 正确读出探针图 |

会话日志证明插件自动工作：

```
seq18  read_image 调用
seq19  tool/result（含图片）
seq21  image/hoist {targets:[{targetSeq:19, userSeq:8}]}   ← 插件自动写入
seq23  request/header（投影已生效）
```

## 已知约束

- **一旦会话里写过 `image/hoist`，读取该会话就必须挂载本插件。**
  官方在 `packages/core/session/lib/index.js` 里硬性要求：
  投影被移除时抛 `restore the session with its owning plugin`。
  未挂载时**新会话**不受影响，因为事件带 `ignorable: true`，官方读取器
  （`recoverable` 和 `strict` 两种模式均实测）会安全跳过。
- 上游兼容性无法探测。该缺陷是静默的，所以只能由**配置声明**哪些路由需要搬运。
- 这是请求期投影，不改变上游实际计价方式。上游修好后，把 provider 从列表里移除即可。

## 交付机制

**我们自己的插件挂在已发布扩展点上** —— 不 fork `@earendil-works/pi-ai`，
不改任何官方包，用公开的 `sessions.registerMessageProjection()` 与 `agent/pre-step`。
投影的结构照着官方的同类实现 `@deepseek-ai/dsh-compaction-image-offload` 写。
