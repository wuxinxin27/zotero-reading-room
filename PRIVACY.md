# 隐私与数据边界 / Privacy

本说明覆盖 main 的 Unreleased 开发改动；正式版本仍为 0.2.0，Releases 应对照对应版本源码。项目没有自建云服务或遥测。本轮原生侧栏验收状态见[验证清单](docs/TESTING.md)。

## 本地文库与 PDF

插件只处理 Zotero 正常 PDF 阅读器中当前论文及其匹配附件，不枚举完整文库，不提供库目录、搜索、关注或批量入口；论文查找和切换由 Zotero 负责。库列表不挂载阅读室。侧栏按所属 `item-details.tabID` 获取 Reader，使用它的 PDF 附件及父论文关系；上下文缺失或不匹配时不挂载，不退回同论文的第一个 PDF。工具菜单及所选条目右键可打开单篇正常 PDF，不另开顶层阅读室窗口。页预览在本机渲染，最多缓存八页，不通过 localhost 对外提供附件，不下载缺失 PDF，不自动 OCR。

**手动选择阅读状态会修改父条目的保留标签**：仅管理 `阅读室/未读`、`阅读室/待读`、`阅读室/在读`、`阅读室/已读`、`阅读室/搁置` 五个精确名称，移除另外四个并保留当前一个。不删除普通标签、自动标签或其他 `阅读室/` 标签，不改题名等字段或原有笔记。个人库及具有编辑权限的群组条目可写标签；无权限、存在未保存编辑、缺少接口或写入失败时保留已保存的本地状态并提示未同步。可再次选择状态重试。启动、切换、笔记编辑、AI 分析及对话均不自动改变阅读状态或写这些标签。插件不再注册主文献树阅读状态列。

图表卡展示引用所在的真实原文页，不表示已识别图像、准确裁图或验证图表数值。PDF 页序可能与印刷页码不同。

## 保存内容与凭据

Zotero 数据目录下的 `reading-room/state-v1.json` 按文库 ID 和条目 key 保存阅读状态、笔记、清单、AI 结果与来源、标签同步结果、三个完整提示词，以及非秘密模型配置。分析缓存与成功对话另按 PDF 附件 key 区分；对话保存问题、回答及通过逐字校验的原文证据。失败或取消不追加半对问答，旧对话和旧分析保留。文件可能含自定义提示词、问题、原文摘录和模型推断；研究记录未加密，受数据目录和系统权限保护。原子写入使用 .tmp 并保留 .bak。

旧侧文件中的关注字段及后端旧目录、批量 API 仅兼容保留，当前没有界面入口或后台触发，不自动续跑。本轮不迁移或清理旧数据。

API 密钥不进入侧文件、分析、笔记、导出或公开源码。明确选择记住密钥后，插件先通过 Zotero OSKeyStore 加密，再把密文保存到本插件独立的 Services.logins 账户；Windows 使用 Zotero 系统密钥存储的 DPAPI 路径。安全存储失败会报错，不降级为明文。也可选择仅在当前会话使用密钥。复制 profile 到另一系统后可能无法解密，需要重新配置。

设置只显示是否已有密钥，不回显已存明文。同一目标留空密钥表示保留，主动清除只影响该目标的插件凭据。不同 provider 和规范化端点使用不同账户，不复制旧目标密钥。不修复、重置或删除 Zotero 或其他插件的登录库。

## 网络与授权

- 启动、切换论文、阅读原文、查看缓存或加载对话历史不请求模型。查看、编辑、保存及恢复提示词也不请求模型。模型发现仅在主动打开模型设置并满足相应许可后进行，不发送论文标题、正文或 PDF。
- 支持 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent 和 Ollama 原生 Chat；密钥只放对应协议的请求头，不放 URL。列表失败时可手填模型 ID。
- Loopback 地址可使用 HTTP；其他地址须 HTTPS。远程发现和正文分析分别授权，并保存显式 consentOrigin、consentProvider；换 host 或协议撤销旧许可，重新勾选并保存才授权新目标。正文许可用于显式分析及论文对话；群组论文禁止远程正文分析和对话。
- 明确点击当前论文的 AI 分析、重新分析或发送问题后，才可能向配置端点发送文本。同附件已有 AI 结果直接复用；改提示词不触发重跑或使旧缓存失效。显式重新分析成功后才替换，失败或取消保留旧结果。
- 最多选取 120000 个原文字符，独立摘录装入每包最多 16000 字符、最多十二包。预算内保留全部提取文字，超出时按标题线索与全文位置分布选取，包含末尾位置；引文不能跨独立摘录拼接。多包综合另请求一次，输入不超过 48000 字符，其中最多 48 条、共 28000 字符已匹配引文及关联候选发现；综合不额外上传未分析窗口，图表 PNG 不发送给模型，不增加审稿模型。
- 仅可见正文触发 `MODEL_JSON_INVALID` 时，同一阅读包、综合阶段或问答允许一次格式重新生成：再次发送原任务、同一来源及固定格式提醒，不回传失败的原始响应。每次请求阶段最多两次发送，可能增加一次模型调用和费用；鉴权、网络、截断、拒答、工具调用、未完成、凭据安全或结构/语义校验失败不自动重试。第二次仍失败时不覆盖已保存分析或追加问答。详见[协议说明](docs/API-PROVIDERS.md#输出解析与固定错误)。
- 每次论文对话发送当前问题（最多 6000 字符）、所选 PDF 的至多 8 段提取文字（共最多 24000 字符）及最近至多 10 条历史消息（共最多 12000 字符），并发送当前对话系统提示词。历史消息不作为原文证据；引文只与本次提交的单段原文校验。提取文字或引文匹配不代表全文理解，也不提供图像视觉理解。完整已保存历史不会全部重发。
- 提示词会发送给所选 API；新分析还保存实际分析提示词快照及 hash、覆盖策略、章节线索、提交及遗漏字符量，对话记录保存对话提示词 hash。覆盖信息是提取文字的提交记录，不证明模型理解或学术正确性。已保存自定义提示词不被新默认覆盖；恢复默认会重置三项，已有结果仍需显式重新分析才更新。请勿把密钥或无权外发的内容放入提示词或问题。自定义提示词不能关闭协议、权限、结构化输出和引文校验限制；默认全文见 [AI 提示词](docs/AI-PROMPTS.md)。
- 为兼容代理，用户消息同时携带明确任务及与 system 字段相同的冻结有效提示词（含固定输出协议）；综合指令也放入可信任务前缀。重复的提示词计入输入 token，前述片段/综合数据限额不包括它们。Anthropic 与 Gemini 请求输出额度均为 8192 token，服务可能另有限制，不保证用满或完整输出。
- 不跟随重定向，拒绝 URL 内嵌凭据、查询参数和片段。错误不回显服务正文或密钥。Zotero 可按更新设置访问 GitHub，但不向 GitHub 发送文库、笔记或模型密钥。

本机 API 可能自行转发云服务，其日志、保留和训练政策不由插件控制。发送论文前应确认相应权限与服务商的数据用途。重新分析、对话及长提示词可能增加 token 消耗与服务商费用；字符上限不是 token 或费用上限，插件不保证额度。

工科阅读改进只参考公开源码与一般证据原则，不安装或执行外部科学技能，也不引入 Docling/MinerU 等解析服务或依赖。参考克隆和受限索引留在仓库外，不随插件分发；不索引用户文库、PDF、提示词设置或真实分析结果。研究范围及验证限制见 [工科阅读说明](docs/ENGINEERING-READING.md)。

## 笔记、导出、同步与删除

AI 结果默认保存到本地侧文件；只有点击对应按钮才创建分析笔记或保存个人库状态快照，不覆盖原有用户笔记。插件状态笔记若被手动修改会停止覆盖并提示冲突，群组笔记写入被拒绝。

原生状态标签以及显式创建的个人库笔记可能随 Zotero 自身设置同步，群组标签还取决于群组权限。插件不会从原生标签自动导入、恢复或双向合并本地阅读状态。侧文件中的关注、配置、提示词、笔记、分析缓存与对话历史不随 Zotero 自动跨设备合并；专用状态笔记只提供显式快照，密钥不通过插件同步。导出 JSON/Markdown 可能含受版权或保密约束的研究记录，应自行选择分享范围；备份侧文件会包含其保存的对话和提示词。

“清空当前 PDF 对话”须明确确认，只删除当前父论文及所选 PDF 附件在侧文件中的已保存问答；其他附件、论文、分析、笔记、阅读状态、提示词和模型配置保留。清空不提取 PDF、不访问模型配置或凭据、不请求 API；后续提问不再附带已清空历史。同论文对话请求进行时拒绝清空，切换或取消后不对迟到的旧目标执行删除。原子保存仍保留上一份 `.bak`，它可能含清空前历史；已导出文件、已创建的 Zotero 笔记和外部备份不被清理，因此不保证安全擦除。

禁用、卸载保留侧文件、保留状态标签和专用笔记。清理前先导出备份，按来源手动处理，不要删除整份 Zotero 登录库。公开反馈仅提供虚构或有权公开的脱敏最小复现，不上传真实 profile、文库、配置、密钥、正文、问题、截图或完整日志。密钥误泄漏应先向服务商撤销。

English: no telemetry or hosted library. Only the current normal reader tab's PDF and parent paper are accepted; the plugin does not enumerate the complete library or mount a section in library-list views. Zotero handles browsing and switching. Legacy focus fields and catalog/batch APIs remain dormant for compatibility, without UI entry points or background invocation; no automatic migration or cleanup occurs. PDFs and page previews stay local. Explicit single-paper analysis or chat sends bounded text and prompts to the configured API under origin/provider permissions; remote group-paper requests are blocked. A visible-text JSON-format failure alone permits one regeneration using the original task/source plus a fixed formatting reminder, without replaying the invalid response; each failing reading packet, synthesis or chat may add one model call and charge. Other failure types do not retry. Cached analysis and history loading make no model requests. Successful chat pairs, citations, prompts and non-secret settings use the local sidecar; failed or cancelled sends do not append partial pairs. Confirmed history clearing affects only the current paper/PDF, makes no API call and excludes that history from future questions. Other records remain; the previous .bak snapshot, exports, Zotero notes and external backups may retain it, so this is not secure erasure. Manual reading status alone manages the five exact reserved tags listed above, preserving all other tags and fields; permission/write failures retain local state with a warning. Zotero may sync native tags and explicitly created personal-library notes, but does not automatically merge the sidecar or import tags back into local state. Opt-in remembered keys are OSKeyStore-encrypted before storage in the plugin's independent LoginManager account, without plaintext fallback. Provider token charges and data policies still apply. Uninstall preserves records and tags.
