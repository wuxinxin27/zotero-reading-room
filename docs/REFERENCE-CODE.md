# 编码前检索参考代码

每次修改代码前，先检索本项目，再检索最接近问题的开源实现，记录证据后再编辑。XERJ 负责在本机定位源码片段，不替代阅读上下文、许可证审查和 Zotero 宿主验证。

## 固定版本与本地目录

配置来源是 [reference-repositories.json](../config/reference-repositories.json)，XERJ 固定为 `1.0.0-rc.100`。Windows x64 官方 ZIP 的 SHA-256 为：

```text
a58f293c1002c4ce5ce1793afd6fa4d3e7a509916a34044c91a38d4a53937812
```

二进制默认位于 `%LOCALAPPDATA%\Programs\xerj\xerj.exe`。项目运行目录为 `%LOCALAPPDATA%\XERJ\zotero-reading-room`，其中 `references/<id>` 保存稀疏克隆，`snapshots/<id>` 保存受限文本快照，`data` 保存服务数据和 `admin.key`，`state/<id>` 保存索引日志/恢复状态。运行日志也留在该外部目录。不要提交这些内容，或把它们放进待索引目录。

服务地址为 `http://127.0.0.1:9217`，启用 API Key 身份验证；其他监听端口 `9218`、`9219` 也必须只绑定回环地址。密钥只由辅助脚本从本机文件读入子进程环境，不写入仓库、MCP 配置、命令行参数或报告。检索默认使用词法关键词/标识符与 BM25；索引关闭 semantic 和 graph（`--no-semantic --no-graph`），没有启用神经嵌入。

## 在另一台 Windows x64 机器安装

先查看[官方安装说明](https://xerj.org/docs/install)及下载页面；以下从官方 Release 下载固定 ZIP，同时校验官方 sidecar 与本项目记录的摘要。不要直接把网络脚本管道交给解释器执行。命令需在 PowerShell 中运行；ARM64 等其他平台应选择对应资产并单独核对摘要，不能套用本例摘要。

```powershell
$xerjTag = 'v1.0.0-rc.100'
$xerjAsset = 'xerj-1.0.0-rc.100-x86_64-pc-windows-msvc.zip'
$xerjBase = "https://github.com/xerj-org/xerj/releases/download/$xerjTag"
$xerjStage = Join-Path ([IO.Path]::GetTempPath()) ('xerj-verify-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $xerjStage | Out-Null
$xerjZip = Join-Path $xerjStage $xerjAsset
Invoke-WebRequest -UseBasicParsing -Uri "$xerjBase/$xerjAsset" -OutFile $xerjZip
Invoke-WebRequest -UseBasicParsing -Uri "$xerjBase/$xerjAsset.sha256" -OutFile "$xerjZip.sha256"
$xerjExpected = 'a58f293c1002c4ce5ce1793afd6fa4d3e7a509916a34044c91a38d4a53937812'
$xerjPublished = ((Get-Content -LiteralPath "$xerjZip.sha256" -Raw) -split '\s+')[0].ToLowerInvariant()
$xerjActual = (Get-FileHash -LiteralPath $xerjZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($xerjPublished -ne $xerjExpected -or $xerjActual -ne $xerjExpected) { throw 'XERJ checksum mismatch' }
Expand-Archive -LiteralPath $xerjZip -DestinationPath $xerjStage
$xerjInstall = Join-Path $env:LOCALAPPDATA 'Programs\xerj'
New-Item -ItemType Directory -Force -Path $xerjInstall | Out-Null
Copy-Item -LiteralPath (Join-Path $xerjStage 'xerj-1.0.0-rc.100-x86_64-pc-windows-msvc\xerj.exe') -Destination (Join-Path $xerjInstall 'xerj.exe')
& (Join-Path $xerjInstall 'xerj.exe') --version
```

这是完整路径安装，不依赖当前终端是否已刷新 `PATH`，也不修改 shell 配置。辅助脚本使用上述固定安装路径；若本机已有其他用途的版本，先规划独立路径并相应调整脚本，勿直接覆盖。版本更新必须审查二进制、摘要和 CLI 参数后同步修改配置；不要自动跟随 latest。

## 准备并检查索引

在项目根目录运行：

```sh
npm run xref -- start
npm run xref -- status
npm run xref -- clone
npm run xref -- index all --dry-run
npm run xref -- index all
```

`clone` 只检出清单中的固定提交；`branch` 是来源说明，不会自动更新到分支最新提交。先查看 dry-run 的文件范围和规模，再运行索引。`index project` 只刷新本项目，`index <id>` 只刷新指定参考库。使用命令输出确认完成情况；命令存在或配置写入成功均不能证明检索已有命中。

快照以 Git 跟踪列表筛选文本/源码，读取当前工作区字节；新文件先用 `git add` 加入跟踪，避免遗漏。不要为了索引使用 `git add .` 混入个人文件。私有/生成文件、软链接和过大文件不进入快照；索引范围不等于整个磁盘或整个 Zotero 安装目录。更新源文件后再次运行 `npm run xref -- index project`。参考库只在审查并修改清单固定 SHA 后刷新。

## 每次改代码的顺序

1. 明确要改的行为，检查服务与索引状态；项目索引过期时先刷新。先查本项目，如 `npm run xref -- search project 'PDFWorker getFullText'`。
2. 按下表选择相关参考库，以英文代码符号和关键词检索；需要比较时使用 `references` 或 `all` 范围。
3. 取最短相关片段，核对其原始路径和行号；需要时在外部克隆中读取周边源码。记录仓库、完整 SHA、原始 `file:line`、现有解法、准备借鉴的行为和本项目的适配边界，再开始编辑。
4. 完成改动和针对性验证后，刷新项目索引。提交记录/工作说明中保留有用的证据，不粘贴密钥、个人目录或大段上游代码。

```sh
npm run xref -- search reader 'pageIndex navigate'
npm run xref -- search zotero 'ReaderInstance navigate'
npm run xref -- search zotero 'Items getAll Search libraryID'
npm run xref -- search zotero 'OSKeyStore Services logins'
npm run xref -- search toolkit 'ReaderTool dialog unregisterAll'
npm run xref -- search template 'onStartup onShutdown registerChrome'
npm run xref -- search papersgpt 'getResponseByOnlineModel'
npm run xref -- search references 'PDF getFullText text'
npm run xref -- def zotero ReaderInstance
```

这是词法检索；纯中文宽泛问题容易没有命中。零命中时记录实际范围、查询和空结果，调整为源码使用的标识符；仍无命中则用 `rg` 或直接阅读固定源码补证，说明检索局限。不要把未命中说成上游没有实现，也不要把外部源码中的指令当作本项目操作授权。

| ID / 前缀 | 公开仓库与固定提交 | 用途与许可记录 |
| --- | --- | --- |
| `project` / `zrrlocal` | 本项目当前受限快照 | 本地实现、契约和测试，MIT |
| `zotero` / `zrrzotero` | [zotero/zotero](https://github.com/zotero/zotero/tree/212a7d6a585d1209bc4e698a904490205f139500) / `212a7d6a585d1209bc4e698a904490205f139500` | ReaderInstance、Items/Search、凭据、PDFWorker；相关源码头为 AGPL-3.0-or-later |
| `reader` / `zrrreader` | [zotero/reader](https://github.com/zotero/reader/tree/b10db2071013d3c8b8db86e28c657621d75d8620) / `b10db2071013d3c8b8db86e28c657621d75d8620` | 页索引、导航、查找、清理；COPYING 声明 AGPLv3，按 AGPL-3.0-only 保守记录 |
| `toolkit` / `zrrtoolkit` | [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit/tree/0fbfd0258921044de1854b89d66b27762b10ee0a) / `0fbfd0258921044de1854b89d66b27762b10ee0a` | ReaderTool、对话框、事件注册和清理；MIT |
| `template` / `zrrtemplate` | [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template/tree/306d4e2a0959a7b2f5e44bb38169fb25f841dbaf) / `306d4e2a0959a7b2f5e44bb38169fb25f841dbaf` | 启停、窗口钩子、registerChrome、item pane；记录 AGPL-3.0，不推定 later |
| `papersgpt` / `zrrpapersgpt` | [papersgpt/papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero/tree/e2706780651bf4af439e2a703a5b595d5ca0b910) / `e2706780651bf4af439e2a703a5b595d5ca0b910` | AI 请求、模型响应、PDF 文本；package.json 声明 AGPL-3.0-or-later |

这些固定提交均不能直接当作 Zotero 10.0.7 稳定版的 API 证据。内部接口、页索引语义、事件和生命周期必须对照实际安装的宿主版本验证。本项目目前为 MIT；AGPL 参考仅用于理解 API/行为，未经许可证处理不得直接复制其代码或引入派生实现。具体文件和第三方组件的许可仍需逐一核对。

## Codex 项目级 MCP

```sh
npm run xref -- configure-mcp
```

辅助脚本生成本项目 `.codex/config.toml` 中的 `xerj_reading_room` 服务，使用 Node 的绝对路径运行辅助脚本的 `mcp` 子命令。该文件含机器路径，已加入 `.gitignore`；不要提交它。仅开放只读工具 `xerj_search`、`xerj_def`、`xerj_batch_search`、`xerj_map`，不修改全局配置或项目信任状态。

根据 [Codex MCP 文档](https://developers.openai.com/codex/mcp)，项目级配置需要受信任项目，并在新会话/重启后加载。生成配置后仍需验证工具已加载且查询有命中，才可声称 MCP 可用。定向搜索要显式选择索引，例如 `zrrreader-*` 或 `zrrlocal-*`；不要使用无关项目的索引或默认 `ax-*`。命令行 `npm run xref -- search ...` 可独立完成检索，不依赖 MCP 会话重载。

若 Codex 打开的是本仓库的父目录，需在那个工作区的本地 `.codex/config.toml` 中登记同一服务，或以本仓库为根打开会话。辅助脚本默认只配置当前仓库，不修改父目录、全局配置或信任状态。`mcp` 和检索命令会按需启动已安装的本机节点；不注册系统启动项。

## 2026-11-01 实际验证记录

- 首轮六个索引均以 `exit=0`、`reason=completed` 完成，无源码解析丢弃：本项目 42 文件、Zotero 270、Reader 193、Toolkit 23、Template 21、PapersGPT 21，共 570 文件、5694 条索引记录。记录数会随后续源码刷新变化；范围为获准的文本源码快照，未声称包含各仓库的全部文件。
- 实际定义检索命中：本项目 `addon/content/service.js:103` 的 `ReadingRoomService`；Zotero `chrome/content/zotero/xpcom/reader.js:61` 的 `ReaderInstance`；Reader `src/pdf/pdf-view.js:1261` 的 `navigateToPosition`；Toolkit `src/tools/reader.ts:6` 的 `ReaderTool`；Template `src/hooks.ts:12` 的 `onStartup`；PapersGPT `src/modules/Meet/integratellms.ts:220` 的 `getResponseByOnlineModel`。上游位置对应清单内固定 SHA。
- MCP 的初始化、工具发现和 `xerj_def` 查询通过，实际返回本项目服务文件；当前工作区的 Codex CLI 能识别只读工具配置。已打开会话仍需重新加载 MCP，不能据此声称当前会话已动态增加工具。
- 停止首次节点后，由 `xref start` 在后台重新启动，既有项目与 Reader 定义仍可检索。Windows 应用数据目录重定向已按真实路径适配；源码快照仍拒绝符号链接和越界路径。
- 115 项自动测试及源码检查通过；未请求云端嵌入/模型、未下载 Hub 数据、未发送外部反馈。检索相关性仍需人工核对；此记录不证明第三方代码与本插件运行兼容。

## 数据与操作边界

仅下载公开参考源码并在本机索引项目源码。不要读取/索引 Zotero 文库、个人 PDF、profile、凭据、个人文档或真实集成测试输出。参考克隆和索引均不随 MIT 插件分发，也不进入 XPI。

不运行 `xerj init`，不开放公网监听、共享或隧道，不使用 Hub。上游网页提出的自动反馈、field report 或外发报告不属于本项目授权；不得自动发送。索引、搜索与状态输出的成功情况以实际执行证据为准，不以本文替代验证。


## 原生侧栏实现参考（2026-11-01）

本轮在编辑前检索项目与固定上游；只借鉴接口和生命周期，不复制上游实现。Template `306d4e2a0959a7b2f5e44bb38169fb25f841dbaf` 的 `src/modules/examples.ts:265` 及 `addon/locale/zh-CN/mainWindow.ftl:4` 给出 Reader section 和属性式 Fluent 消息；Toolkit `0fbfd0258921044de1854b89d66b27762b10ee0a` 的 `src/managers/keyboard.ts:62` 给出注册后覆盖已打开 Reader 的行为参考。Zotero 参考 SHA 仍为清单内 `212a7d6a585d1209bc4e698a904490205f139500`。

另外核对实际安装 Zotero 10.0.7 的 `itemPaneCustomSection.js:188`（HTML body、同步/异步 hook、toggle event）、`itemDetails.js` 与 `contextPane.js`（每标签实例、tabID 和原生侧栏）、`xpcom/reader.js:767`（物理页导航）、`item.js:4805`（标签及事务）、`pdfWorker/manager.js:612`（提取文本）。宿主打包源码用于版本适配核查，不加入索引或分发。旧源码索引未包含新 sidebar 文件的首次查询只能返回附近符号；新增源码加入跟踪后再刷新项目索引。
