# @sparkelf/dsh-univer-government-docs

## 中文

这是依赖 `dsh-univer-office` 的政府文档资产与 Skill 插件。它注册两份原生 Traditional `.univer` 模板：通用政务文档以显式段落格式样板驱动，正式红头文档以占位锚点和固定版式驱动。插件只注册可撤销的模板根和 `univer-government-docs` Skill，不新增模型 Tool。

模板按 GB/T 9704-2012 的 A4 版心参数和字号层级生成，并随包提供已获授权的方正小标宋简体、仿宋 GB2312、楷体 GB2312 和黑体字体文件；这些字体不受本仓库 MIT 许可证覆盖。当前 Univer Facade 没有经过验证的动态页码字段，因此模板不伪造自动页码。

开发安装时先确保 profile 中存在带 `univer_new(templateFile)` 和 `registerTemplateRoot` 的兼容 `dsh-univer-office`，再把本包作为 profile composition bundle 安装。卸载或禁用 bundle 会通过 Cordis 生命周期撤销模板根和 Skill provider。

## English

This plugin provides government-document assets and model instructions on top of `dsh-univer-office`. It registers two native Traditional `.univer` templates: an explicit-format general-government document and an anchor-driven official redhead document. The plugin registers only a reversible template root and the `univer-government-docs` Skill; it adds no model-facing Tool.

The templates follow GB/T 9704-2012 A4 text-area geometry and type hierarchy. Authorized Fangzheng Xiaobiaosong, Fangsong GB2312, Kaiti GB2312, and SimHei font binaries ship with the package and are excluded from the repository MIT license. The current verified Univer Facade has no dynamic current-page or total-page field, so the templates do not fake automatic page numbering.

For development installation, first provide a compatible `dsh-univer-office` build with `univer_new(templateFile)` and `registerTemplateRoot`, then install this package as a profile composition bundle. Disabling or removing the bundle unregisters both the template root and Skill provider through their Cordis lifecycles.
