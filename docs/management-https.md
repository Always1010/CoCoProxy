# 局域网 HTTPS 网页部署

这是[角色部署流程](deployment.md)中网页入口的具体配方，复用已有 nginx、证书与系统服务，不要求特定路由器、外设型号或处理器架构。软件和专用服务账户是明确的系统前置条件；部署工具不会自行安装系统包、证书信任或修改已有站点。

## 由部署收据管理 HTTPS

原生网关部署输入可增加可选顶层 `web`，将 HTTPS 配置与 unit 纳入同一安装、升级、卸载及恢复归属检查：

```json
{
  "web": {
    "schemaVersion": 1,
    "nginxPath": "/usr/sbin/nginx",
    "certificatePath": "/etc/cocoproxy/tls/server.crt",
    "privateKeyPath": "/etc/cocoproxy/tls/server.key"
  }
}
```

该片段加入已有完整部署输入；管理 `origin` 需为带非特权端口的 HTTPS 地址，例如 `https://gateway.example:13443`，且端口不与内部管理、Controller、DNS 或混合代理端口重复。监听地址来自 `runtime.automaticGateway.gatewayIPv4`，后端端口来自 `management.listenPort`，固定 authority 与管理 origin 同源。当前托管模式需要原生网关输入，拒绝默认 443 等低于 1024 的端口，以保持服务无网络 capability。

安装器只增加 `/etc/cocoproxy/web/nginx.conf` 与 `/etc/systemd/system/cocoproxy-web.service` 两个受收据管理的文件。已有同名文件不能自动认领；此前手工安装的实例仍先按其归属停用、审阅和迁移。添加托管 HTTPS 的升级须显式审阅配置变化。未提供 `web` 时保持原有安装文件集。

nginx 和证书/私钥必须已经存在。路径使用规范绝对路径，不含目录链接、用户可写祖先、空格或配置特殊字符；nginx 与证书由 root 所有且服务身份可读取，nginx 可执行，证书不可由组或其他用户写入。私钥为部署服务 UID 所有的 0600 单链接普通文件，父目录由 root 控制且允许服务身份遍历。工具不复制、生成、备份或轮换证书/私钥，也不安装 nginx、改系统信任或申请证书。

只读预检使用 Node 检查证书 SAN 与 origin 主机名/IP、有效期和私钥公钥匹配；CN 不能替代 SAN。自签名证书可以满足这些字节检查，但浏览器信任仍需真实终端核验。域名解析到实际 LAN 地址、端口占用、nginx 编译能力及系统安全策略也需在目标验收。

生成的 unit 只指定数字 `User=<serviceUid>`，不要求同名服务组。运行目录 `/run/cocoproxy-web` 和五个独立临时目录 `/var/lib/cocoproxy-web-{client,proxy,fastcgi,uwsgi,scgi}` 均为服务 UID 的 0700 目录，由计划及 systemd 的 RuntimeDirectory/StateDirectory 管理；root 安装器不在服务可写目录下创建子文件。nginx 启动前执行配置检查，认证和 WebSocket 授权继续由回环管理后端负责。

安装/升级默认只读，`--apply` 仍不启动或启用 HTTPS。按[统一入口](setup.md)完成安装，再显式启动管理及 `cocoproxy-web.service` 并执行本文的验证。维护与卸载使用当前完整输入及收据；证书、私钥和业务状态保持原位。

## 手工独立实例

以下样本流程适用于单独维护的实例，其配置、unit 和证书由操作者记录归属；它不自动加入部署收据。若已选择托管模式，使用上节生成的配置和 unit，不重复手工安装同名文件。

## 输入与边界

将[nginx 配置样本](../examples/nginx-management.conf)和[独立服务样本](../examples/cocoproxy-web.service)放进私有部署目录，修改以下合成参数：

| 参数 | 合成样本 | 必须一致的位置 |
| --- | --- | --- |
| 网关局域网地址 | `192.0.2.2` | nginx listen、实际接口地址及证书 IP SAN（使用 IP 入口时） |
| 网页 authority | `gateway.example:13443` | URL、固定 Host/转发头、精确 Host 检查及 management.origin |
| 后端回环端口 | `13000` | proxy_pass 与 management.listenPort |
| 服务账户 | `cocoproxy` | 部署账户、unit User/Group、私钥和临时目录所有者 |

使用域名时，由实际局域网 DNS 解析到网关地址；使用 IP 时，把域名 authority 全部改为同一 IP 和端口，证书须含该 IP SAN。样本只监听明确的局域网地址。跨网段管理需要接入网络提供相应路由。

HTTPS 样本额外要求服务组存在：`getent group cocoproxy` 应成功，且服务账号有权使用该组。主安装器只验证账号及 UID，不会创建或保证同名组。若目标使用不同服务组，必须同时替换 unit 的 `Group`、下述 `-g` 参数和私钥／临时目录的组，不把账号存在当作组已准备完成。

后端继续绑定回环；反代覆盖 Host/协议头并移除客户端自带的 Forwarded/IP 转发头。后端检查完整 origin、请求 Origin 和会话，HTTPS 会话使用 Secure、HttpOnly、SameSite=Strict 的 `__Host-` Cookie。核心 secret 留在服务端，WebSocket 经过同一认证入口。

浏览器只输入地址和端口时可能先使用 HTTP。样本把 nginx 在 HTTPS 端口收到普通 HTTP 的错误 497 转为到**固定配置 authority**的 308 跳转，避免显示 400；该目标也须随网页 authority 一起替换，不能改成客户端可控的 Host。验证时分别检查普通 HTTP 的固定 Location 和真实 HTTPS 登录，不把跳转当作 TLS 验证。

## 证书与安装

优先使用操作者已有的匹配证书。也可在目标机的私有部署目录生成本地自签名证书，以下名称必须替换：

```sh
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -days 825 -subj '/CN=CoCoProxy LAN management' \
  -addext 'subjectAltName=DNS:gateway.example,IP:192.0.2.2' \
  -addext 'extendedKeyUsage=serverAuth' -keyout server.key -out server.crt
openssl x509 -in server.crt -noout -fingerprint -sha256
```

自签名站点首次访问有证书提示，操作者应通过可信通道核对指纹并明确选择是否继续；不要求安装 App 或修改系统信任库。私钥、真实地址和实际证书不进入 Git 或发行载荷。

在审阅并获准的部署窗口安装下列文件，账户名与来源文件使用当前私有输入：

```sh
sudo install -d -m 0750 -o root -g cocoproxy /etc/cocoproxy/web
sudo install -m 0644 nginx.conf /etc/cocoproxy/web/nginx.conf
sudo install -m 0644 server.crt /etc/cocoproxy/web/server.crt
sudo install -m 0600 -o cocoproxy -g cocoproxy server.key /etc/cocoproxy/web/server.key
sudo install -m 0644 cocoproxy-web.service /etc/systemd/system/cocoproxy-web.service
sudo install -d -m 0700 -o cocoproxy -g cocoproxy /var/lib/cocoproxy-web /run/cocoproxy-web
for directory in client proxy fastcgi uwsgi scgi; do
  sudo install -d -m 0700 -o cocoproxy -g cocoproxy "/var/lib/cocoproxy-web/$directory"
done
sudo -u cocoproxy nginx -t -c /etc/cocoproxy/web/nginx.conf
sudo systemd-analyze verify /etc/systemd/system/cocoproxy-web.service
```

私钥只保留于运行所需的单一位置，核验后处理私有暂存，不把暂存当默认备份。初次安装应在主部署输入里就使用正确的 HTTPS origin。已有部署不能绕过归属收据手改设置；配置迁移需要独立审阅，否则后续升级会拒绝覆盖。

按主流程准备管理员凭据和管理服务后，执行：

```sh
sudo systemctl daemon-reload
sudo systemctl restart cocoproxy-management.service
sudo systemctl start cocoproxy-web.service
```

独立实例不依赖已有 nginx.service 的配置。目标机端口、账户、路径权限及 SELinux/AppArmor 等策略仍须预检。

## 验证与撤销

核对真实 TLS、匿名 API 返回401、登录/退出、订阅和草稿读取、错误 Host/origin 拒绝，以及核心运行时的认证控制和 WebSocket。还须让真实终端打开网页，命令行200不能代替手机 UI 验收。

确认接口地址稳定并完成验证后，按[总指南的持久运行步骤](getting-started.md#8-启用持久运行与自动恢复)显式启用自动恢复、早期保护以及网页／管理开机服务；核心由已提交配置的恢复流程启动，不需要单独 enable。网页可在核心停止时访问，地址尚未就绪时独立服务会按失败重试。升级前先 runtime-pause，再停止并禁用网页、管理及早期保护；完成维护后按总指南恢复。

撤销时先停用并禁用此独立服务，再按记录的归属处理 unit、配置与证书；保留其他站点、代理业务状态和管理员凭据。origin 变化时同步审阅管理设置，旧会话需重新登录。未纳入收据的手工独立实例由操作者自行卸载；托管 HTTPS 则由当前部署收据处理其两个受管文件，仍保留外部证书和私钥。
