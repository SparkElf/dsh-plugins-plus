# @sparkelf/dsh-officecli

## 中文

将官方 OfficeCLI 二进制接入 DeepSeek Harness。安装本包会安装固定版本的 `@officecli/officecli`，模型通过单入口 `officecli` 工具提交结构化 argv。

适配器不解释命令，只把 argv 交给官方二进制并返回 stdout/stderr；之所以不直接使用上游 MCP，是其当前工具说明含 DSH 模板语法冲突。OfficeCLI 仍直接读取和写入 workspace 内原始 `.docx`、`.xlsx`、`.pptx`。本包不渲染预览、不生成中间格式。文档完成后，回复中的原件路径由 Better Sidebar 打开。

## English

This package connects the official OfficeCLI binary to DeepSeek Harness. Installing it brings in the pinned `@officecli/officecli` package, and the model submits structured argv through one `officecli` tool.

The adapter does not interpret commands; it passes argv to the official binary and returns stdout/stderr. The upstream MCP surface is not used because its current tool description conflicts with DSH template syntax. OfficeCLI still reads and writes original `.docx`, `.xlsx`, and `.pptx` files in the workspace. This package renders no preview and creates no intermediate format. Better Sidebar opens the original path returned in the final response.
