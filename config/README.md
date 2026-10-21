# 目标 SSH 主机公钥

此目录不分发实际服务器公钥。部署时，从可信的目标服务器控制台取得 `/etc/ssh/ssh_host_ed25519_key.pub`，保存为 `campus-host-key.pub`，或通过 `LAB_HOST_KEY_PATH` 指定文件。可以使用单行 OpenSSH 公钥格式，也支持带主机标签的单行 known_hosts 格式。

读取到的公钥必须与目标服务器核对指纹；仅从未验证的公网中转端口扫描公钥不能建立信任。不要将任何私钥复制到本目录。
