# 仅内网可访问的服务器外网访问方案

通过一台公网 VPS 和一台能够访问内网的路由器或中转机，在浏览器中使用内网 Linux 服务器的终端、文件树和代码编辑器。

[项目概览](#项目概览) · [快速开始](#快速开始) · [使用说明](#使用说明) · [开发与验证](#开发与验证) · [目录结构](#目录结构) · [项目文档](#项目文档) · [当前边界](#当前边界)

## 项目概览

成员使用目标服务器上各自已有的 Linux/SSH 账号登录。网页服务不另建一套用户体系，目录和文件操作遵循各自账户权限。

```mermaid
flowchart LR
    Browser[浏览器] -->|HTTPS / WebSocket| VPS[公网 VPS 上的工作台]
    VPS -->|127.0.0.1:22002| Relay[反向 SSH 隧道]
    Router[内网路由器或中转机] -->|主动连接公网 VPS| Relay
    Router -->|内网 SSH| Linux[目标 Linux 服务器]
```

### 主要功能

- 交互式 SSH 终端：尺寸同步、全屏、输入输出和断线状态。
- 文件概览：个人主目录、目录展开、刷新和权限内的共享路径。
- 多标签编辑：Python、JavaScript/TypeScript、JSON、Markdown 高亮，以及查找、撤销和保存。
- 保存冲突检测：核对文件版本，再通过目标服务器支持的 POSIX 原子替换写入已有文件。
- 快速输入栏：在浏览器本地编辑单行命令，Enter 整行发送；原终端保留补全和交互程序操作。
- 简单连接诊断：分别查看网页往返、远程文件请求与终端处理时间。

### 适用条件

需要一台有公网入口的 VPS、一台可以主动连接 VPS 且能够访问目标 SSH 服务的内网路由器或中转机，以及目标服务器上可用的个人 SSH 账号。目标 SSH 服务需支持密码或单一密码提示的 keyboard-interactive 认证；文件功能需要 SFTP，保存还需要 `posix-rename@openssh.com` 扩展。

内网通路由中转机提供。如果访问目标服务器需要校园或企业 VPN，VPN 应先在中转机或它的上游配置完成。本项目负责网页工作台和 SSH 接入，不代替 VPN。

## 快速开始

需要 Node.js 20+、npm 和 `ssh-keygen`（测试使用）。先完成 [部署文档](docs/DEPLOYMENT.md) 中的反向 SSH 通道与目标主机公钥配置。

```sh
git clone https://github.com/QTSHI/intranet-server-access.git
cd intranet-server-access
npm ci --ignore-scripts
npm run vendor
```

将从目标服务器可信控制台取得的 ED25519 **公钥**保存为 `config/campus-host-key.pub`，然后运行：

```sh
LAB_SSH_PORT=22002 \
LAB_ALLOWED_ORIGINS=http://127.0.0.1:8090 \
npm start
```

打开 `http://127.0.0.1:8090`。正式部署时，通过 Nginx 提供 HTTPS，并把 `LAB_ALLOWED_ORIGINS` 改为实际 HTTPS 来源。

仓库保留构建源码和锁文件。终端与编辑器的浏览器资源由 `npm run vendor` 生成，运行时不依赖外部 CDN。

## 使用说明

在网页中使用目标 Linux 服务器的个人 SSH 账号登录；认证成功后可使用交互式终端，并在目标账户权限内浏览目录和编辑已有文件。快速输入栏用于在本地编辑单行命令，Enter 整行发送，原终端仍可操作补全与交互程序。

### 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LAB_PREVIEW_PORT` | `8090` | 网页服务监听端口，仅监听 `127.0.0.1` |
| `LAB_SSH_PORT` | `22002` | VPS 上的反向 SSH 回环端口 |
| `LAB_HOST_KEY_PATH` | `config/campus-host-key.pub` | 可信目标服务器 ED25519 公钥；相对路径以项目目录为基准 |
| `LAB_ALLOWED_ORIGINS` | `http://127.0.0.1:<网页端口>` | 允许的完整来源，多个来源以英文逗号分隔 |

浏览器不能指定 SSH 主机或端口。SSH 连接固定进入 VPS 本机回环通道，再由隧道到达内网目标。

## 开发与验证

安装依赖并构建浏览器资源后执行：

```sh
npm run check
npm test
```

`npm test` 使用临时目录和本机模拟 SSH/SFTP 服务，不登录真实内网服务器。测试覆盖配置、认证、来源校验、终端数据、账户隔离、文件权限、保存冲突和资源释放。

浏览器测试使用真实 Chromium 与隔离 SSH 服务：

```sh
npx playwright-core install chromium
npm run test:browser:quick-input
npm run test:browser:editor
npm run test:browser:viewport
```

也可通过 `CHROME_PATH` 指定已有 Chrome/Chromium。测试报告与截图在本地生成，不纳入 Git 历史。CI 自动执行构建、语法检查和单元测试。

开发、反馈、提交与生成文件约定见 [贡献指南](CONTRIBUTING.md)。已有测试环境与结果见 [验证记录](docs/VERIFICATION.md)，不代表当前真实部署环境的端到端验收。

## 目录结构

```text
server.mjs              HTTP 服务、静态资源与环境配置入口
bridge.mjs              WebSocket、SSH/SFTP 与会话处理
public/                 工作台 HTML、样式、交互代码与图标
scripts/                终端资源同步与编辑器构建源码
tests/                  配置、服务、SSH/SFTP 和浏览器测试
config/                 目标主机公钥配置说明；实际公钥在本地配置
deploy/                 Nginx、systemd 与环境变量示例
docs/                   架构、部署、运维、验证记录与第三方许可
.github/workflows/      自动构建、语法检查与单元测试
```

`public/vendor/` 和 `public/editor.mjs` 由 `npm run vendor` 生成并被 Git 忽略；编辑器源码在 `scripts/editor-source.mjs`，不要直接修改生成资源。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [贡献指南](CONTRIBUTING.md) | 开发、验证、问题反馈与生成文件约定 |
| [架构说明](docs/ARCHITECTURE.md) | 认证、终端、文件与输入流程 |
| [部署指南](docs/DEPLOYMENT.md) | 内网通道、公钥、VPS、Nginx 与 systemd |
| [运维指南](docs/OPERATIONS.md) | 日常检查、故障排查、升级与回退 |
| [验证记录](docs/VERIFICATION.md) | 发布版已有检查及其环境和边界 |
| [公钥配置说明](config/README.md) | 可信目标主机公钥的取得与核对 |
| [部署模板](deploy/) | 需按实际环境填写的配置示例 |
| [第三方许可](docs/licenses/) | 终端、编辑器及其相关依赖的许可文本 |

## 当前边界

单文件编辑上限为 256 KiB，最多打开 12 个编辑标签。保存针对已有的 UTF-8 普通文件；界面不提供任意文件创建、删除或上传功能。未保存草稿只存在当前页面中，刷新或关闭页面前应先保存。长时间任务可以在目标服务器上使用 tmux 等工具。

快速输入改善本地打字和编辑体验；命令执行与输出仍受实际网络影响。反向 SSH 通道上的丢包或暂停需要从中转机、出口和公网路径排查。

登录使用个人账户，不支持 root。SFTP 不可用时仍可使用终端；保存冲突检查不能消除最终复查与替换之间所有外部并发修改窗口。详细说明见 [架构文档](docs/ARCHITECTURE.md)。

### 第三方来源

终端使用 xterm.js，编辑器使用 CodeMirror 6，SSH 和 WebSocket 分别使用 ssh2 与 ws。相关第三方许可保留在 [docs/licenses](docs/licenses/)；完整依赖以 `package-lock.json` 为准。仓库原创代码暂未指定开源许可证。
