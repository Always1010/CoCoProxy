# 真实核心协议回环验证

`tests/protocol-live.test.ts` 使用固定、校验 SHA-256 的官方 Mihomo 客户端和官方 sing-box 服务端。JavaScript 仅提供 HTTP nonce 源站、UDP echo 源站及 RFC 1928 SOCKS5 客户端封装，不实现 VMess、VLESS、Trojan、Shadowsocks、Hysteria2 或 TUIC。

服务端版本和官方资产出处记录在 `review.json`。Mihomo 的固定二进制记录沿用 `integrations/metacubexd/review.json`。测试要求 Linux、非 root 用户以及显式指定的绝对路径；缺少环境变量时测试跳过，跳过不代表通过。二进制摘要不符时失败，不自动下载或使用 PATH 中的替代实现。

```sh
COCOPROXY_TEST_MIHOMO=/absolute/private/path/to/reviewed-mihomo \
COCOPROXY_TEST_SING_BOX=/absolute/private/path/to/reviewed-sing-box \
node --experimental-strip-types --test tests/protocol-live.test.ts
```

测试为六种协议分别启动单节点 `MATCH,synthetic-node` 配置，执行 HTTP nonce 与真实 UDP echo，然后用错误凭据重复请求并断言两种源站都未收到请求。配置没有 DIRECT 回退规则。错误凭据的失败与正确凭据的成功共同证明请求通过了真实协议节点；单纯解析配置成功不计入协议互通结果。

VMess 使用 AEAD、VLESS 使用基础 TCP、Shadowsocks 使用 `aes-128-gcm`，Trojan 使用 TLS，Hysteria2 和 TUIC 使用 QUIC。该范围不涵盖 VMess/VLESS 的其他传输、REALITY、Shadowsocks 2022、混淆、端口跳跃、复用或生产订阅。各协议是否完成实测以 `review.json` 的结果为准。

`tests/protocol-reality-live.test.ts` 单独验证 VLESS REALITY，复用 `tests/protocol-live-helpers.ts` 的进程管理、摘要验证、SOCKS5 UDP 封装和源站探针，不会顺带重跑上述六项：

```sh
COCOPROXY_TEST_MIHOMO=/absolute/private/path/to/reviewed-mihomo \
COCOPROXY_TEST_SING_BOX=/absolute/private/path/to/reviewed-sing-box \
node --experimental-strip-types --test tests/protocol-reality-live.test.ts
```

REALITY 用例由 Node 提供限定 TLS 1.3、X25519 和 loopback 监听的合成 handshake 目标；现有 OpenSSL 生成其临时证书，Node 标准密码库生成随机 X25519 keypair，测试另生成随机 UUID 与 short ID。握手目标不提供 HTTP nonce 或 UDP echo；本用例的 HTTP 和 UDP 探针均通过官方核心组成的 VLESS REALITY 链路访问这两个源站。客户端使用单一 `MATCH,synthetic-reality`，不配置 DIRECT 回退，也不启用 `skip-cert-verify`。正确参数必须通过 HTTP 和 UDP；独立改变 UUID、公钥、short ID 的三组负向请求都必须失败且两种源站计数不增加，同时核查 REALITY 实际联系了本地 handshake 目标。

此项参数按固定版本的 [sing-box TLS 选项](https://github.com/SagerNet/sing-box/blob/v1.14.4/option/tls.go)、[REALITY 服务端实现](https://github.com/SagerNet/sing-box/blob/v1.14.4/common/tls/reality_server.go)、[Mihomo VLESS 选项](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/adapter/outbound/vless.go)和 [REALITY 客户端实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/component/tls/reality.go)核对。验证范围是无 Vision flow 的基础 VLESS REALITY TCP 链路及其中承载的 UDP，未验证 Vision、其他传输或外部伪装站点。客户端的 REALITY 公钥认证由官方核心完成；使用合成本地 handshake 证书不构成生产证书信任链、真实站点伪装效果或生产安全性验收。

所有配置入站监听和目标均为 `127.0.0.1` 随机高位端口。sing-box 出口规则只允许本轮两个合成源站端口，其余拒绝，其出站还显式绑定 IPv4 loopback；测试根据各子进程 `/proc` socket inode 核查全部配置监听端口。Mihomo 的 UDP 出站会建立本地地址为通配的临时 socket，测试允许这种出站 socket，不能据此宣称进程的每个 socket 都绑定 loopback；所有配置的远端目标仍固定为 loopback，且通配 UDP socket 不得占用配置入站端口。不会配置 TUN、系统路由、防火墙、系统服务或系统证书信任。测试进程临时设置 umask 0077，临时目录权限为 0700，配置、密钥和证书为 0600；子进程日志只计入有上限的字节预算，不直接输出；退出时先收敛进程组再删除临时文件。

Trojan、Hysteria2、TUIC 的 TLS 证书由现有 `/usr/bin/openssl` 临时生成，仅供本轮合成节点使用，客户端显式启用测试用的 `skip-cert-verify`。该测试不证明生产证书链验证或证书 pinning 的正确性，也不应将此设置照搬到生产配置。REALITY 用例的客户端认证方式见上文，与这三项的跳过证书验证设置分别记录。

此验证只证明固定软件版本之间的本机回环协议互通。它不证明 WAN/LAN 转发、外部节点可达性、真实订阅、跨设备 UDP/NAT、吞吐、网关部署或生产稳定性。

官方参考：[sing-box inbound](https://sing-box.sagernet.org/configuration/inbound/)、[Mihomo 出站配置](https://wiki.metacubex.one/config/proxies/)、[固定 sing-box 发布](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4)。
