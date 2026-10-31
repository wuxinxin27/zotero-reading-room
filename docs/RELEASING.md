# 发布与分发

## 版本发布

1. 在 `package.json` 和 `addon/manifest.json` 同时修改版本，更新 CHANGELOG 与兼容性/隐私说明。保持插件 ID 不变。
2. 运行 `npm test`、`npm run check`、`npm run build`；完成受影响的[实机清单](TESTING.md)，明确区分已通过、失败和未验证。
3. 检查仓库与 XPI 中没有个人库、profile、路径、标题、正文、截图或密钥。核对 MIT、README、支持入口和安全报告渠道。
4. 推送与版本完全一致的 `v<version>` 标签，例如 `v0.1.0`。`release.yml` 会拒绝标签/package/manifest 版本不一致的构建。
5. 工作流在 Node 22 下检查、测试和构建；只在 publish job 给 `contents: write`。发布资产为 `.xpi`、`SHA256SUMS` 和 `updates.json`，普通 CI 工件没有发布权限。
6. 检查实际 GitHub Release、下载校验和与 XPI；在 Zotero 使用“从文件安装插件”验证发布后的文件。记录结果，不能把配置工作流当作已运行通过。

CI 工作区干净；本地构建失败会保留旧产物，不要上传未经本次成功构建与核对的文件。GitHub 标签发布会创建公开 Release，属于实际发布操作，应由有发布权限的维护者执行。

## 更新策略

Zotero 10.0.7 的实际安装器要求 manifest 提供 `applications.zotero.update_url`。项目采用 GitHub 最新 Release 的 `updates.json`，构建脚本生成与 XPI 对应的版本、兼容范围、下载地址和 SHA-256。

发布后验证更新清单和安装包均可下载，并在下一版本发布时测试旧版升级。尚未完成的升级测试不得标为通过；保留历史 Release 供回退。首次安装仍使用下载的 XPI。

## 官方目录

GitHub 公开仓库或 Release 不等于收录于 Zotero 官方插件目录。申请前应按 Zotero 当时的目录要求核查许可证、README、支持渠道、可安装 Release、维护状态与更新/下载 URL；准备兼容性和隐私证据，再由维护者提出目录审核。目录审核与后续版本的端到端升级验证列入后续工作，未经接受不得声称已上架。
