# 开发与构建

## 环境和结构

需要 Node.js 22+。工具仅用 Node 内置模块，不运行安装脚本，不需要 npm 包、Python 或网络。

| 路径 | 职责 |
| --- | --- |
| `addon/manifest.json`、`bootstrap.js` | Zotero 插件标识、兼容范围、启停生命周期 |
| `addon/content/core.js` | 无文件/网络访问的领域逻辑：状态、提取候选、分页、证据、提供商元数据和端点规范化 |
| `addon/content/service.js` | Zotero、PDF worker、本地侧文件、多协议模型发现/请求、专用笔记适配 |
| `addon/content/room.*`、`addon/locale/` | 阅读室与宿主入口、样式、语言资源 |
| `tests/core.test.mjs`、`tests/service.test.mjs`、`tests/fixtures/` | 虚构文库、PDF 提取结果、存储与 HTTP 测试适配器 |
| `tests/package.test.mjs` | 独立读取 ZIP 结构、检查标准 CRC 向量、复现性、源文件边界与发布校验 |
| `scripts/` | 检查与确定性 ZIP32 打包 |

`core.js` 和 `service.js` 以特权子脚本加载，不依赖 Node 的模块解析或第三方运行库。Node 只用于开发与构建，不随插件分发。

## 命令

```sh
npm test
npm run check
npm run build
node scripts/check.mjs --tag v0.2.0
```

`check` 校验 package/manifest 版本、固定插件 ID、Zotero 10.0–10.* 范围、必需资源、源文件类型与 JavaScript 语法。它不替代宿主运行、界面和 PDF worker 实测。

`build` 只读取 `addon/`，在 ZIP 根目录写入插件文件。拒绝软链接、隐藏文件、常见状态/凭据文件名与非运行时源文件扩展名。只允许 `.js`、`.json`、`.xhtml`、`.css`、`.svg`、`.ftl`。新增资源类型需审查后修改构建策略。不要把任何个人数据放入 `addon/`；类型校验不能判断任意源文件正文是否含秘密。

标准 ZIP32 使用 stored 条目、UTF-8 文件名、字典序、固定 1980-01-01 时间和 0644 文件权限，无机器路径、环境时间或目录条目。`.gitattributes` 统一文本换行。相同源文件内容产生相同 XPI；改变换行或任意源字节会改变校验和。

输出为 `dist/zotero-reading-room-<version>.xpi` 和只含该 XPI 的 `dist/SHA256SUMS`。`dist/` 不提交 Git。打包失败不会清空先前产物，因此发布应使用 CI 的干净工作区，不能把旧文件误认为本次成功构建。

## 宿主与数据契约

插件 ID 为 `zotero-reading-room@wuxinxin27.github.io`，不要在更新中更换。版本由 `package.json` 与 manifest 一起更新。首版只声明 Zotero 10，初始实机目标为 10.0.7；不要未经验证扩大范围。

`ReadingRoomCore` 是纯逻辑接口，`ReadingRoomService` 持有存储、分析与笔记方法，`ReadingRoomUI` 管理宿主入口。提供商元数据由 `Core.API_PROVIDERS` 提供；模型发现接口为 `service.listModels({ provider, endpoint, apiKey, allowRemote, signal, item })`，返回规范化端点和 `{ id, name }` 模型项。开始分析时在 options 中传 `provider`。这些接口的真实行为以源码为准，详细路由和返回格式见 [API 提供商说明](API-PROVIDERS.md)。

模型发现只在用户主动打开 AI 设置后触发，地址、协议或密钥变化约 700ms 后发起。UI 必须取消旧请求并通过代际检查忽略迟到结果；关闭弹窗、切换文献或卸载时清理计时器和请求。远程发现与远程正文许可分开，更改端点 origin 时撤销许可并清除保留密钥。不得在 UI 中硬编码模型名作为可用列表。

PDF 提取使用 `Zotero.PDFWorker.getFullText(itemID, null)`。服务注释记录的宿主 manager 契约为 `getFullText(itemID, maxPages, isPriority, password)`；分页解析依据 worker 输出的 form-feed（`\f`）分隔符，只有分隔段数与 `extractedPages` 相等才建立页索引。升级宿主接口前，针对实际版本核对官方 Zotero 与 document-worker 源码，记录源链接/提交、签名及最小验证结果。不能只依据本测试适配器证明真实宿主支持。

状态是版本化本地侧文件；写入串行化、临时替换，保留上一份备份。专用笔记引用与基线留在本地状态中。用户手动改过的同步笔记、丢失关联或不符归属应停止写入；不要用“自动修复”覆盖用户内容。

任何数据格式迁移需先定义备份、失败回退、旧版本读取行为和最小合成样例。本版本没有通用迁移/自动恢复工具，不应手动编辑真实状态做测试。

## CI 和发布

普通 push/PR 在 Node 22 下依次运行 test、check、build 并上传 XPI/checksum 工件。标签发布流程见 [RELEASING.md](RELEASING.md)。工作流声明不等于已通过远程 CI；查看对应运行记录后才能作出此声明。
