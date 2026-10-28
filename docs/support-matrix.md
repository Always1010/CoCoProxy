# 支持范围与设备条件

CoCoProxy 安装在 Linux 外接设备上；路由器负责终端接入、流量交付、DNS 和独立关闭，两端按[路由器契约 v1](router-contract.md)协作，不要求同一项目或特定品牌。本页说明当前 `1.0.2` 的设备条件和证据范围；组件字节以 [components.json](../integrations/metacubexd/components.json) 为准，审核见 [review.json](../integrations/metacubexd/review.json)，实际验收及缺口见[发行说明](release-notes.md)。

## 支持状态与证据

支持状态和证据等级分别判定，局部检查不能推导整机兼容。

| 状态 | 含义 |
| --- | --- |
| 已验证 | 指定版本组合完成列出的场景，仅覆盖该范围 |
| 有条件支持 | 有相应运行证据，须同时说明设置条件与未验项 |
| 待验证 | 入口可能适用，但缺目标运行或组合证据 |
| 不满足当前要求 | 缺少当前必需能力或超出安装/拓扑范围 |

| 等级 | 证据 | 不能推导 |
| --- | --- | --- |
| E0 | 源码、配置及文档定义 | 目标设备可运行 |
| E1 | 固定输入、类型/合成检查、装配及字节核验 | 目标 OS/内核/systemd/路由器可用 |
| E2 | 真实组件的回环、namespace 或隔离运行 | 实体接线、重启及持续负载通过 |
| E3 | 指定主机、固件及终端逐项物理组合验收 | 其他组合或未执行场景通过 |

预检仅确认当次可观察条件；完整路径、故障阻断、独立关闭及恢复仍按[首次部署验收](getting-started.md#9-部署验收与交给使用者)逐项执行。

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

## 当前组件与组合

| 对象 | 当前入口及证据 | 仍须验证 |
| --- | --- | --- |
| Linux ARM64 | 固定 Mihomo v1.19.33，E1 装配、E2 真实核心；发行说明列出部分 E3 安装/升级、管理及代理路径，有条件支持 | 独立干净首装、正式发行包安装、完整卸载/持久运行、物理断电/换口、实体多终端及持续负载 |
| Linux x86-64 | 固定 `linux-amd64-v1` 资产，E1 可装配；`runtimeVerified:false`，待验证 | 目标安装、核心运行、代理和完整维护 |
| 其他 Linux 发行版/内核 | 按实际 TUN、polkit、ip/nft JSON 能力、系统策略及生命周期核验 | 没有逐发行版/内核认证名单，不继承历史 ARM64 结论 |
| MetaCubeXD | 固定 v1.273.1 提交及 overlay，单实例 Node Server；E1 构建/适配类型检查、E2 回环管理/浏览器流程 | 上游全量类型检查、完整 systemd 组合及目标终端 |
| HTTPS | 匹配 origin/Host 的反代及证书；按[HTTPS](management-https.md)验收 | 终端证书信任、真实登录；HTTP 回环不覆盖远程 HTTPS |
| 无 systemd、其他架构、Windows/macOS、普通端口映射容器 | 不满足当前原生安装要求（E0 范围） | 在这些环境开发或合成测试成功不改变目标安装边界 |

历史 ARM64 主机的具体 OS/内核、CPU、systemd/Node/工具版本、载荷 manifest、操作日期及规模测量未在公开证据中完整记录，不用当前开发机信息补填。x86 的 v1 资产仅标识字节/指令集目标，不表示实际运行通过。核心版本、ELF machine 和各平台摘要由组件锁维护，不在本页重复抄录。Mihomo 语法、显式代理、回环 DNS/Controller 成功也不证明透明接管或回程。

### 路由器必须提供的行为

路由器向外设交付时保留终端 IPv4、使用核验过的交付接口 MAC；外设新出站及终端回程均经路由器。必须满足来源选择/防循环、回程、UDP/TCP DNS 和独立 bootstrap、受管公网 IPv6 阻断、故障保护、外设离线时独立关闭、持久意图及早期保护、正常重载和可观察状态。完整 R1–R9 定义及验收方式由[契约](router-contract.md)维护。

| 固件/组件现状 | 处理方式 |
| --- | --- |
| 原厂固件已具备全部能力 | 保留原固件，映射参数并验收具体版本 |
| 插件/脚本可以补齐 | 审阅权限、启动/重载、升级及撤销方式后验收 |
| 只有静态路由、VPN 菜单、DNS/DHCP 或端口映射 | 逐项核对契约，不能据菜单名称认定适用 |
| 缺关键能力且不能补齐 | 当前模式不适用；更换组件/路由器，刷机另核实精确硬件及恢复条件 |
| 加速、IPv6、接口或重载行为不明 | 标记待核验，不先放行 |

已有部分 E3 协作路径包含真实手机代理/普通站点、核心停止阻断、路由器独立关闭和管理登录，见发行说明。固件、AlwayRoute 及历史适配器版本未完整记录，不能认证任意 OpenWrt、原厂固件或品牌。当前可选 SSH 适配器的 `alwayroute-ubus/v1` / `1.0.0` 声明、能力检查和参数映射见[适配器约定](router-contract.md#alwayroute-参数映射)，不能追溯为历史实测。完整 R1–R9、DNS/链路故障、正常重载、启动次序、物理重连、多终端和负载仍待组合验收。

### 路由器流量与拓扑

| 场景 | 当前范围与限制 |
| --- | --- |
| 同子网 LAN IPv4 | `clientCIDR` 精确等于外设接口子网，排除路由器/外设/网络/广播源；支持动态加入。E2 覆盖双来源 TCP/UDP、新地址、经路由器回程、DNS 和停核心阻断，实体多终端并发仍待 E3 |
| 单终端兼容输入 | `clientIPv4` 与 clientCIDR 互斥；扩大范围须先关闭并协调两端，旧输入不自动扩大 |
| DNS | 公网 UDP/TCP 查询转交外设，本地域/无点名称保留基础解析，bootstrap 独立；局部 DNS 预检不代替出口/回程 |
| IPv6/其他协议 | 阻断受管公网 IPv6，保留本地控制管理；未提供完整 IPv6 代理，加密 DNS 和其他 IP 协议单独声明验证 |
| 单网口、同 LAN 重连 | 交付/出站/回程可共接口；两端持久启用后以已提交配置和新鲜证据恢复，依赖就绪后60秒为验收目标，物理场景仍待 E3 |
| 跨网段、外设直接作 DHCP 网关、桥接或 VPN 入口 | 尚无完整适配，不能只改地址或放宽来源进入当前范围 |
| 正常 firewall reload | 开启意图下先保护再恢复；offload、旧连接不能绕过策略 |
| 防火墙停止/全表 flush | 无连续阻断保证，不能当正常 reload 或宣称零窗口 |

暂时性故障应持续退避恢复，用户明确关闭优先，不能使用未应用草稿或陈旧 ready/DNS 证据放行。维护先暂停外设恢复再独立关闭路由器，具体顺序见[运维手册](deployment.md)。

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

## 增加兼容结论

记录日期、CoCoProxy 提交/载荷 manifest、核心和指令集、overlay、OS/内核/systemd/运行时/工具能力、安装方式、固件/组件/适配器版本及必要条件。未知写“未记录”，未执行写“待验证”；分别记录安装、代理、完整维护以及首装/升级/卸载/重启，不能代填。

按契约逐项验证设置读回和撤销、HTTPS、DNS、TCP/UDP、DIRECT/代理出口、原始来源与回程、故障阻断、独立关闭、重载、启动顺序、重连和新终端；规模/资源结论绑定场景与持续时间。原始配置和恢复记录留在本地，正式文档只保留脱敏版本、结论及缺口。review.json 的 `compatibilityVerified:false` 不因构建或发布改为 true。
