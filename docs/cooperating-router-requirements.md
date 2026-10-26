# 设备条件与路由器协作

CoCoProxy 独立安装在 Linux 外接设备上，提供代理核心、配置、账户和网页。协同路由器负责终端接入、流量交付、DNS 协调及独立关闭。两端按网络行为协作，不要求采用同一项目、特定型号或 OpenWrt。

当前模式支持整个同子网 IPv4 LAN 的普通客户端，也保留显式单终端兼容输入，默认网关和基础 DNS 入口仍是路由器。安装方法见[部署](deployment.md)，数据路径见[架构](architecture.md#终端流量)，平台及证据分级见[支持矩阵](support-matrix.md)，已验证范围与缺口见[发行说明](release-notes.md)。

路由器适配以[最小行为契约 v1](router-contract.md)为准：逐项满足来源、排除、回程、DNS、IPv6、故障阻断、独立关闭、生命周期和可观察状态。本文用于准备设备及映射参数；契约不是现成厂商 API，满足输入格式或通过只读预检不等于该固件已完成兼容验收。

## 外接设备条件

| 项目 | 当前要求 |
| --- | --- |
| 系统与架构 | Linux/systemd，Node.js ≥22.18，与目标架构匹配的固定审核 ARM64 或 x86-64 ELF64 little-endian 核心；其他架构、Windows/macOS、无 systemd 系统及普通端口映射容器不在当前安装入口范围 |
| 运行软件 | systemd、支持 JavaScript rules 的 polkit；原生网关需 Python ≥3.9、iproute2、nftables。HTTPS 配方使用 nginx、匹配证书，生成本地证书需 OpenSSL |
| 权限与内核 | root 安装，专用非登录服务 UID，TUN、nftables、策略路由与所用 JSON 能力可用。管理进程无网络 capability，核心和 root 网络单元按计划授权 |
| 系统策略 | 显式准备 IPv4 转发，核对 rp_filter、重定向、防火墙、sandbox、SELinux/AppArmor 及既有资源。安装器不修改系统 DNS、默认路由或 sysctl |
| 接口与地址 | 至少一个 UP 的非 loopback、非 TUN IPv4 接口；路由器、外设、终端地址互异，同一 /1–/29 子网且为有效主机地址，不覆盖保留 TUN 网段。单网口可以承载交付、出站和回程 |
| 资源与维护 | 容纳解包载荷、暂存、新旧 release 和私有状态；CPU/RAM/链路余量按目标负载测量，当前无通用最低资源或吞吐承诺。保留不依赖代理的维护通道 |

软件、账户和系统参数由操作者准备，安装器只检查。Linux `ip_forward` 变更可能重置其他 IPv4 参数，见[内核说明](https://docs.kernel.org/networking/ip-sysctl.html)。网页配置见[HTTPS 配方](management-https.md)。

## 路由器必须提供的行为

路由器交付保留原终端 IPv4，由其交付接口 MAC 发出；CoCoProxy 的新建出站和终端回程均经该路由器。guard 与 TUN 回程均依赖此路径；LAN 回程使用独立策略表，不覆盖外设主表的 LAN 连接路由。

| 能力 | 要求 |
| --- | --- |
| 稳定身份 | 固定外设和路由器身份并核对交付 MAC；LAN 模式新加入和 DHCP 地址变化的普通客户端自动覆盖，单终端模式需重核终端地址 |
| 来源选择与排除 | 仅交付受管终端的公网 IPv4 TCP/UDP，保留 LAN、路由器、外设管理和基础控制流量；外设、本机出站及终端回程不再次交付 |
| 下一跳与来源 | 受管下一跳为外设；交付段不做 SNAT/masquerade，WAN NAT 可保留。不能将路由器全局默认路由改成外设 |
| 回程与连接跟踪 | 接受外设经路由器返回终端，支持所需同接口转发；核对防火墙状态、rp_filter、ICMP 重定向、MTU 和必要差错 |
| DNS | 只把受管终端公网 DNS 经 UDP/TCP 转交外设指定端口，本地域和无点名称保持基础解析，bootstrap 不循环。外设 DNS 只接受配置的路由器地址/MAC及本机请求 |
| IPv6 与其他协议 | 阻断受管公网 IPv6，保留必要本地控制与管理；其他 IP 协议及加密 DNS 分别声明和验证 |
| 故障阻断 | 外设、核心、DNS 或链路故障时保留开启意图并阻断受管外网，不自动退回 WAN。查表失败不能继续落到普通默认路由 |
| 独立关闭 | 外设离线时仍可从路由器撤销交付、专用 DNS 和相关 IPv6 限制，恢复普通直连 |
| 加速与生命周期 | offload、桥接或旧连接不能绕过策略。保存、应用、撤销与部分失败可核对；重启、重连、DNS/防火墙重载后先保护再放行 |

持久启用后，系统关机不能清除用户开启意图。路由器和外设以任意顺序启动、同一逻辑 LAN 内网线重插或换口后，应使用上次成功提交配置重新取得新鲜证据并自动恢复；暂时性故障及锁忙持续退避重试，用户明确关闭优先并取消后续恢复。不能把“曾经 active”或陈旧 DNS 观察直接当作重新放行依据，也不能自动使用尚未应用的新草稿。自动恢复目标为必要依赖就绪后 60 秒内恢复新连接，须对具体组合验收。

入口绑定实际 LAN bridge／三层接口、精确范围及设备身份，不绑定同一 LAN 的某一个物理交换端口。基础网络开始转发前须建立开启意图下的保护；正常 firewall reload 重新保护并恢复。任意全表 flush 或管理员删除未知系统资源不属于普通重载路径，不能据此作零窗口承诺。升级前须暂停外设恢复并独立关闭路由器交付，防止自动恢复与维护竞争。

普通静态目的路由、全局 DNS 和端口映射不能单独替代这些行为，机制见[ip-rule 手册](https://man7.org/linux/man-pages/man8/ip-rule.8.html)与[nftables NAT](https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT))。路由器可使用自己的网络栈和字段，不必使用外设上的 Linux 命令。

## 固件与组件选择

| 现状 | 处理方式 |
| --- | --- |
| 原厂固件具备全部能力且可持久保存、独立关闭 | 保留原固件，映射参数并验证当前组合 |
| 受支持插件／脚本可以补齐能力 | 审阅权限、启动／重载、升级兼容和撤销方式后验证 |
| 只有静态路由、DNS/DHCP 或端口映射选项 | 按上表逐项核对，不能据此认定适用 |
| 缺少关键能力且无法补齐 | 当前模式不适用；选择其他协同路由器，或在确认精确硬件支持及恢复条件后更换固件 |
| 加速、IPv6 或接口行为不明 | 标记待核验，补厂商依据或限定终端测试 |

“VPN 客户端”或“策略路由”菜单只是线索，可能不能交付到 LAN 外设。仅修改 DHCP 网关会改变来源 MAC 和关闭语义，仅修改终端 DNS 也不符合当前监听边界。VPN、桥接、跨网段及直接把外设当 DHCP 网关均需另行实现和验收；LAN 模式仍须对实际多终端和故障场景验收。

## 参数映射

合成输入见[自动网关部署样本](../examples/automatic-gateway-deployment.json)。

| CoCoProxy 输入 | 现场对应值 |
| --- | --- |
| `automaticGateway.gatewayIPv4` | 外设稳定 IPv4，路由器交付下一跳 |
| `automaticGateway.routerIPv4` | 交付链路上路由器 IPv4，外设出站与回程下一跳 |
| `automaticGateway.routerMAC` | 路由器交付接口单播 MAC |
| `automaticGateway.clientCIDR` | 完整接入 LAN 的规范 IPv4 CIDR，必须等于外设接口子网；排除路由器、外设和网络/广播源地址。路由器使用同一 LAN 范围，并负责入口身份和出站防循环 |
| `automaticGateway.clientIPv4` | 兼容单终端的受管 IPv4，与 `clientCIDR` 互斥 |
| `automaticGateway.ingressInterface`、`prefixLength` | 外设接口及三个角色共同子网；路由器使用自己的接口名 |
| `automaticGateway.dnsPort`、`management.deployment.dnsPort` | 必须相同，路由器转交 DNS 的目标端口 |
| `management.deployment.bootstrapResolvers` | 独立基础解析入口 |
| `management.origin` | 可达 HTTPS 地址，与证书和固定 Host 配置一致 |
| `egressMark`、`egressTable`、`egressPriority` | 外设自己的资源预留，不要求路由器使用同号 |

CoCoProxy 不自动写路由器，也不提供自动探测所有厂商能力或一键配置功能。具体路由器命令、控制接口和状态存储由其实现负责。

## 接入与验收

1. 核对两端条件、稳定身份及维护入口，各能力记为满足、待核验或缺少。
2. 独立安装 CoCoProxy，准备 HTTPS、管理员和来源，应用配置并确认核心与 DNS。
3. 路由器准备对应 LAN 范围（或兼容单终端）的选择、排除、DNS、IPv6 和故障规则，先确认外设离线时也能独立关闭。
4. 协调启用 DNS 和交付，验证至少两个客户端以及新加入地址的代理及 DIRECT 目标、本地管理、原来源、出口与经路由器回程，失败不能留下半套路径。
5. 分别验证核心、DNS 和链路故障时阻断，以及外设离线后关闭交付恢复普通直连。
6. 在维护窗口验证服务／网络重载、重连、重启和持续运行；按组合记录版本、已验证项与缺口。

日常应用可使用新鲜、有界的网关 DNS UDP 查询预检。失败保持原状态；成功只证明 DNS 可达。核心、接管、来源、出口及回程须独立观察，状态注明时间和有效期；路由器配置版本与 CoCoProxy 运行代次分别核对。重启或状态重建应先恢复阻断，再执行新鲜预检，不能依赖旧 ready 缓存。

当前发行的冷启动／规则清空缺口见发行说明。单一组合通过不能推导其他设备适用；对方项目的设计或变更由其自行确认。真实配置、原始结果及恢复记录按 [AGENTS.md](../AGENTS.md) 留在本地资料，正式结论只保留必要脱敏范围和对应版本。
