# 贡献指南

## 开始之前

先阅读 [README](README.md) 中的适用条件与当前边界，以及 [架构说明](docs/ARCHITECTURE.md)。本项目通过固定的反向 SSH 通道提供个人账户的网页终端和文件编辑；内网可达路径与 VPN 由部署环境提供。

欢迎围绕安装、部署、终端、文件编辑和可复现问题提交集中改动。仓库原创代码暂未指定开源许可证；已有第三方许可须保留来源，文档整理不代替维护者的许可决定。

## 开发与验证

需要 Node.js 20+、npm 和测试使用的 `ssh-keygen`。在项目目录执行：

```sh
npm ci --ignore-scripts
npm run vendor
npm run check
npm test
```

单元测试使用回环地址、临时目录及模拟 SSH/SFTP 服务，不登录真实内网服务器。涉及终端输入、文件编辑或布局时，再按 [README](README.md#开发与验证) 准备 Chromium 或 `CHROME_PATH`，运行对应的 `test:browser:*` 脚本。CI 运行构建、语法检查和单元测试，不包含浏览器测试。

仅修改文档时检查链接、命令和 `git diff --check`；记录实际结果与未执行的检查。模拟测试和已有 [验证记录](docs/VERIFICATION.md) 不能代替实际部署环境的端到端验收。

## 提交 Issue

使用 [问题反馈](.github/ISSUE_TEMPLATE/bug_report.md) 或 [功能建议](.github/ISSUE_TEMPLATE/feature_request.md) 模板，说明提交版本、环境、复现步骤、预期与实际行为，或希望改善的使用场景。

使用虚构账户和示例环境；日志、截图及配置先移除密码、私钥、真实主机地址、用户名和内网拓扑。不要把访问凭据或可利用的安全细节放进公开 Issue。

## 提交 PR

按 [PR 模板](.github/pull_request_template.md) 说明目的与改动、验证结果和影响范围，同步更新受到影响的文档。未运行检查时说明原因。

涉及认证、来源校验、隧道、账户权限或文件保存时，说明相关边界受到的影响。涉及浏览器交互时，补充实际浏览器和手动复现结果；不要把模拟网络延迟当作真实公网性能。

## 数据与生成文件

- 服务端源码位于 `server.mjs` 和 `bridge.mjs`，浏览器界面源码位于 `public/`，编辑器构建源码位于 `scripts/editor-source.mjs`。
- `npm run vendor` 生成被 Git 忽略的 `public/vendor/`、`public/editor.mjs`，并同步受跟踪的 `docs/licenses/`；不要手工修改生成资源或第三方许可文本，更新后核对差异。
- 不提交 `node_modules/`、本地运行目录、截图、测试报告、日志和压缩包；沿用现有 `.gitignore`。
- 实际主机公钥、环境配置和隧道凭据留在部署环境，不提交私钥、密码、真实服务器信息或账户资料。部署示例继续使用中性占位信息。
