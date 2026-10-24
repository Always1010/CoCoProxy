# 只读 DNS / TUN 就绪观察

`observeNetworkReadiness(plan, identity, options)` 是供未来 native network driver 调用的受信代码接口。它只读取当前 Linux namespace 的固定 `/proc` 路径，执行固定 `ip -d -j address show dev coproxy-tun`，并发送两次 DNS 查询；不会安装服务、创建 TUN、修改地址、路由、防火墙或激活客户端流量。

生产入口必须以 root 运行，并能读取目标核心的 FD；权限不足、procfs 类型或挂载异常、核心与观察者的 net/pid/user namespace 不一致、PID/start-time/UID/boot 变化都会返回 `NETWORK_PROBE_UNVERIFIED`。此接口核验的是调用者当前受信部署 namespace。驱动仍须独立验证主机 namespace、二进制、systemd unit、cgroup/socket 隔离以及 identity 的 generation/planSha256 绑定；本观察不能替代这些事实。

DNS 所有权要求 IPv4 UDP 和 TCP 在计划的精确 gateway 地址与端口上各有一个 listener，UID 符合计划，其 socket inode 均由当前核心 FD 持有。同端口通配地址、其他 IPv4 地址或 IPv6 listener 均拒绝。TUN 要求当前核心持有实际字符设备 major 10/minor 200 的 `/dev/net/tun` FD，`fdinfo` 的 `iff` 为 `coproxy-tun`，`ip` 读回确认类型为 tun、UP、计划 MTU 以及唯一 IPv4 `198.18.0.1/30`。查询前后重复这些检查，丢弃变化中的证据。并不承诺同时证明其他进程没有共享这些 FD；该权限边界属于独立的服务/cgroup 身份核验。

`options` 必须来自 root 控制的部署配置，不能来自浏览器、订阅内容或任意用户 URL。`queryDomain` 是部署者控制的 wildcard DNS 子域，必须使每个随机子域最终返回 `expectedIPv4`。每种传输独立生成 128-bit 名称 nonce 和随机 16-bit ID，直接将套接字本地地址绑定为 `127.0.0.1`，目标固定为计划的 gatewayIPv4:dnsPort。没有系统 resolver、搜索域、代理、重试或缓存预热。生产部署需要能接收随机名称的真实 DNS 测试域；固定名称缓存命中不能代替该输入。

UDP 与 TCP 均要求收到有效 DNS 响应，校验 ID、完整问题、IN/A、QR、opcode、TC、保留位、普通及 EDNS 扩展 RCODE，限制响应 4096 bytes、记录数 128 和 CNAME 深度 16，并要求从该问题开始的无环 CNAME 链最终仅含预期 IPv4。拒绝未关联答案、截断、循环/前向压缩指针和多余字节。TCP 另校验长度前缀；每次传输有包含 bind/connect/read 的完整超时，默认 1000ms，最大 3000ms。失败只返回固定错误码，不输出名称、地址配置、响应、proc 内容或嵌套异常。一次观察全部通过才返回四项 true。

结果中的 `verified` 只说明本次 DNS UDP/TCP 和核心 TUN 的局部事实，始终保留 `terminalPath: 'unverified'`。它不证明节点可达、上游代理承载、客户端抓取/回程、socket mark、ARP、邻居或防火墙资源正确，也不能独自构成 `NetworkEvidence`。

`observeNetworkReadinessFixture` 接受可选受信 reader/transport seam；所有结果固定 `scope: 'fixture'`。省略 seam 时执行真实 proc/ip/socket 操作，允许隔离 user/net namespace 的同 UID 内核 fixture 读取 FD，不要求主机 euid 0。该入口专用的真实 `ip` 读取还允许 UID 65534（新 user namespace 中未映射的主机 root）；仍要求固定 canonical executable 路径、无符号链接的目录/文件类型、禁止组或其他用户写入，且命令参数固定。生产入口始终要求 `ip` 及其祖先 UID 为 0，不接受该例外。这是测试入口，不能升级为生产证据。自定义 reader 必须按约定有界，不能由外部 JSON 创建。proc 挂载检查只禁止覆盖实际读取的受保护路径，正常且不相关的 `binfmt_misc` 挂载允许存在。单元测试只用合成配置；需要额外隔离 Linux 内核实验验证生产传输和实际 proc/ip 读回。

格式依据：[RFC 1035](https://www.rfc-editor.org/rfc/rfc1035.html)、[Linux procfs 文档](https://docs.kernel.org/filesystems/proc.html)、[Linux TUN/TAP 文档](https://docs.kernel.org/networking/tuntap.html)。
