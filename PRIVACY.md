# 隐私与数据边界 / Privacy

本说明对应 0.1.0。项目没有自建云服务或遥测收集。插件代码的请求与写入边界以 `addon/content/service.js` 和 `core.js` 为准。

## 本地读取和保存

打开阅读室时读取当前条目元数据、附件可用性、笔记与注释数量，并可读取个人库条目用于统计。点击分析才使用 Zotero PDF worker 提取本机 PDF 文字；不会自动下载缺失附件，不运行 OCR。

阅读状态、你填写的笔记、核对清单、阅读位置、分析及来源标识保存在 Zotero 数据目录的 `reading-room/state-v1.json`。分析可能包含论文原文摘录、条目和附件标识、模型名称与推断；上一份状态可保留为 `.bak`，写入使用 `.tmp`。这些数据并未加密，受操作系统和 Zotero 数据目录权限保护。备份、磁盘同步或同机其他软件可能访问它们。

插件可显式导出 JSON/Markdown 到你选择的位置。请自行判断导出内容是否包含受版权或保密约束的论文与个人笔记。

## 网络调用

- Zotero 可按自身插件更新设置访问 GitHub 的更新清单及安装包。此宿主更新行为不发送论文正文、笔记或模型密钥；GitHub 仍会接收普通网络请求信息。

- 初始化、查看文献、保存本地状态和抽取式预读不调用模型，也不自动探测端点。
- 只有提交“AI 分析…”对话框后，才向所选 OpenAI 兼容端点发送提取文字片段及页位置。默认是 `http://127.0.0.1:11434/v1/chat/completions`。
- 上限是前 12 个片段、最多 120000 字符，可能仅覆盖部分论文。请求包含模型名称和生成参数；若提供密钥，会使用 Authorization 请求头。
- 非本机端点需 HTTPS 和明确同意；群组文库禁止远程模型。请求不跟随重定向。内嵌用户名、密码、查询参数或片段的端点被拒绝。
- 密钥仅存于本次窗口/请求内存，插件不把它写入状态、导出或笔记。操作系统内存、宿主或端点自身的日志策略不由本插件控制。
- 本机服务可能自行调用云服务；“本机地址”并不替你担保其后续行为。选择远程服务前应确认你有权发送相关文本，并查阅其保留与训练政策。

## Zotero 写入和同步

本地状态保存不修改 Zotero 父条目元数据或原有用户笔记。点击“保存为新的 Zotero 分析笔记”才创建分析笔记；点击“同步阅读记录到个人库笔记”才创建或更新插件专用状态快照。群组笔记写入被拒绝。专用状态笔记若被手动编辑会触发冲突，插件停止覆盖。

Zotero 的账户和同步设置可能上传显式创建的个人库笔记；这是 Zotero 的同步行为，插件没有独立同步服务器。快照不是自动双向合并或自动恢复机制。

## 保留与删除

禁用或卸载保留本地侧文件及已创建笔记，避免自动删除研究记录。需要删除时，先导出/备份，再手动删除插件专用侧文件和你确认不再需要的插件笔记。删除已同步笔记可能由 Zotero 同步到其他设备。

## 公开反馈前检查

- 只使用虚构样例，或有权公开且已脱敏的最小复现。
- 删除真实文库标题、作者、DOI、正文、笔记、附件 key、个人目录和账户标识。
- 不上传真实文库数据库、状态文件、配置、完整调试日志或截图。
- 不提交密钥；误泄漏时先在相应提供方撤销，再私密告知维护者。

English: no plugin telemetry or automatic model requests. Local state and extracts remain in the Zotero data directory unless you explicitly export, call a chosen model, or create Zotero notes. Remote model use requires explicit HTTPS consent; group remote analysis and group note writes are blocked. Keys are not persisted by the plugin. Uninstalling preserves records.
