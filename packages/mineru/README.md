# @sparkelf/dsh-mineru

## 中文

本包为DeepSeek Harness增加`mineru_parse_pdf`模型工具。Official DSH持有文件上传、持久存储、消息卡片及向模型显示的只读路径；本工具接受该路径，调用配置的MinerU `/file_parse` endpoint，并返回解析后的Markdown、content-list及提取图片名称。

本包没有prompt hook、attachment provider、browser client或Office parser。DOCX、XLSX及PPTX使用`@sparkelf/dsh-officecli`。

将`DSH_MINERU_ENDPOINT`设为同步MinerU endpoint；变量缺失时bundle保持禁用。

## English

This package adds the `mineru_parse_pdf` model tool to DeepSeek Harness. Official DSH owns file upload, durable storage, message cards, and the read-only path shown to the model. The tool accepts that path, calls the configured MinerU `/file_parse` endpoint, and returns the parsed Markdown plus content-list and extracted-image names.

The package has no prompt hook, attachment provider, browser client, or Office parser. Use `@sparkelf/dsh-officecli` for DOCX, XLSX, and PPTX files.

Set `DSH_MINERU_ENDPOINT` to the synchronous MinerU endpoint. The bundle stays disabled when the variable is absent.
