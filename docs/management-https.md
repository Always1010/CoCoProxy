# 局域网 HTTPS 网页部署

这是[角色部署流程](deployment.md)中网页入口的具体配方，复用已有 nginx、OpenSSL 与系统服务，不要求特定路由器、外设型号或处理器架构。软件和专用服务账户是明确的系统前置条件；部署工具不会自行安装系统包、证书信任或修改已有站点。

## 输入与边界

将[nginx 配置样本](../examples/nginx-management.conf)和[独立服务样本](../examples/coproxy-web.service)放进私有部署目录，修改以下合成参数：

| 参数 | 合成样本 | 必须一致的位置 |
| --- | --- | --- |
| 网关局域网地址 | `192.0.2.2` | nginx listen、实际接口地址及证书 IP SAN（使用 IP 入口时） |
| 网页 authority | `gateway.example:13443` | URL、固定 Host/转发头、精确 Host 检查及 management.origin |
| 后端回环端口 | `13000` | proxy_pass 与 management.listenPort |
| 服务账户 | `coproxy` | 部署账户、unit User/Group、私钥和临时目录所有者 |

使用域名时，由实际局域网 DNS 解析到网关地址；使用 IP 时，把域名 authority 全部改为同一 IP 和端口，证书须含该 IP SAN。样本只监听明确的局域网地址。跨网段管理需要接入网络提供相应路由。

HTTPS 样本额外要求服务组存在：`getent group coproxy` 应成功，且服务账号有权使用该组。主安装器只验证账号及 UID，不会创建或保证同名组。若目标使用不同服务组，必须同时替换 unit 的 `Group`、下述 `-g` 参数和私钥／临时目录的组，不把账号存在当作组已准备完成。

后端继续绑定回环；反代覆盖 Host/协议头并移除客户端自带的 Forwarded/IP 转发头。后端检查完整 origin、请求 Origin 和会话，HTTPS 会话使用 Secure、HttpOnly、SameSite=Strict 的 `__Host-` Cookie。核心 secret 留在服务端，WebSocket 经过同一认证入口。

浏览器只输入地址和端口时可能先使用 HTTP。样本把 nginx 在 HTTPS 端口收到普通 HTTP 的错误 497 转为到**固定配置 authority**的 308 跳转，避免显示 400；该目标也须随网页 authority 一起替换，不能改成客户端可控的 Host。验证时分别检查普通 HTTP 的固定 Location 和真实 HTTPS 登录，不把跳转当作 TLS 验证。

## 证书与安装

优先使用操作者已有的匹配证书。也可在目标机的私有部署目录生成本地自签名证书，以下名称必须替换：

```sh
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -days 825 -subj '/CN=Coproxy LAN management' \
  -addext 'subjectAltName=DNS:gateway.example,IP:192.0.2.2' \
  -addext 'extendedKeyUsage=serverAuth' -keyout server.key -out server.crt
openssl x509 -in server.crt -noout -fingerprint -sha256
```

自签名站点首次访问有证书提示，操作者应通过可信通道核对指纹并明确选择是否继续；不要求安装 App 或修改系统信任库。私钥、真实地址和实际证书不进入 Git 或发行载荷。

在审阅并获准的部署窗口安装下列文件，账户名与来源文件使用当前私有输入：

```sh
sudo install -d -m 0750 -o root -g coproxy /etc/coproxy/web
sudo install -m 0644 nginx.conf /etc/coproxy/web/nginx.conf
sudo install -m 0644 server.crt /etc/coproxy/web/server.crt
sudo install -m 0600 -o coproxy -g coproxy server.key /etc/coproxy/web/server.key
sudo install -m 0644 coproxy-web.service /etc/systemd/system/coproxy-web.service
sudo install -d -m 0700 -o coproxy -g coproxy /var/lib/coproxy-web /run/coproxy-web
for directory in client proxy fastcgi uwsgi scgi; do
  sudo install -d -m 0700 -o coproxy -g coproxy "/var/lib/coproxy-web/$directory"
done
sudo -u coproxy nginx -t -c /etc/coproxy/web/nginx.conf
sudo systemd-analyze verify /etc/systemd/system/coproxy-web.service
```

私钥只保留于运行所需的单一位置，核验后处理私有暂存，不把暂存当默认备份。初次安装应在主部署输入里就使用正确的 HTTPS origin。已有部署不能绕过归属收据手改设置；配置迁移需要独立审阅，否则后续升级会拒绝覆盖。

按主流程准备管理员凭据和管理服务后，执行：

```sh
sudo systemctl daemon-reload
sudo systemctl restart coproxy-management.service
sudo systemctl start coproxy-web.service
```

独立实例不依赖已有 nginx.service 的配置。目标机端口、账户、路径权限及 SELinux/AppArmor 等策略仍须预检。

## 验证与撤销

核对真实 TLS、匿名 API 返回401、登录/退出、订阅和草稿读取、错误 Host/origin 拒绝，以及核心运行时的认证控制和 WebSocket。还须让真实终端打开网页，命令行200不能代替手机 UI 验收。

确认接口地址稳定并完成验证后，再明确启用网页与管理服务开机启动。核心启动和路由器接管分别按主流程控制，网页可在核心停止时访问。

撤销时先停用并禁用此独立服务，再按记录的归属处理 unit、配置与证书；保留其他站点、代理业务状态和管理员凭据。origin 变化时同步审阅管理设置，旧会话需重新登录。通用主安装器不自动卸载这个独立反代实例。
