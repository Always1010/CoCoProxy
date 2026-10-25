# Mihomo 原生网关配置

网关只接管路由器交付的终端流量。配置通过固定核心支持的 `exclude-uid-range` 排除所有有效本机 UID 的本机流量，保留管理服务和主机应用的原有出口；仅限制入口接口不足以排除自动路由对本机连接的影响。核心自己的带标记出站仍由优先级更高的部署出口规则交给接入路由器。该边界需同时验证实际本机连接和被转交的终端连接。

`profile.ts` 复用现有离线策略编译器，并为固定审核版本 Mihomo v1.19.33 生成原生 TUN `auto-route` / `auto-redirect` 配置。配置编译不执行网络命令、启动核心或安装依赖。默认显式代理路径继续拒绝此类候选；可信 `RuntimeSettings.automaticGateway` 明确选择原生模式后，管理保存／捕获／应用与现有 `SystemdMihomoRuntime` 使用同一入口和事务。

原生运行设置只接受 `AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM` 中固定审阅的 ARM64 或 x86-64 v1 二进制摘要，目录须与发行审阅记录一致；部署 JSON 无法自行扩充信任。目标机还须通过真实 ELF、主机架构、系统工具和内核能力预检。x86-64 下载摘要和 ELF 已核验，仍须在目标架构上完成运行及终端验收，不能把跨架构打包成功当作实际联网通过。

`parseAutomaticGatewaySettings` 只接受字段完整的 schema 1 普通 JSON 对象。`clientIPv4`（兼容单终端）与 `clientCIDR`（整个接入 LAN）必须且只能提供一个；后者必须是 `gatewayIPv4/prefixLength` 对应的规范网络地址，不能提供任意子网、其他网段或主机位。LAN 模式覆盖动态加入的普通 IPv4 主机，排除网关、路由器及网络/广播源地址。两种模式下角色地址必须不同、属于同一子网且为有效主机地址，子网不得覆盖固定 TUN 地址 `198.18.0.1/30`；接口不得为 loopback 或 TUN。MAC 必须为单播地址。DNS 使用非特权端口，MTU 范围为 1280–9000。部署出口表范围为 2000–19999 并保留上游表 2022；出口优先级为 1000–8997，其后两个优先级用于终端接管，LAN 回程规则与第一个终端规则共享优先级但以互斥入口匹配，均先于原生规则 9000；出口 mark 必须为正 32 位整数，并避开上游 2023/2024。

`compileAutomaticGatewayConfig(base, settings)` 先调用 `compileConfig` 验证策略、内存来源快照和部署隔离，再覆盖固定原生配置。显式代理和控制入口保持回环监听；DNS 仅监听部署网关地址和专用端口，关闭 TUN DNS 接管，沿用真实地址解析。核心连接绑定入口接口及出口 mark；直连子网从自动 TUN 路由排除。原生路由表、规则优先级和重定向 mark 固定为上述已审阅值。部署出口表和优先级由独立网络服务落实，不能仅凭配置存在就宣称生效。

规范化部署设置放入保留字段 `x-coproxy-gateway`，与完整核心配置一起参与 SHA-256 代次计算，因此路由器、客户端、表和规则优先级变更也会改变代次。来源和策略不能写入该保留字段或覆盖网络配置。输入不接受额外字段、调用钩子、访问器、Proxy、循环对象及其他非 JSON 数据，不会调用这些输入中的代码。

`automaticGatewayPolicy` 提取可重新编译的策略；`recompileAutomaticGatewayConfig` 使用调用方提供的可信部署设置重建候选。调用方必须核验重建候选的代次与不可变存储的代次完全相同，并核验固定核心二进制摘要；不能把候选中自带的部署元数据当作授权。单独提取策略或重建对象都不是对输入候选的真实性证明。

该原生路径缩小了自主维护的网络执行逻辑，依赖成熟上游实现自动接管。它不承诺旧 `packages/network` 路径的完整进程身份、资源所有权、fence、回程证明和防泄漏状态机契约。配置通过审核核心的 `-t` 只证明语法可解析；软件编译和测试通过也不证明终端流量已经正确接管。实际激活、故障封锁和设备验收必须由对应运行及网络服务提供独立证据。

聚焦测试位于 `tests/gateway-profile.test.ts`，验证网络边界、代次绑定、恶意输入、可信重建及默认显式运行路径拒绝。可显式提供 `COPROXY_TEST_MIHOMO` 指向已审核二进制执行真实 `-t`；测试首先核验摘要，未提供时跳过该项。

## 小型独立网络单元

`renderAutomaticGatewayHostPlan` 生成 `coproxy-gateway-network.service` 与 root 设置；`apps/gateway/network.py` 使用系统 Python 标准库执行固定 `ip`／`nft` 参数，不提供 HTTP 监听或通用命令接口。核心 unit 通过 Requires/After/BindsTo 依赖网络 unit，管理 unit 不获得网络 capability。核心自动资源使用上游表 2022、规则 9000 起及重定向 mark；本组件管理不同名称的 `coproxy_auto_guard`、一张显式部署的出口表、客户端回程，以及两条同时限定来源范围和入口接口的规则：LAN 目的地址先查主表，其余交给上游 TUN 表。这两条规则先于 UID 排除，避免被转交的 UDP 绕过 TUN；本机应用不匹配该入口。兼容单终端保留主表 `/32` 回程；LAN 模式使用 `egressTable + 20000` 的独立回程表和 `iif coproxy-tun to clientCIDR` 规则，回程下一跳仍是路由器。该表范围为 22000–39999，部署前必须预留；prepare 会拒绝已有资源。LAN 模式不替换主表的已连接路由，不把主机自身的 SSH/管理应答送回路由器。

root 源码、设置及其祖先不可由普通用户写入；自有源码／设置／状态路径拒绝链接。系统可执行路径可经过受 root 保护的发行版链接，逐段检查链接和目标。网络回执目录独立于管理状态，要求 root:0700。单一 flock 串行执行，回执绑定 boot、设置摘要、完整 guard AST/handle 和实际路由／规则。TUN 命名入口规则的 `iif_detached` 是核心启停的内核生命周期标记，回执只规范化该标记，其余选择器、接口名和表仍完整比较。同 boot 的重复 prepare 只核验，不重复添加；预检拒绝冲突和旧自动资源。部分执行留下不完整回执，普通 prepare/remove 都拒绝自动猜测归属；当前版本需要操作者检查并处理。

prepare 要求已有 `ip_forward=1`，不修改 sysctl、默认路由、系统 DNS 或其他网络资源。它先装独立 guard，再添加标记出口、回程和两条终端接管规则；回执核验及移除覆盖这些规则。guard 限定交付入口、受管 IPv4 范围和路由器 MAC，DNS 仅接受路由器或本机请求，阻止受管公网流量原样转发，丢弃经此入口转发的 IPv6。接入路由器仍须阻断受管终端未交付的公网 IPv6；此 guard 不能控制从未到达网关的流量。

停止核心或网络 unit 保留 guard。用户关闭代理由接入路由器撤销交付并恢复其 DNS，不能把核心停止等同于用户关闭。完整退役须先关闭路由器交付并停止核心，再由 root 显式执行 `python3 -I /installed/source/apps/gateway/network.py remove --settings /private/root/gateway-network.json`；remove 要求 TUN 已消失、回执完整、当前资源完全匹配，最后才移除 guard，不清理上游或其他操作者的资源。

## 部署计划

[完整合成样本](../../examples/automatic-gateway-deployment.json)只描述角色和文档地址，不能直接安装。将其复制到私有输入并替换经核验的参数后，使用现有命令生成待审阅计划：

```sh
npm run cli -- deployment-plan --input /absolute/private/deployment.json --output /absolute/private/plan.json
```

原生计划包含三个 unit、服务 UID 的运行和管理设置、root 网络设置及既有精确 polkit 规则，共七个文件；另列出独立 root 回执目录。生成计划不会安装、启动、enable 或修改网络。实际部署须审阅 capability、接口／地址、mark／表／优先级冲突、转发前提和恢复路径，单独执行获准的安装步骤。只生成 `runtime-plan` 不会产生完整网络前置单元。

网页工作区可导入订阅、保存和应用方案；候选捕获在应用流程内部执行，部署范围不能由浏览器修改。兼容草稿摘要只包含基础策略，原生候选额外包含可信网络设置，以最终候选 generation 为准。状态区分核心和待验收网关，不把单元 active 或配置成功表示为真实终端联网通过。

## LAN 范围验证与迁移

路由器与网关必须配置相同的接入 LAN 范围；例如网关使用 `clientCIDR: "192.0.2.0/24"` 时，不再携带 `clientIPv4`。路由器仍负责保留原来源、排除本地控制和网关出站、阻断未交付的公网 IPv6，不能用放宽网关来源范围代替这些行为。

`tests/gateway-host-plan.test.ts` 的可选内核验证使用审核核心和五个独立网络命名空间，检查两个客户端 TCP/UDP、新加入地址、路由器专用 DNS、实际回包经过路由器的计数、主机路由、错误来源 MAC 及核心停止后的阻断。显式设置 `COPROXY_TEST_GATEWAY_KERNEL=1` 与 `COPROXY_TEST_MIHOMO` 后运行该测试；它需要已有的免交互 `sudo`，只在全 UID/GID 映射的子 user namespace 和独立 net namespace 中配置合成网络，不安装依赖或修改主机网络。全 UID 映射用于真实运行生产的全 UID 排除规则，单 UID 映射无法表示该内核规则。该验证不替代真实接入路由器、多终端硬件、重启或持续运行验收。

变更受管范围会改变候选代次。迁移前先独立关闭路由器交付并停止核心，再用**旧版本 helper 与旧设置**显式 remove 完整旧网络回执，保留其他资源；否则新设置摘要与旧回执不符会拒绝 prepare。随后安装新设置与软件，先启动管理及 HTTPS，经工作区应用重新编译并激活新范围的候选，确认成功后再开启路由器 LAN 交付。不能只更改 runtime 设置后启动仍指向旧代次的 selection，也不能手工伪造 active/selection。已完成且无 fault 的管理状态可在旧候选尚未迁移时启动；新应用失败后的回滚可能因旧候选范围不匹配而进入 fault，应保持交付关闭，恢复匹配旧设置后走显式事务恢复。
