# @sparkelf/dsh-office-viewer-fonts

## 中文

这是 Better Sidebar Office Viewer 的中文政务字体资产与工作流 Skill 插件。它向浏览器公开方正小标宋简体、仿宋、楷体、黑体与 Arial 的字体 URL 与常见 family 别名，使 DOCX、XLSX、PPTX 预览可以使用文档声明的真实字体。

包内共 17 个字体文件（Calibri 6 体、Arial 4 体、方正小标宋 2 体、仿宋 2 体、楷体 2 体、黑体 1 体），是这些字体的唯一来源：镜像只需从本包的 `assets/fonts` 安装一次，无需在基础层再放一份相同的二进制。

插件同时注册 `office-government-docs` Skill，指导模型通过 OfficeCLI 直接创建和修改 Office 原件，并在回复中给出可由 Better Sidebar 打开的文件路径。它不依赖 Univer、不注册 Office 编辑 Tool、不生成中间预览格式。

字体二进制由 SparkElf 获授权随本包分发，不受仓库 MIT 许可证覆盖。

## English

This package supplies Chinese government-document fonts and workflow guidance to Better Sidebar Office Viewer. It exposes browser URLs and common family aliases for Fangzheng Xiaobiaosong, Fangsong, Kaiti, SimHei, and Arial so DOCX, XLSX, and PPTX previews can use the fonts declared by each document.

The 17 font files it carries (six Calibri faces, four Arial faces, two Fangzheng Xiaobiaosong faces, two Fangsong faces, two Kaiti faces, and SimHei) are the single source for these fonts: an image installs them from this package's `assets/fonts` once instead of keeping a second copy in its base layer.

It also registers the `office-government-docs` Skill, which directs the model to create and revise original Office files through OfficeCLI and return a path that Better Sidebar can open. It has no Univer dependency, registers no Office editing tool, and creates no intermediate preview format.

The font binaries are distributed by SparkElf under authorization and are not covered by the repository MIT license.
