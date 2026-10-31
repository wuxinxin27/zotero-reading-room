# 安全政策 / Security policy

当前维护范围为最新发布的 0.1.x。首版为实验性版本，实际宿主兼容性和发布前核查见 [docs/TESTING.md](docs/TESTING.md)。

## 私密报告

请使用本仓库 **Security → Report a vulnerability** 提交私密 GitHub 漏洞报告：

https://github.com/wuxinxin27/zotero-reading-room/security/advisories/new

维护者需要启用 GitHub private vulnerability reporting。如果入口尚不可用，请等待维护者启用私密报告渠道，不要在公开 issue 中发布漏洞细节、利用步骤、密钥或个人文库。项目不提供未经核实的联系邮箱或响应时限承诺。

报告包含受影响版本、攻击前提、使用虚构数据的最小复现、预期影响及建议修复即可。不要发送真实 PDF、用户路径、文库数据库、状态文件或 API 密钥。

## 当前防护与边界

- 论文和模型输出都是不可信数据。模型只返回有界 JSON；不执行其中的脚本、HTML、工具调用或指令。
- 证据按当前提取文本及页边界进行匹配；匹配不证明学术结论正确。HTML 笔记需转义内容。
- 远程端点需 HTTPS 与明确允许；拒绝端点内嵌凭据及查询参数，不跟随重定向。插件不会在启动时调用端点。
- 默认写入本地侧文件；Zotero 笔记只在显式操作时写入个人库，验证归属并检查同步笔记的手动编辑冲突。
- 构建只打包 `addon/` 的源文件，拒绝链接与非源文件；发布附 SHA-256 校验。校验和用于检测损坏，不能替代验证发布者与源码。
- Zotero 插件属于具有宿主权限的代码；本项目不是隔离沙箱。只安装你信任并能核查来源的构建。

发布或安全修复前，请复核 [隐私边界](PRIVACY.md)、[测试清单](docs/TESTING.md)与依赖、构建和工作流改动。

English: report vulnerabilities privately through GitHub Security Advisories when enabled. Never publish secrets or real library data in issues. This privileged Zotero plugin treats extracted text and model replies as untrusted data, not executable instructions.
