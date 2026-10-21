# 部署指南

以下示例使用一个公网 VPS、一个内网中转设备和一个目标 SSH 服务器。请先替换示例值；示例 IP 和域名不是可用服务。

| 参数 | 示例 |
| --- | --- |
| 公网 VPS | `203.0.113.10` |
| 网页域名 | `lab.example.com` |
| 目标内网 SSH | `192.168.50.10:22` |
| VPS 中转账户 | `lab_relay` |
| 反向转发监听 | `127.0.0.1:22002` |
| 网页进程监听 | `127.0.0.1:8090` |
| 项目目录 | `/opt/intranet-server-access` |

先完成隧道和主机公钥核验，再启动工作台，最后配置 HTTPS。

## 1. 检查两条网络路径

在内网设备上确认能够连接目标 SSH，以及 VPS 的 SSH 服务。目标需要提供成员自己的 Linux 账户；如需文件功能，还需提供 SFTP。

```sh
ssh -p 22 your_linux_user@192.168.50.10
```

内网设备的校园 VPN 或其他内网接入方式应先独立工作。这份项目不安装或登录 VPN。

## 2. 配置专用反向 SSH 账户

在 VPS 上创建专用账户 `lab_relay`，在内网设备上生成专用 ED25519 密钥，将它的公钥安装到该 VPS 账户的 `~/.ssh/authorized_keys`。目录权限设为 `0700`、文件权限设为 `0600`，所有者为该账户。私钥留在内网设备。

公钥条目使用以下限制；把最后一部分替换为实际公钥：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:22002" ssh-ed25519 REPLACE_WITH_RELAY_PUBLIC_KEY
```

在 VPS 的 SSH 服务配置中为该账户添加 Match 段，例如受支持系统上的 `/etc/ssh/sshd_config.d/lab-relay.conf`：

```text
Match User lab_relay
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:22002
    PermitOpen none
    GatewayPorts no
    AllowAgentForwarding no
    X11Forwarding no
    AllowStreamLocalForwarding no
    PermitTTY no
    MaxSessions 0
Match all
```

`MaxSessions 0` 禁用 shell、命令和子系统会话，仍允许 `ssh -N` 使用转发。确认主配置实际包含该配置目录，并核对没有其他 Match 段改变结果。先验证语法，再重载服务；不同发行版的服务名可能是 `ssh` 或 `sshd`。

```sh
sudo sshd -t
sudo sshd -T -C user=lab_relay,host=relay-device,addr=192.0.2.20
sudo systemctl reload sshd
```

内网设备上的首次 VPS 主机公钥应与 VPS 管理端的可信值核对，再写入专用 `known_hosts`。启动转发：

```sh
ssh -N -T \
  -i /path/to/relay_ed25519 \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/path/to/relay_known_hosts \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 127.0.0.1:22002:192.168.50.10:22 \
  lab_relay@203.0.113.10
```

先以前台方式确认工作，再交给设备本身的服务管理器守护。Linux 可参考 `deploy/router-tunnel.service.example` 使用 systemd，OpenWrt 可使用 procd；让管理器运行前台 SSH 进程并在退出后重启，不要同时叠加多个循环启动同一端口。

在 VPS 上确认监听仅在回环地址：

```sh
ss -ltnp 'sport = :22002'
```

## 3. 固定目标服务器主机公钥

通过可信管理路径获取目标服务器的 ED25519 公钥，并核对指纹。可以从目标服务器的 SSH 主机公钥文件取得，或在可信内网设备上采集后与管理端值比较。

```sh
ssh-keyscan -p 22 -t ed25519 192.168.50.10 > campus-host-key.pub
ssh-keygen -lf campus-host-key.pub
```

`ssh-keyscan` 本身不证明主机身份；采集结果必须经过可信来源核对。将已核验的公钥复制到 VPS 的 `/etc/intranet-server-access/campus-host-key.pub`，并在应用配置中指定该路径。应用接受一行 `ssh-ed25519 BASE64`，或一行带主机字段的 known_hosts 格式。

再从 VPS 通过反向转发采集公钥，确认与目标公钥相同：

```sh
ssh-keyscan -p 22002 -t ed25519 127.0.0.1
```

文件中的主机标签可能不同，比较的是 ED25519 公钥内容及其指纹。公钥文件不是私钥，但必须由可信运维人员管理。

## 4. 安装网页应用

VPS 安装 Node.js 20+、npm、Nginx 和 OpenSSH 客户端。将仓库检出到 `/opt/intranet-server-access`。源码构建使用开发依赖和平台可选依赖：

```sh
cd /opt/intranet-server-access
npm ci --ignore-scripts
npm run vendor
npm run check
npm test
```

`vendor` 复制终端资源并构建自托管编辑器。已经包含构建产物的包可以只安装生产运行依赖；不要在需要重新构建时省略 esbuild 的平台可选依赖。

环境配置如下。应用不自行读取 `.env` 文件，应由进程管理器注入，或在启动前显式设置。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LAB_PREVIEW_PORT` | `8090` | 网页回环监听端口 |
| `LAB_SSH_PORT` | `22002` | 固定 SSH 目标的回环端口 |
| `LAB_HOST_KEY_PATH` | `config/campus-host-key.pub` | 经过核验的目标 ED25519 公钥文件 |
| `LAB_ALLOWED_ORIGINS` | `http://127.0.0.1:8090` | 允许的完整网页 Origin，多个值以逗号分隔 |

本地验证可以使用：

```sh
LAB_SSH_PORT=22002 \
LAB_ALLOWED_ORIGINS=http://127.0.0.1:8090 \
LAB_HOST_KEY_PATH=/etc/intranet-server-access/campus-host-key.pub \
npm start
```

从 VPS 本机检查 `http://127.0.0.1:8090/api/session` 应返回 `authMode: campus`。个人 SSH 密码只在正式 HTTPS 页面内输入，不通过启动参数或环境变量配置。

## 5. 配置 systemd

创建 `/etc/intranet-server-access/` 目录；参考 `deploy/workbench.env.example`，将环境文件保存为 `/etc/intranet-server-access/workbench.env`：

```text
NODE_ENV=production
LAB_PREVIEW_PORT=8090
LAB_SSH_PORT=22002
LAB_HOST_KEY_PATH=/etc/intranet-server-access/campus-host-key.pub
LAB_ALLOWED_ORIGINS=https://lab.example.com
```

Origin 包含协议、主机以及非默认端口，不包含路径或末尾斜线。兼容的 `/lab/` 路径属于同一个 Origin；需要另一个域名时，显式增加对应 Origin。

可参考 `deploy/workbench.service` 创建 `/etc/systemd/system/intranet-server-access.service`，确认 Node.js 实际位于 `/usr/bin/node`，否则修改路径：

```ini
[Unit]
Description=Private server web workbench
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/intranet-server-access
ExecStart=/usr/bin/node /opt/intranet-server-access/server.mjs
EnvironmentFile=/etc/intranet-server-access/workbench.env
Restart=on-failure
RestartSec=3
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=160M
TasksMax=32

[Install]
WantedBy=multi-user.target
```

应用只需要读取源码、静态资源和公钥。确保其目录可遍历、文件可读，例如项目目录 `0755`、公钥文件 `0644`；不要把公钥放在此服务不可访问的个人主目录中。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now intranet-server-access.service
sudo systemctl status intranet-server-access.service
```

## 6. 配置域名、HTTPS 与 Nginx

把 `lab.example.com` 的 DNS A 记录指向实际 VPS 地址。让公网能够访问 VPS 的 80/443 端口；网页应用和反向转发端口继续只监听回环地址。

先配置仅 HTTP 的证书验证站点：

```nginx
server {
    listen 80;
    server_name lab.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 404; }
}
```

```sh
sudo mkdir -p /var/www/acme
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/acme -d lab.example.com
```

证书签发后，将该站点替换为以下完整配置。已有证书或统一证书管理时，也可以使用相应证书路径。

```nginx
server {
    listen 80;
    server_name lab.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name lab.example.com;
    ssl_certificate /etc/letsencrypt/live/lab.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lab.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location ~ ^/(lab/)?api/terminal$ {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Cookie "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header Cookie "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 配置独立可用，不依赖其他站点的片段。若将它合并到已有站点，检查继承的登录门禁、路径重写和 WebSocket 规则。确认已有证书续期任务，并在续期成功后重载 Nginx。

## 7. 验收

按以下顺序检查，每一层正常后再进入下一层：

1. 内网设备能直接连接目标 SSH，反向隧道持续运行。
2. VPS 的 `127.0.0.1:22002` 正在监听，经此端口取得的目标主机公钥与已核验公钥一致。
3. 本机 `/api/session` 正常，应用服务没有持续重启。
4. HTTPS 证书有效，`https://lab.example.com/api/session` 正常。
5. 浏览器用一个测试成员自己的 Linux 账户登录，终端、尺寸调整、文件概览和文本读取正常。
6. 在目标服务器专门准备的测试文件上检查编辑保存，确认该账户的权限生效。
7. 检查快速输入、原终端交互以及手机或小窗口布局。

仓库中的自动化测试使用本机隔离 SSH/SFTP 和一次性账户，不应以真实成员的目录、文件或密码替代测试夹具。
