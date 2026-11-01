# 隐私与数据边界 / Privacy

本说明覆盖 main 的 Unreleased 开发改动；正式版本仍为 0.2.0，Releases 应对照对应版本源码。项目没有自建云服务或遥测。本轮原生侧栏验收状态见[验证清单](docs/TESTING.md)。

## 本地文库与 PDF

文库目录读取可访问库中的论文元数据，支持搜索、分页与关注筛选。默认在 Zotero 正常 PDF 阅读器右侧栏显示插件内容，不另开顶层阅读室窗口；原文由 Zotero 阅读器显示。页预览在本机渲染，最多缓存八页，不通过 localhost 对外提供附件，不下载缺失 PDF，不自动 OCR。

**手动选择阅读状态会修改父条目的保留标签**：仅管理 `阅读室/未读`、`阅读室/待读`、`阅读室/在读`、`阅读室/已读`、`阅读室/搁置` 五个精确名称，移除另外四个并保留当前一个。不删除普通标签、自动标签或其他 `阅读室/` 标签，不改题名等字段或原有笔记。个人库及具有编辑权限的群组条目可写标签；无权限、存在未保存编辑、缺少接口或写入失败时保留已保存的本地状态并提示未同步。可再次选择状态重试。启动、切换、关注、笔记编辑、AI 分析及对话均不自动改变阅读状态或写这些标签。

图表卡展示引用所在的真实原文页，不表示已识别图像、准确裁图或验证图表数值。PDF 页序可能与印刷页码不同。

## 保存内容与凭据

Zotero 数据目录下的 `reading-room/state-v1.json` 按文库 ID 和条目 key 保存阅读状态、关注标记、笔记、清单、AI 结果与来源、标签同步结果、三个完整提示词，以及非秘密模型配置。分析缓存与成功对话另按 PDF 附件 key 区分；对话保存问题、回答及通过逐字校验的原文证据。失败或取消不追加半对问答，旧对话和旧分析保留。文件可能含自定义提示词、问题、原文摘录和模型推断；研究记录未加密，受数据目录和系统权限保护。原子写入使用 .tmp 并保留 .bak。

批量队列及逐篇进度保留于当前服务会话内存，不是持久任务或重启自动续跑记录；已完成的论文分析照常写入侧文件。

API 密钥不进入侧文件、分析、笔记、导出或公开源码。明确选择记住密钥后，插件先通过 Zotero OSKeyStore 加密，再把密文保存到本插件独立的 Services.logins 账户；Windows 使用 Zotero 系统密钥存储的 DPAPI 路径。安全存储失败会报错，不降级为明文。也可选择仅在当前会话使用密钥。复制 profile 到另一系统后可能无法解密，需要重新配置。

设置只显示是否已有密钥，不回显已存明文。同一目标留空密钥表示保留，主动清除只影响该目标的插件凭据。不同 provider 和规范化端点使用不同账户，不复制旧目标密钥。不修复、重置或删除 Zotero 或其他插件的登录库。

## 网络与授权

- 启动、切换论文、阅读原文、查看缓存或加载对话历史不请求模型。查看、编辑、保存及恢复提示词也不请求模型。模型发现仅在主动打开模型设置并满足相应许可后进行，不发送论文标题、正文或 PDF。
- 支持 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent 和 Ollama 原生 Chat；密钥只放对应协议的请求头，不放 URL。列表失败时可手填模型 ID。
- Loopback 地址可使用 HTTP；其他地址须 HTTPS。远程发现和正文分析分别授权，并保存显式 consentOrigin、consentProvider；换 host 或协议撤销旧许可，重新勾选并保存才授权新目标。正文许可用于显式分析及论文对话；群组论文禁止远程正文分析和对话。
- 明确点击 AI 分析、重新分析、确认启动批量或发送论文问题后，才可能向配置端点发送文本。同附件已有 AI 结果直接复用；改提示词不触发重跑或使旧缓存失效。显式重新分析成功后才替换，失败或取消保留旧结果。
- 最多十二个阅读片段、共 120000 字符。多片段综合另请求一次，输入不超过 48000 字符，其中已核验引文最多 28000 字符；综合不额外上传未分析页面，图表 PNG 不发送给模型。
- 批量分析只处理开始前预览的明确选择，最多 1000 篇，按顺序执行；单篇失败继续后续目标，取消保留已完成结果。界面冻结运行中的模型与提示词设置；后端固定本批提示词，若其他调用更改模型、端点、许可或凭据则停止后续发送。后台不会自行扩展选择范围或在重启后续跑。
- 每次论文对话发送当前问题（最多 6000 字符）、所选 PDF 的至多 8 段提取文字（共最多 24000 字符）及最近至多 10 条历史消息（共最多 12000 字符），并发送当前对话系统提示词。历史消息不作为原文证据；引文只与本次提交的单段原文校验。提取文字或引文匹配不代表全文理解，也不提供图像视觉理解。完整已保存历史不会全部重发。
- 提示词会发送给所选 API；新分析还保存实际分析提示词快照及 hash，对话记录保存对话提示词 hash。请勿把密钥或无权外发的内容放入提示词或问题。自定义提示词不能关闭协议、权限、结构化输出和引文校验限制；默认全文见 [AI 提示词](docs/AI-PROMPTS.md)。
- 不跟随重定向，拒绝 URL 内嵌凭据、查询参数和片段。错误不回显服务正文或密钥。Zotero 可按更新设置访问 GitHub，但不向 GitHub 发送文库、笔记或模型密钥。

本机 API 可能自行转发云服务，其日志、保留和训练政策不由插件控制。发送论文前应确认相应权限与服务商的数据用途。批量、重新分析、对话及长提示词可能增加 token 消耗与服务商费用；字符上限不是 token 或费用上限，插件不保证额度。

## 笔记、导出、同步与删除

AI 结果默认保存到本地侧文件；只有点击对应按钮才创建分析笔记或保存个人库状态快照，不覆盖原有用户笔记。插件状态笔记若被手动修改会停止覆盖并提示冲突，群组笔记写入被拒绝。

原生状态标签以及显式创建的个人库笔记可能随 Zotero 自身设置同步，群组标签还取决于群组权限。插件不会从原生标签自动导入、恢复或双向合并本地阅读状态。侧文件中的关注、配置、提示词、笔记、分析缓存与对话历史不随 Zotero 自动跨设备合并；专用状态笔记只提供显式快照，密钥不通过插件同步。导出 JSON/Markdown 可能含受版权或保密约束的研究记录，应自行选择分享范围；备份侧文件会包含其保存的对话和提示词。

禁用、卸载保留侧文件、保留状态标签和专用笔记。清理前先导出备份，按来源手动处理，不要删除整份 Zotero 登录库。公开反馈仅提供虚构或有权公开的脱敏最小复现，不上传真实 profile、文库、配置、密钥、正文、问题、截图或完整日志。密钥误泄漏应先向服务商撤销。

English: no telemetry or hosted library. PDFs and page previews stay local. Explicit analysis, batch or chat actions send bounded text and prompts to the configured API under origin/provider permissions; remote group-paper requests are blocked. Cached analysis and history loading make no model requests. Successful chat pairs, citations, prompts and non-secret settings use the local sidecar; failed or cancelled sends do not append partial pairs. Manual reading status alone manages the five exact reserved tags listed above, preserving all other tags and fields; permission/write failures retain local state with a warning. Zotero may sync native tags and explicitly created personal-library notes, but does not automatically merge the sidecar or import tags back into local state. Opt-in remembered keys are OSKeyStore-encrypted before storage in the plugin's independent LoginManager account, without plaintext fallback. Provider token charges and data policies still apply. Uninstall preserves records and tags.
