# 模型协议与自动获取模型

Reading Room 的独立“模型设置”支持以下四种协议。填写地址、模型与密钥后保存配置，后续 AI 分析直接使用已存配置；已有同附件 AI 结果时直接复用。设置中可自动获取、刷新和搜索模型，或手填 ID；远程列表读取和正文分析分别授权。本文描述 main 未发布改动，正式版仍为 0.2.0。

| 协议 ID | 分析请求 | 模型列表 | 鉴权 |
| --- | --- | --- | --- |
| `openai`（默认） | `POST /v1/chat/completions` | `GET /v1/models` | `Authorization: Bearer …` |
| `anthropic` | `POST /v1/messages` | `GET /v1/models` | `x-api-key` 与 `anthropic-version: 2023-06-01` |
| `gemini` | `POST /v1beta/models/{model}:generateContent` | `GET /v1beta/models` | `x-goog-api-key` 请求头 |
| `ollama` | `POST /api/chat` | `GET /api/tags` | 本机通常无需密钥；若填写则使用 Bearer |

## 地址填写

可使用服务基础地址、带版本的基础地址或完整生成地址。代理前缀保留，例如：

| 选择协议 | 填写地址 | 分析地址 | 列表地址 |
| --- | --- | --- | --- |
| OpenAI | `https://host.example/proxy` | `/proxy/v1/chat/completions` | `/proxy/v1/models` |
| OpenAI | `https://host.example/proxy/v1/chat/completions` | `/proxy/v1/chat/completions` | `/proxy/v1/models` |
| Anthropic | `https://host.example/proxy/v1` | `/proxy/v1/messages` | `/proxy/v1/models` |
| Gemini | `https://host.example/proxy/v1beta/models/old:generateContent` | `/proxy/v1beta/models/所选模型:generateContent` | `/proxy/v1beta/models` |
| Ollama | `http://localhost:11434/api/chat` | `/api/chat` | `/api/tags` |

已有版本段不会再添加一次。Gemini 也保留显式指定的 `/v1`。完整地址末尾的旧 Gemini 模型名会替换为当前选择的模型。协议由选择框明确指定；不会根据主机名或错误响应切换协议，未知协议或明显冲突的完整路径会被拒绝。

仅允许无内嵌用户名、密码、查询参数和片段的 HTTP(S) 地址。`localhost`、`127.0.0.1` 和 `::1` 可用 HTTP；其余主机需要 HTTPS 和本次操作的远程许可。密钥只放请求头，不放查询参数。请求不跟随重定向，第三方代理需要直接提供目标地址。

## 列表行为和限制

- `getAIConfig()` 返回非秘密设置、是否已有密钥及安全存储能力；`saveAIConfig(config, {apiKey, rememberKey, clearKey})` 保存配置。密钥明确选择记住后，经 Zotero OSKeyStore 加密再存插件独立 LoginManager 账户；不记住则只在当前会话使用。安全保存失败不回退明文。同目标留空保留，主动清除只影响该目标。
- 远程许可必须同时显式匹配 `consentOrigin` 与 `consentProvider`。更换 host 或协议撤销旧许可；新目标重新勾选并保存即可授权。`listConfiguredModels()` 使用保存的配置和对应凭据；启动和普通阅读不调用它。

- `service.listModels({ provider, endpoint, apiKey, allowRemote, signal?, item? })` 返回 `{ provider, endpoint, models: [{ id, name }] }`；返回的 `endpoint` 是无分页参数的规范化列表地址。`provider` 省略时沿用 OpenAI 兼容协议。
- 只请求模型元数据，不提取 PDF、不上传标题或正文、不初始化阅读侧文件、不创建分析任务或 Zotero 笔记，也不保存密钥。可在群组文库读取列表，但群组论文的远程正文分析仍被拒绝。
- 模型去重后最多 500 项、最多 5 页；Anthropic 使用 `after_id`，Gemini 使用 `pageToken`，兼容服务显式返回 `has_more` 时 OpenAI 使用 `after`。不会跟随响应内任意下一页 URL。列表每次请求最多 30 秒，整个分页过程最多 60 秒；分析每个请求最多 120 秒。
- Gemini 仅保留 `supportedGenerationMethods` 包含 `generateContent` 的标准 `models/…` 项，返回 ID 去掉 `models/` 前缀。分析也接受用户手输的 `models/…` 前缀。
- 空列表合法。401/403 为鉴权错误；404/405/501 提示服务没有提供此协议的列表，可手工填写模型。其他 HTTP 错误和错误 JSON 使用固定提示，不展示响应正文或服务抛出的错误信息。
- `AbortSignal` 和服务关闭均会终止等待，并调用 Zotero 的 `cancellerReceiver`。即使底层适配器未及时结束，请求也不能返回取消后的结果或保存分析。窗口还需要以自己的请求序号忽略过时结果。

列表只表示服务公布了这些模型，不保证模型支持文本对话、JSON 输出、当前权限或当前可用额度。OpenAI `/models` 也可能包含仅支持嵌入、音频或其他接口的模型；插件不会发送测试正文来探测能力。未提供标准模型列表的代理可继续手工输入。

分析与论文对话均按所选协议发送实际请求：Anthropic 使用独立的 `system` 和 `max_tokens:8192`；Gemini 使用 `systemInstruction`、`contents`、JSON MIME 类型和 `maxOutputTokens:8192`；Ollama 使用 `stream:false`、`format:"json"`；OpenAI 使用 Chat Completions 消息和 `response_format:{type:"json_object"}`。这不保证模型支持相应格式或能在输出上限内完成。实际系统文本由可编辑学术指令、两个换行和对应任务的固定只读输出协议组成；四协议同时在用户消息中放入明确任务及同一份冻结提示词，综合指令也置于可信任务前缀。数据限额不包含重复的提示词和协议，长提示词可能挤占上下文。两份协议、实际文本及版本/hash/保存来源见 [AI-PROMPTS.md](AI-PROMPTS.md)。

分析默认完全由 AI 生成，抽取式预读已移除。当前流程先规划来源：不超过 120000 字符时保留全部提取文字，超出时按标题线索与全文位置分布选取，包含末尾位置；不是只读取开头。独立摘录按每包最多 16000 个原文字符、最多 12 包发送，一个包可含多个物理页，页边界与摘录独立保留。多包另用一次不超过 48000 字符的有界综合，其中最多 48 条、共 28000 字符已匹配引文及以 `evidenceIds` 关联的候选发现；按维度、证据包及章节线索分配，图表候选最后加入。综合不上传额外未分析窗口，维度及叙述引文只接受单条获准综合摘录；额外保留的阅读阶段图表候选可能未进入综合输入，仍只标为文字匹配候选。图表文字引用须匹配图号和引文；独立图表卡片已移除，正文内联证据仍可导航并按需预览相应本机 PDF 原页，不向模型发送页预览 PNG，模型没有图表视觉理解。

默认分析与综合指令关注工科机制、假设、实验条件、基线、消融、失败边界与复现报告。当前固定协议 v4 指导约 3200 中文字符的分析叙述，有依据的丰富维度可约 800 字符；不是硬性字数、token 或质量保证。Anthropic/Gemini 的 8192 输出额度本轮不变，不增加审稿模型。仅 JSON 格式错误的一次重新生成规则见下节。新覆盖字段及公开参考比较见 [ENGINEERING-READING.md](ENGINEERING-READING.md)。

AI 结果按论文身份及来源附件保存在侧文件；普通打开或再次分析命中缓存时不请求服务，且不要求可用密钥。只有显式“重新分析”使用 `force:true`，成功后替换；失败或取消保留旧结果。已保存的自定义提示词不被新默认覆盖，恢复默认会重置三项提示词；保存或恢复后，已有论文仍需显式重新分析才使用新设置和流程，不必删除缓存。旧抽取式记录可读取为历史档案，但不充当新 AI 分析。

本轮侧栏精简不改请求、提示词、输出协议版本或缓存：`readingGuide` 改用“精读重点”标题，现有默认已要求具体核对问题及可用章节/图表定位。`figureTableReferences` 候选、校验及 JSON 导出和完整覆盖元数据继续保留；侧栏仅显示简要文字提交覆盖与限制，不再显示范围/章节矩阵。固定人工核对框及其自动保存、Markdown 固定清单已移除，旧 `checklist` 仍由侧文件、Core/Service、JSON 和显式原生状态笔记快照兼容保留。

`service.clearConversation(item, { attachmentID, signal } = {})` 只清除匹配父论文及所选 PDF 的已保存历史，返回该附件的空对话；无历史时重复调用不写文件。界面须明确确认，当前 PDF 的调用须传入对应附件 ID。此操作不读取模型配置或凭据、不提取 PDF、不调用 API；同父论文存在活动对话时返回 `CHAT_RUNNING`。目标在异步解析及串行写入前再次校验，支持取消，避免切换后误清理；其他论文/PDF、分析、笔记、状态与配置保留。后续问答不再携带该历史，原子保存仍将清空前快照保留为 `.bak`，导出及 Zotero 笔记不被清除，不保证安全擦除。

## 输出解析与固定错误

协议 v4 在既有综合输入内优先加入最多 12 段、每段至多 1000 字符的已读原文核对上下文，再加入候选发现。贡献编号、种子、成本、局限和表格列信息仅作为可检查来源，不作自动事实判断；仍共用 48 条摘录、28000 引文字符及 48000 综合数据字符，不为核对上下文新增模型阶段。输入另提供一基 `pageNumber` 供叙述使用；返回引用的机器地址仍为零基 `pageIndex`。

四种协议共用同一条有界解析路径，分析和对话使用各自的固定输出协议与后续结构校验。只读取相应协议的可见文本字符串或文本块，不把独立的 reasoning/thinking 字段当作答案。先检查已提供的完成状态、截断、拒答/安全拦截和工具调用标记，再解析文本；即使正文看似完整 JSON，也不能覆盖明确的失败状态。缺少或未知的完成标记保持兼容，不据此伪造成功或强制拒绝。

固定协议要求直接返回一个 JSON 对象。为兼容部分模型，解析器也允许一个完整的 `json` 或无语言标签 Markdown 围栏，围栏外可有普通说明；允许完整的前置 `<think>…</think>` 包装（围栏和 think 各最多一层）、普通说明中唯一且完整的 JSON 对象，以及整体 JSON 字符串内多编码一次的完整对象。只对完整外层做有限去包装/解码；隐藏推理不显示、不保存，也不作为来源。普通说明不能包含另一个候选对象或破损结构；未闭合、不支持的语言标签、额外围栏和多个对象均拒绝。不接受数组、标量或更多编码层，也不补括号、修补 JSON 语法或拼接多个结果。

| 错误码 | 条件与处理 |
| --- | --- |
| `MODEL_OUTPUT_TRUNCATED` | 服务明确报告长度/token 截断；拒绝本次结果，提示核对服务输出上限或精简提示词 |
| `MODEL_OUTPUT_INCOMPLETE` | 服务明确报告未完成、仍在生成/排队或暂停；拒绝保存 |
| `MODEL_OUTPUT_REFUSED` | 服务明确拒答或报告安全拦截；拒绝保存 |
| `MODEL_OUTPUT_TOOL_ONLY` | 服务报告工具调用结束，或只返回工具调用而没有可用文本；不执行工具或保存结果 |
| `MODEL_REQUEST_FAILED` | 服务报告失败或错误；提示核对端点、协议与服务状态 |
| `MODEL_JSON_INVALID` | 可见正文不是完整、无歧义的 JSON 对象，包括纯自然语言、破损 JSON、错误顶层类型或不支持的包装；只允许下述一次重新生成，仍失败则拒绝保存 |
| `MODEL_SCHEMA_INVALID` | JSON 的分析 `dimensions` 缺失、类型错误或条目数超限；拒绝保存 |
| `INVALID_MODEL_OUTPUT` | 响应/可见文本为空或超限，或未通过凭据、转义等安全检查；保留兼容通用错误，拒绝保存 |
| `CHAT_STRUCTURE_INVALID` | 对话误返回带 `dimensions` 的分析任务结构 |
| `CHAT_ANSWER_INVALID` / `CHAT_ANSWER_TOO_LONG` | `answer` 不是非空字符串，或原始字符串超过 12000 字符 |
| `CHAT_EVIDENCE_INVALID` / `CHAT_EVIDENCE_TOO_MANY` | `evidence` 不是数组，或候选条目超过 16 项 |

对话若有合法且有界的 `answer`，但 `evidence` 缺失或为 `null`，兼容为空数组并明确显示“未核验／信息不足”，不会制造引文。数组中的每条候选引文继续与本次实际提交的单段原文及其页索引核对；错误页、未提交页、历史消息或跨段拼接不能成为有效证据，未通过的候选被拒绝。分析仍做六维及原文证据校验，综合引文还须来自单条获准摘录；包装兼容不放宽来源边界。文字匹配不证明引文支持结论。

仅 `MODEL_JSON_INVALID` 触发一次有界格式重新生成：在同一 `_requestModel` 内重新发送原任务、同一来源与固定格式提醒，不把失败的原始响应作为上下文或修复材料。每个阅读包、综合阶段或问答最多发送两次；出现此错误的每个阶段可能额外增加一次模型调用、输入/输出 token 与费用。重新生成仍经过相同的完成状态、凭据、对象、结构和来源校验，不保证任意模型输出都能恢复。

上述错误使用固定本地提示，不显示上游响应正文、隐藏推理或 API 密钥。鉴权、网络、截断、拒答、工具调用、未完成、凭据/安全、结构及语义校验失败不触发重新生成；不切换协议/模型或动态提高输出额度。第二次仍失败或取消时，不替换旧分析、不追加半对问答；需要用户核对配置后显式重试。协议或提示词变化也不会自动重新分析旧缓存。

本次不包含 OpenAI Responses、Azure 专属认证、Bedrock、Vertex AI、OAuth、流式输出、图片或 PDF 文件上传。Anthropic 固定使用兼容性较广的 `2023-06-01` 版本；官方已新增 `2026-10-21` 版本，原版本和 `x-api-key` 仍有官方兼容说明。Gemini 若模型不支持请求的 JSON 输出格式会明确失败，可换支持该能力的模型。模型响应超过 100 万字符会被拒绝；该限制在 Zotero 接收响应后检查，不能代替网络层流量配额。

## 官方协议来源

2026-10-31 核查官方公开文档；验证过程只读取文档，测试全部使用合成 HTTP 响应，未调用真实付费模型 API。

- OpenAI Docs：[List models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。
- Anthropic：[Messages](https://platform.claude.com/docs/en/api/messages/create)、[List Models](https://platform.claude.com/docs/en/api/models/list)、[API overview（含 `x-api-key` 兼容说明）](https://platform.claude.com/docs/en/api/overview)、[Versions](https://platform.claude.com/docs/en/api/versioning)。
- Google：[Models 与分页/能力字段](https://ai.google.dev/api/models)、[generateContent](https://ai.google.dev/api/generate-content)、[API reference（`x-goog-api-key`）](https://ai.google.dev/api)。
- Ollama：[List models](https://docs.ollama.com/api/tags)、[Chat 与 JSON/stream 参数](https://docs.ollama.com/api/chat)。
- Zotero：[官方 HTTP 实现（取消、超时与禁止重定向）](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/http.js)。
