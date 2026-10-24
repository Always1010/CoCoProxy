# 首批开发与验证

当前已实现配置、草稿、来源、事务、systemd 运行适配源码、管理认证、受限控制器代理和开发 CLI。适配后的 MetaCubeXD Server/UI 已通过构建、界面类型检查和实际浏览器的登录／草稿／捕获／冲突／注销流程。六种协议已通过真实客户端与服务端的回环 HTTP／UDP 及错误凭据检查；透明网关配置和规则已通过四角色隔离内核测试。生产网络执行者尚未接入，其他传输变体、外部节点和真实 LAN 接管仍未验收。服务尚未安装；浏览器回环验证也不代表真实 systemd 应用成功。

## 环境与命令

使用 Node.js 22.18 或更高版本的原生 TypeScript 类型擦除。当前管理代理和 YAML 解码使用根锁文件固定的 ws、yaml；获准后执行 `npm ci --ignore-scripts --no-audit --no-fund`。类型擦除只加载代码，不执行静态类型检查。Linux 运行检查在明确的独立项目工作区完成，不能用其他操作系统的结果替代 Linux 文件权限、锁和进程行为验证。

严格检查工具以 `tooling/package-lock.json` 固定 TypeScript 5.9.3、Node 22 类型和 pnpm 10.34.1。在获准的项目目录执行 `npm ci --prefix tooling --ignore-scripts --no-audit --no-fund`，再运行 `npm run typecheck`。这不替换系统 Node 或包管理器；node_modules、缓存和上游构建产物不参与源码同步及提交。

以下命令从仓库根目录执行。样本只使用合成节点、文档专用 IP 和示例凭据，适合离线编译，不是可联网的部署配置。

```sh
npm run cli -- help
npm run cli -- compile --input examples/explicit-proxy.json --output "$PWD/.local/runtime/mihomo.json"
npm run cli -- stage --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store"
npm run cli -- status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-save --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- draft-status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-stage --state-dir "$PWD/.local/runtime/store" --expected-revision 1
```

compile 要求显式绝对输出路径，生成私有文件且不覆盖已有目标。stage 只保存不可变候选；status 是只读的历史状态，没有状态文件时返回空状态。公共输出只含摘要、状态和固定错误码，不打印生成配置或核心原始诊断。所有实际配置和运行状态均应在私有区域，不能提交。

已有、已审阅的核心可用于实际语法检查：

```sh
npm run cli -- validate --input /absolute/private/input.json --mihomo-bin /absolute/path/to/reviewed/mihomo
```

此命令只调用核心的 -t 模式，在权限受限的临时工作目录内校验，不启动服务。默认超时 15 秒、输出总量 64 KiB；超时终止原进程组并设置最终截止，临时内容在结束后清理。原始诊断可能含凭据，因此不输出。必须信任显式指定的二进制；该包装器不是恶意进程沙箱，不能保证清除自行脱离进程组的恶意后代。

草稿保存使用严格 revision 检查，与运行代次分开；首次保存使用 expected-revision 0。draft-stage 捕获指定保存版本并暂存对应候选，返回 stagedRevision，不应用配置。捕获后其他人可以继续保存新草稿，暂存回执仍指捕获的版本。公开的 draft-status 只有摘要与版本，私有输入不打印。

CLI 另提供 runtime-plan 纯生成和显式 runtime-apply/recover/status。后者使用固定单元的生产 systemd 适配器，没有模拟成功路径；须先取得独立安装授权并完成部署预检。详见[运行适配](../packages/runtime/README.md)。可先离线生成审阅计划：

```sh
npm run cli -- runtime-plan --input examples/runtime-deployment.json --output "$PWD/.local/runtime/service-plan.json"
```

示例的二进制摘要和 UID 为合成占位值，不能直接安装。该命令只创建私有计划文件；不会创建账户、复制系统单元、daemon-reload、enable 或 start。

`npm run cli -- deployment-plan --input /absolute/private/deployment.json --output /absolute/private/installation-plan.json` 组合核心与管理服务计划，输出两份 unit、两份私有设置、受限 polkit 规则及目录权限清单。输入须为私有文件，格式参考 `examples/deployment-plan.json`，其中路径、UID、核心摘要和 secret 均为合成占位值。整个计划包含 controller secret，不能提交或公开打印。它不创建管理员凭据，不安装或启动服务；接口和真实解析器检查方法见[部署计划说明](../packages/deployment/README.md)。

## 订阅节点快照

来源定义和 HTTPS 许可策略都从私有 JSON 文件读取，避免将查询令牌暴露在命令行。以下占位路径需换成自己的私有文件，格式参考 examples/subscription-source.json 和 examples/subscription-policy.json；示例域名不是实际来源。

```sh
npm run cli -- source-configure --input /absolute/private/source.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- source-status --source-id example-feed --state-dir "$PWD/.local/runtime/store"
npm run cli -- source-refresh --source-id example-feed --state-dir "$PWD/.local/runtime/store" --expected-revision 1 --policy /absolute/private/https-policy.json
npm run cli -- source-stage --source-id example-feed --input /absolute/private/base.json --state-dir "$PWD/.local/runtime/store" --expected-revision 2
```

来源操作返回 revision。成功刷新、304 和持久化的刷新失败都会递增它；后续操作必须使用实际返回/重新读取的 revision。失败保留上次接受的快照；更换 URL 后旧快照暂不可用于新定义。source-stage 捕获指定来源版本，将节点加入基础配置的 sources 后编译并暂存，返回捕获的来源 revision 和快照 revision。基础策略需引用所需节点，重复来源或节点名由编译器拒绝。该命令不应用配置，也不把其他同时发生的草稿保存视为已应用。

CLI 的 source-refresh 沿用严格 JSON `{proxies:[...]}` 解码；管理服务显式注入 `decodeNodeSnapshot`，接受 JSON 或单份 Clash YAML 1.2，仅导入 proxies。来源的策略、规则、provider 和脚本不会导入，不支持 URI/base64 订阅转换。两者共享节点安全校验和版本存储。详见[订阅模块](../packages/subscriptions/README.md)与[HTTP 客户端](../packages/subscriptions/http.md)。

## 针对性检查

```sh
npm run test:config
npm run test:transaction
npm run test:drafts
npm run test:subscriptions
npm run test:mihomo
npm run test:cli
npm run test:runtime
npm run test:deployment
npm run test:release-stage
npm run test:network-plan
npm run test:network-config
npm run test:network-candidate
npm run test:network-runtime-plan
npm run test:network-runtime
npm run test:network-management-observer
npm run test:network-driver
npm run test:network-watchdog
npm run test:network-helper-http
npm run test:network-core-observer
npm run test:network-observer
npm run test:network-command
npm run test:network-fenced-command
npm run test:network-resource-journal
npm run test:network-native-preflight
npm run test:network-rules
npm run test:network-identity
npm run test:network-link
npm run test:network-host
npm run test:network-sockets
npm run test:network-transaction
npm run test:network-probe
npm run test:network-readback
npm run test:management
npm run test:git-tree
npm run test:subscription-yaml
npm run test:overlay
```

按修改范围选择命令。配置测试覆盖保护边界和稳定摘要；事务测试覆盖完整性、CAS、回滚、中断、跨进程锁、Linux 死锁核验和权限；草稿与订阅测试覆盖保存/刷新并发、旧回包、失败数据保留和输入完整性，HTTPS 测试用已有 openssl 生成临时证书并执行实际 TLS 握手；核心包装器测试使用明确的可执行测试替身；CLI 测试验证真实命令行进程、私有输出和不伪报运行状态。不能用这些测试宣称协议节点、核心实际语法、网关接管、DNS 或终端出口已验收。

`test:release-stage` 使用合成 Git 仓库、普通运行依赖副本和假核心，检查装配的来源、排除规则、摘要、不覆盖与失败清理。真实载荷装配使用干净 HEAD、固定核心和已构建的 Server/UI，方法见[发行装配说明](release-staging.md)。载荷不含部署设置、管理员凭据或本地资料；装配通过仍不表示服务已经安装。

来源提交 `54fe3fd62090fe5d935a5958645614b1cddaf39f` 的固定显式发行已另行完成实际 Linux/systemd 安装与回环验收：非 root 专用身份、登录、精确授权的非交互权限矩阵、真实应用及 CAS、受限控制器代理、语法失败保留旧实例、激活／恢复失败后的持久故障和显式恢复、合成 REJECT 无直连回退、注销及安装后完整载荷核验。两项服务未启用开机自启，TUN 未启用；此结论仅对应该固定显式组合，不证明后续网关源码、真实节点、外部 DNS 或终端接管已验收。实际安装与当前环境资料保持私有，单元测试本身仍不安装服务。

`test:network-plan` 检查[单终端网络资源契约](../packages/network/README.md)，包括 guard／黑洞／证据／激活顺序、强制回程、mark 保留位、共享 UID 下的逐 socket 核心身份和严格部署输入。它只渲染计划，不执行 nft、ip、sysctl 或系统服务；通过不能作为内核、网关或终端出口的就绪证据。

`test:network-config` 验证[网关候选预览](../packages/network/config.md)的核心配置与网络部署代次绑定，以及当前显式运行适配器拒绝这种候选的边界。提供固定 `COPROXY_TEST_MIHOMO` 时另执行真实语法校验；该命令不启动 TUN。`test:network-command` 检查有界 stdin／输出、固定错误及超时后的进程组收敛；`test:network-rules` 检查三个阶段的受限规则、DNS 握手例外与 mark 保留边界。后两者不能证明真实内核转发成功。

`test:network-candidate` 验证私有网关候选的完整重编译、可信 plan／核心绑定、hash-valid 篡改拒绝和私有读取，并确认显式 loader 仍拒绝网关 profile。`test:network-runtime-plan` 核验 root state 与独立 coreHome、credential 路径、有限权限、禁用自动重启及 systemd 转义；Linux 已有 systemd-analyze 时还实际只读解析两个路径变体，没有工具时明确跳过。`test:network-runtime` 使用真实私有文件与锁、明确的 systemd/worker fixture 模型验证 stop/选择/start 的持久协议、manager 收敛、blocked 门槛、恢复只 stop、输入大小与错误边界。它们不安装单元，不代表生产 systemd lifecycle、credential 实际快照或完整 driver 已验收。

`test:network-core-observer` 验证[详细运行事实观察](../packages/network/core-observer.md)：固定 systemd 状态、运行 executable、精确 argv、核心实际 mount view 中的 credential 代次，以及认证 controller 的监听归属与前后稳定性。使用合成 reader，不安装服务，也不替代真实固定 unit 的生产正向观察。

`test:network-management-observer` 验证[固定管理服务 PID 来源](../packages/network/management-observer.md)的受信 systemctl/unit、实际进程 UID、namespace、启动时间与前后稳定性，并拒绝调用者自报 PID。`test:network-driver` 验证[固定驱动组合](../packages/network/driver.md)的生命周期和恢复顺序；Linux 子项连接真实协调器与持久文件，核验操作屏障、未知失败拒绝直接重试和显式恢复。核心、资源与观察依赖仍是 fixture，不代替生产两个服务和完整网络组合验收。

`test:network-watchdog` 验证[同进程运行监测](../packages/network/watchdog.md)的启动恢复、串行检查、故障后保持阻断与停止恢复。协调器运行检查另验证原激活身份不被替换、健康检查不写 journal／revision、参数和 CAS 拒绝不撤销原健康实例，以及 busy 检查不会撤销另一成功检查的授权。真实内核测试还验证 TUN 消失导致旧资源会话失效后，从持久凭据重新打开并恢复 blocked；不把 fixture 监测与隔离资源验证合并为生产服务验收。

`test:network-helper-http` 使用真实回环 HTTP 与合成 handler 验证[helper 传输边界](../packages/network/helper-http.md)：令牌摘要认证、精确路径与 Host、浏览器头拒绝、规范有界 JSON、请求体期限、并发上限、业务请求断开后继续及关闭等待。候选编译、可信根配置和 helper 主程序尚待接入；传输层不宣称生产 driver 已安装。

`test:network-observer` 验证[组合运行证据](../packages/network/observer.md)的完整来源、核心及管理身份稳定性、同代 plan 绑定、30 秒窗口、资源阶段及未收敛错误传播。生产入口固定组合真实读取函数，fixture 才能注入依赖；固定服务下的生产正向观察尚待部署后验收。各有命令的底层观察另返回 `commandsSettled`，缺失或未收敛时组合器保留驱动 fence，不把普通失败当成工具已退出。

`test:network-identity` 用合成 reader 验证固定 cgroup 的完整 64 位身份、namespace、权限、唯一成员、覆挂与读取竞态，支持独立管理 UID；fixture 始终保持 fixture 来源。Linux 固定 unit 下的正向生产观察仍需独立部署后验收，不能把跳过项计为通过。`test:network-transaction` 使用明确 fixture driver 验证持久意图、逐操作 fence、30 秒证据、CAS、启动恢复和未知操作收敛；Linux 非 root 子项实际模拟目录写入失败，并强制终止变更中的独立进程，确认只恢复阻断。它们不执行 nft、ip 或 systemd，也不替代 native driver 验收。

`test:network-probe` 检查严格 DNS 报文、精确 socket/TUN 所有权、PID/namespace 变化与固定错误；单元层使用合成 reader。`test:network-readback` 检查 nft AST/handle、完整提交 echo、RPDB、专用路由、pre-core detached 注记及外部资源拒绝。其纯解析结果不能替代真实命令输出或受保护的所有权回执。

`test:network-link` 检查[入口链路与邻居观察](../packages/network/link.md)的真实字段形状、接口/地址一致性、carrier、MTU、精确邻居 MAC、REACHABLE/PERMANENT 状态和 mark/source/UID 路由选择；合成 reader 不修改或刷新邻居。真实 iproute2 输出另在四角色隔离测试中核对，不能推导生产物理入口或真实终端已验收。

`test:network-host` 验证[只读主机预检](../packages/network/host.md)的初始命名空间、可信挂载与工具、转发参数、XFRM、全部接口 TC/XDP、legacy 防火墙和固定 BPF 枚举契约。完整正向使用合成 reader；Linux Python 子项验证实际 syscall attribute 布局、错误分类、seccomp 状态拒绝、完整稳定枚举与 FD 清理，并执行一次真实只读枚举查询。该子项不加载 BPF、不调整主机；非 Linux 明确跳过。生产 root 正向仍需独立验收。

`test:network-sockets` 检查[逐 socket 来源观察](../packages/network/sockets.md)的实际 mark/cgroup 字段、FD 完整分类、专用 UID 占用、DNS listener、临时连接替换和缺失证据拒绝。生产读取通过 root 控制的 Python 3 标准库辅助程序完成，Python 是该网关组件的显式运行依赖，不自动安装；未连接 UDP 或 TCP SYN pending 不计作上游连接，连接存在也不等于业务探针通过。

```sh
COPROXY_TEST_MIHOMO=/absolute/private/reviewed/mihomo COPROXY_TEST_SING_BOX=/absolute/private/reviewed/sing-box npm run test:network-kernel
```

`test:network-fenced-command` 在 Linux 验证持久 ACK 之前不启动工具、父进程退出与工具后代收敛、私有文件／目录和结果绑定、显式 namespace fixture 来源，以及空 stdin 的快速退出竞态。`test:network-resource-journal` 验证只读不初始化、锁、revision、冻结、重复键与恶意对象拒绝、文件单链接和权限边界。这些是内部组件验证，不替代实际内核路径。

`test:network-native-preflight` 在隔离测试进程中禁止初始化、持久写入和旧 worker 收敛调用，验证正式只读入口的资源、context、revision 与 pending 命令绑定，以及仅保持相同保护参数的旧代次识别。显式 settlement 入口先核验可信旧操作，再只收敛旧 worker；它必须由协调器在持久 settling fence 后调用。四角色内核测试在资源进程启动前分别验证只读观察与显式收敛，核对新目录仍不存在、既有及 pending 回执字节不变；另实际恢复 blocked、重绑定代次、重新打开并迁回，核对 nft／路由不变与旧实例被拒绝。资源元数据迁移使用合成核心摘要，不代替真实新核心部署验收。

`test:network-kernel` 核对两个固定官方二进制的摘要，使用已有 Python、ip、nft、unshare 和可用 TUN，在新建 user/network namespace 子树内建立客户端、路由器、网关和源站。网关初始阶段通过正式持久资源会话执行并回读，而非手工应用规则；实际 DNS/TUN 探针核验核心 FD 并发出查询。另通过正式链路观察读取真实 iproute2 输出、通过 INET_DIAG 核对核心 FD 的实际 mark 与 socket cgroup ID；隔离拓扑显式设置合成路由器 PERMANENT 邻居，避免依赖 ARP 状态机计时，不代表生产邻居已核验。测试验证同配置外部路由不被认领、额外 nft 规则污染被拒绝、ip/nft 完成但资源凭据仍 pending 后重启、采纳状态后的第二次强制终止、active 重启和 TUN 消失后恢复 blocked、过期实例拒绝，以及 core-only 本地 DNS 与客户端阻断、active 透明 HTTP／UDP、真实 DNS UDP／TCP、DNS 回答驱动的业务访问、域名 REJECT、保留源地址与经路由器回程；还检查错误 MAC、无 mark 同 UID socket、核心退出、独立删除 TUN 及唯一节点退出后的故障阻断。没有 DIRECT 回退。

该 fixture 仅在已核验隔离的 namespace 内准备转发参数、veth 和路由，不配置主机网络，不安装 systemd 服务。它复用现有真实 cgroup 并禁用管理例外，资源会话尚未连接持久协调器，因此不证明生产管理／核心两个服务 cgroup 的隔离、完整服务恢复或真实设备联调。pending 与第二次崩溃使用可信 fixture 明确设置持久边界，不声称覆盖任意时刻的掉电。清理既核对原进程组，也核对专用 user namespace 中的工具子进程。缺少显式二进制路径或 Linux 前提时跳过，不能计为通过；已提供路径后，隔离能力或实际路径失败会报错。测试不会自行安装缺少的软件。

真实核心另由显式命令执行：`COPROXY_TEST_MIHOMO=/absolute/private/reviewed/mihomo npm run test:core-live`。未提供路径时该项跳过，不下载程序；提供的二进制必须匹配 review.json 中已审阅的解压后摘要。测试执行真实 `-t`、PID/控制端口核验、回环 HTTP 转发和 UDP/TCP localhost DNS；只用高位 loopback 端口和临时私有目录，不安装服务或修改系统网络，不代表外部节点、WAN DNS 或透明接管验收。

`COPROXY_TEST_MIHOMO=/absolute/private/reviewed/mihomo COPROXY_TEST_SING_BOX=/absolute/private/reviewed/sing-box npm run test:protocol-live` 另执行 VMess AEAD/TCP、VLESS/TCP、Trojan/TLS、Shadowsocks aes-128-gcm、Hysteria2 和 TUIC v5 的真实协议测试。每种协议都验证正确凭据下 HTTP nonce 与 UDP echo 可达，以及错误凭据下两者均不能到达源站；没有 DIRECT 回退。相同环境变量下，`npm run test:protocol-reality-live` 独立验证 VLESS REALITY：正确凭据通过 HTTP／UDP，错误 UUID、公钥和 short ID 分别无法触达源站，合成 TLS 1.3 握手目标仅在回环提供。两个可执行文件都必须匹配固定审阅摘要。测试只使用本机临时端口、合成节点和临时证书，不涉及外部订阅、生产信任链、系统服务或网络配置；REALITY 不涵盖 Vision flow。范围和已执行结果见[协议联调记录](../integrations/protocol-fixture/README.md)。

管理模块的 API 与认证见[管理说明](../packages/management/README.md)，上游源码、overlay 装配和构建命令见[适配记录](../integrations/metacubexd/README.md)。`test:management` 使用回环 HTTP/WS 与显式运行替身；`test:management-live` 另以 `COPROXY_TEST_SERVER` 指向已构建 Server。提供 `COPROXY_TEST_PLAYWRIGHT`（已安装模块绝对路径）和 `COPROXY_TEST_BROWSER`（浏览器可执行文件绝对路径）时，才运行浏览器子项；缺任一参数会明确跳过，不能计为浏览器验收。可将截图写入显式 `COPROXY_TEST_ARTIFACTS` 私有目录，含当前地址的截图只留本地。

真实 Server 检查创建临时合成凭据和无服务目标，只绑定临时 loopback 端口；验证所有 WebSocket 升级、旧路由拒绝、登录、保存、捕获、CAS 冲突保留与注销。不会安装服务或执行真实核心应用。真实核心测试另验证受限代理的查询和流量流，仍不证明 systemd 部署或终端出口就绪。

## 后续实施顺序

1. 在获准的项目目录准备固定上游源码、包管理器和锁定依赖，补静态类型检查。审查固定核心资产并记录摘要，不跟随浮动版本。
2. 依据上游适配记录接入配置编辑、订阅和唯一生命周期管理者，所有应用进入本仓库事务入口。先完成仅回环的显式代理闭环。
3. 实现受限网络执行服务与独立就绪检查；网络改动先做隔离测试，再按单终端协作范围进入设备验证。
4. 故障恢复和独立关闭通过后，才扩大接管范围与测量性能。

依赖安装、服务部署和系统网络变更分别列出实际操作与影响，遵守项目授权边界。源码同步先预览，显式排除 .git、.local、凭据、缓存和产物，不跟随本地共享链接。设备与当前环境的原始证据仅保存在本地资料区。
