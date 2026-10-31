# 隐私与数据边界 / Privacy

本说明覆盖 main 的未发布阅读工作区改动；正式 Releases 应对照对应版本源码。项目没有自建云服务或遥测。

## 本地文库与 PDF

文库目录只读取可访问库中的论文元数据，支持搜索、分页与关注筛选，不修改父条目、标签或原有笔记。选择论文会读取已在本机的 PDF，在 Zotero 捆绑 PDF.js 中显示原文。页预览也在本机渲染，最多缓存八页，不通过 localhost 对外提供附件，不下载缺失 PDF，不自动 OCR。

图表卡展示引用所在的真实原文页，不表示已识别图像、准确裁图或验证图表数值。PDF 页序可能与印刷页码不同。

## 保存内容与凭据

Zotero 数据目录下的 `reading-room/state-v1.json` 按文库 ID 和条目 key 保存阅读状态、关注标记、笔记、清单、AI 结果与来源，以及非秘密模型配置。文件可能含原文摘录和模型推断；研究记录未加密，受数据目录和系统权限保护。原子写入使用 .tmp 并保留 .bak。

API 密钥不进入侧文件、分析、笔记、导出或公开源码。明确选择记住密钥后，插件先通过 Zotero OSKeyStore 加密，再把密文保存到本插件独立的 Services.logins 账户；Windows 使用 Zotero 系统密钥存储的 DPAPI 路径。安全存储失败会报错，不降级为明文。也可选择仅在当前会话使用密钥。复制 profile 到另一系统后可能无法解密，需要重新配置。

设置只显示是否已有密钥，不回显已存明文。同一目标留空密钥表示保留，主动清除只影响该目标的插件凭据。不同 provider 和规范化端点使用不同账户，不复制旧目标密钥。不修复、重置或删除 Zotero 或其他插件的登录库。

## 网络与授权

- 启动、切换论文、阅读原文和查看缓存不请求模型。模型发现仅在主动打开独立模型设置并满足相应许可后进行，不发送论文标题、正文或 PDF。
- 支持 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent 和 Ollama 原生 Chat；密钥只放对应协议的请求头，不放 URL。列表失败时可手填模型 ID。
- Loopback 地址可使用 HTTP；其他地址须 HTTPS。远程发现和正文分析分别授权，并保存显式 consentOrigin、consentProvider；换 host 或协议撤销旧许可，重新勾选并保存才授权新目标。群组论文禁止远程正文分析。
- 明确点击 AI 分析或重新分析后，才向配置端点发送文本。同附件已有 AI 结果直接复用；显式重新分析成功后才替换，失败或取消保留旧结果。
- 最多十二个阅读片段、共 120000 字符。多片段综合另请求一次，输入不超过 48000 字符，其中已核验引文最多 28000 字符；综合不额外上传未分析页面，图表 PNG 不发送给模型。
- 不跟随重定向，拒绝 URL 内嵌凭据、查询参数和片段。错误不回显服务正文或密钥。Zotero 可按更新设置访问 GitHub，但不向 GitHub 发送文库、笔记或模型密钥。

本机 API 可能自行转发云服务，其日志、保留和训练政策不由插件控制。发送论文前应确认相应权限与服务商的数据用途。

## 笔记、导出、同步与删除

AI 结果默认保存到本地侧文件；只有点击对应按钮才创建分析笔记或保存个人库状态快照，不覆盖原有用户笔记。插件状态笔记若被手动修改会停止覆盖并提示冲突，群组笔记写入被拒绝。

显式创建的个人库笔记可能随 Zotero 同步。关注、配置及侧文件缓存不自动跨设备合并，密钥不通过插件同步。导出 JSON/Markdown 可能含受版权或保密约束的摘录和笔记，应自行选择分享范围。

禁用、卸载保留研究记录和专用笔记。清理前先导出备份，按来源手动处理，不要删除整份 Zotero 登录库。公开反馈仅提供虚构或有权公开的脱敏最小复现，不上传真实 profile、文库、配置、密钥、正文、截图或完整日志。密钥误泄漏应先向服务商撤销。

English: no telemetry or hosted library. PDFs and page previews stay local. Model calls require explicit actions and saved origin/provider permissions; cached analysis needs no model. Non-secret settings use the local sidecar. Opt-in remembered keys are OSKeyStore-encrypted before storage in the plugin's independent LoginManager account, without plaintext fallback. No automatic cross-device merge is provided. Uninstall preserves records.
