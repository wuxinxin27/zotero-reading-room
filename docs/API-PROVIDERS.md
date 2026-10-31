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

分析按各协议发送实际请求：Anthropic 使用独立的 `system` 和有界 `max_tokens`；Gemini 使用 `systemInstruction`、`contents` 和 JSON MIME 类型；Ollama 使用 `stream:false`、`format:"json"`；OpenAI 使用 Chat Completions 消息和 JSON 输出格式。字符串及常见文本块、JSON 代码围栏均按数据解析；不执行工具调用、HTML 或模型指令。输出仍通过六维结构及原文逐字证据校验，保留覆盖比例、取消和原子保存规则，并记录无密钥的 `provider`。

分析默认完全由 AI 生成，抽取式预读已移除。最多阅读前十二个片段、120000 字符；多片段另用一次不超过 48000 字符的有界综合，生成概述、阅读路径、六维解释与贡献子分类。综合仅使用已核验的阅读摘录，不上传额外未分析页。图表文字引用须精确匹配图号和引文；前端展示相应本机 PDF 原页，不向模型发送页预览 PNG，也不声称视觉解析。

AI 结果按论文身份及来源附件保存在侧文件；普通打开或再次分析命中缓存时不请求服务，且不要求可用密钥。只有显式“重新分析”使用 `force:true`，成功后替换；失败或取消保留旧结果。旧抽取式记录可读取为历史档案，但不充当新 AI 分析。

本次不包含 OpenAI Responses、Azure 专属认证、Bedrock、Vertex AI、OAuth、流式输出、图片或 PDF 文件上传。Anthropic 固定使用兼容性较广的 `2023-06-01` 版本；官方已新增 `2026-10-21` 版本，原版本和 `x-api-key` 仍有官方兼容说明。Gemini 若模型不支持请求的 JSON 输出格式会明确失败，可换支持该能力的模型。模型响应超过 100 万字符会被拒绝；该限制在 Zotero 接收响应后检查，不能代替网络层流量配额。

## 官方协议来源

2026-10-31 核查官方公开文档；验证过程只读取文档，测试全部使用合成 HTTP 响应，未调用真实付费模型 API。

- OpenAI Docs：[List models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。
- Anthropic：[Messages](https://platform.claude.com/docs/en/api/messages/create)、[List Models](https://platform.claude.com/docs/en/api/models/list)、[API overview（含 `x-api-key` 兼容说明）](https://platform.claude.com/docs/en/api/overview)、[Versions](https://platform.claude.com/docs/en/api/versioning)。
- Google：[Models 与分页/能力字段](https://ai.google.dev/api/models)、[generateContent](https://ai.google.dev/api/generate-content)、[API reference（`x-goog-api-key`）](https://ai.google.dev/api)。
- Ollama：[List models](https://docs.ollama.com/api/tags)、[Chat 与 JSON/stream 参数](https://docs.ollama.com/api/chat)。
- Zotero：[官方 HTTP 实现（取消、超时与禁止重定向）](https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/http.js)。
