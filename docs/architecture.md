# Coproxy 软件架构

本文记录模块边界与开发方向；验证方法和范围见 development.md。显式代理、管理网页与受控事务已经实现，固定显式发行已完成经授权的实际 Linux/systemd 安装与事务验收。首轮透明网关使用 **Mihomo 原生自动接管＋小型独立网络 oneshot**，接入现有管理、候选与事务入口；旧自研网络框架作为对照保留。自动接管及 guard 已通过隔离内核验证，ARM64 安装和首轮单终端链路也有实际证据；各项范围见[协作验收](router-cooperation.md)，不泛化为其他路由器已经兼容。

## 模块与唯一归属

| 模块 | 职责 | 当前状态 |
| --- | --- | --- |
| packages/config | 部署边界、用户策略和离线节点快照编译，生成内容代次 | 已实现 |
| packages/drafts | 保存草稿、修订号 CAS 和私有输入捕获，与应用状态分离 | 已实现 |
| packages/subscriptions | 来源修订号、受限 HTTPS、节点快照和失败保留，刷新提交时再次 CAS | JSON 与管理端 Clash YAML 节点解码已实现 |
| packages/transaction | 私有存储、并发冲突、应用提交点和中断恢复 | 已接运行适配；固定显式发行已通过真实 systemd 应用、失败与恢复验收，透明网关事务另验 |
| packages/runtime、apps/runtime | systemd 唯一监管、部署计划、exec 启动与进程/控制端口就绪 | 固定显式服务及 ARM64 原生网关已有实际安装、启动和就绪证据 |
| packages/mihomo | 调用指定核心进行有界、脱敏语法校验 | 固定核心语法、HTTP／DNS／控制器及六种协议回环已验证 |
| apps/cli | 编译、校验、候选、草稿、来源、部署计划与显式运行事务 | 已实现，服务命令须先完成授权安装 |
| packages/management | 独立认证、会话与受保护的草稿/来源/事务接口 | 已挂载 Nitro Server，HTTP／WS 共用会话和运行代次边界 |
| 管理服务与界面 | 复用 MetaCubeXD 界面与 Nitro Server，挂载自有认证及事务 | 登录、策略／订阅、候选与冲突流程已通过浏览器回环验证；原 Agent 监管禁用 |
| packages/deployment、发行装配脚本 | 生成服务与权限计划；装配固定载荷、离线安装/升级及保留资料卸载 | ARM64 公开入口已实际安装及升级；卸载生命周期另有隔离验证，生成计划不自动授权系统变更 |
| packages/gateway、apps/gateway | 复用核心自动路由；生成原生配置及必要的独立 guard、出口和回程资源 | 已接同一管理/运行事务；root oneshot 提供 prepare、核验重复执行和显式 remove；已有首轮单终端实际联调 |
| packages/network | 保留的自有网络执行与强证据方案 | 作为已验证的对照实现保留；暂停扩建，不与原生接管同时启用 |

全部配置应用由同一事务入口负责，订阅更新、网页编辑和后台任务不能分别改写运行配置。systemd 是核心唯一监管者，启动器直接 exec 替换自身；管理后端只申请固定核心单元的受限 start/stop。原生网关中，Mihomo 独占 TUN、自动路由和重定向资源；root oneshot 只管理不同名称的独立 guard、一张标记出口表及终端回程路由。旧网络执行器与原生模式互斥。

## 首轮原生网关

[原生网关模块](../packages/gateway/README.md)在可信运行设置中显式选择 `automaticGateway`。浏览器继续编辑策略和订阅，不能修改入口、来源、出口、DNS 监听或特权配置。候选使用同一内容代次、暂存和应用事务；默认显式服务继续拒绝 TUN 候选。核心状态仍只代表核心，网关模式已配置与真实终端路径通过分别显示。

独立网络单元先建立 guard，再准备标记出口和终端回程；核心通过 Requires/After/BindsTo 依赖该单元，只有核心取得所需网络 capability，管理服务不取得网络权限。核心正常退出会清理上游自动资源，因此停止核心和网络单元均保留独立 guard。用户关闭直连由接入路由器独立完成；完整退役由操作者先关闭交付、停止核心，再显式移除已核验的自有资源。

该方案采用单一可信安装者和操作者的边界。root 私有回执核对 boot、配置摘要及完整资源读回；部分执行保留不完整回执并拒绝猜测重试，需要操作者检查。它不宣称继承旧框架的逐进程 fence 或对并发特权修改者的完整保证。软件开发、实际安装和各路由器组合的联合验收分别记录，现有单终端通过不替代新拓扑或固件的验收。

## 配置与运行

配置分为受保护部署参数、用户策略、来源快照和编译代次。来源不能覆盖接管、认证、监听和出口边界，所有合法高级字段由选定核心继续校验。策略高级编辑使用 JSON；管理服务在受限解码器中接受 JSON／Clash YAML 来源并只提取节点，不导入来源规则、部署或脚本。核心 HTTP 与实时流固定经同源受限代理，浏览器不直接持有 controller secret。

先暂存不可变候选，再进行核心校验、网络预检、持久化应用、就绪确认和提交。失败恢复上一确认状态；恢复失败保留事务和故障，不宣称已应用。运行适配器必须自行有界并在失败后停止副作用，避免尚未结束的激活与回滚并行。历史提交成功不等于当前核心、接管或终端出口健康。

## 保留的自有网关实现与外部协作

本节的三路由域、固定 driver、协调器和 helper 描述旧自有方案的已实现边界，保留用于对照和后续已证实的缺口；不是当前原生网关的启动依赖，也不作为继续扩建的任务清单。

首轮只交付 IPv4 TCP/UDP 和真实地址 DNS；TUN 为优先验证方向。在共享主机上先验证范围明确的入口、来源路由与出口策略，保护管理和原有构建任务。核心原始接管、核心新建出站与返回终端的响应分别验证。未接管流量不能使主机退化成普通旁路转发器。同 LAN 回程不能默认成立，若无法满足连接跟踪和隔离要求，再评估独立三层链路。

[网络资源契约](../packages/network/README.md) 将单终端输入、固定资源归属、mark 保留位、三张带黑洞默认的路由表、受限 DNS、经路由器的出口／回程、持久 guard 和故障阻断编成确定摘要计划。[固定规则渲染器](../packages/network/rules.md)生成 nft 批次与 ip 参数，按 blocked、core-only、active 阶段推进。先阻断，再准备资源，再核验核心身份并仅开放核心探针，最后依据同代 TUN、实际 DNS、cgroup 与路由证据激活；不能按共享服务 UID 放行核心出口。隔离测试已证明转发语义，但尚未挂接持久事务或管理入口；计划中的接管与真实终端路径仍为未验证。

[持久网络协调器](../packages/network/transaction.md)另实现 revision CAS、逐操作持久 fence、证据绑定与启动门闩。历史 ready 不能免除恢复：新实例先确认旧操作收敛、重申阻断，再等待显式应用。未知驱动异常不会触发并行恢复。[固定生产驱动组合](../packages/network/driver.md)已连接原生资源、核心监管和完整运行观察，生产入口没有替身注入；特权服务仍须提供认证入口、部署及唯一 authority。组合测试使用 fixture，不代表实际服务已部署。[cgroup observer](../packages/network/identity.md)只补充固定路径与成员身份，不证明 binary/unit、socket 历史来源或整个网关就绪。

[原生资源会话](../packages/network/native.md)通过受限命令执行固定 nft/ip 操作，核对成功提交 echo、完整 AST／handle 与每步 RPDB／路由状态。持久模式将工具／namespace 身份、规则基准、清单和 pending 意图保存于私有资源凭据，使用跨进程锁和 revision CAS；工具取得持久启动 ACK 后才执行。重启先核验旧进程组与实际资源，只恢复到 blocked，拒绝从历史 ready 直接授权；丢失 echo 的未知变化及跨 boot／namespace 迁移仍安全拒绝。驱动已连接协调器和唯一核心监管者，但实际系统服务下的组合恢复尚待验收。[DNS/TUN 探针](../packages/network/probe.md)另从真实 FD、接口与 UDP/TCP 查询取得局部事实，不推导整条终端路径。

[网关核心监管入口](../packages/network/runtime.md)另使用完整重编译的私有网关候选、root-owned 选择与操作 journal、固定 systemctl 的启动屏障，以及独立 manager job/PID/cgroup 收敛核验。其独立 unit 通过 systemd credential 向非 root 核心传递配置快照，关闭自动重启，要求每次 stop/start 前证明 blocked。旧 worker 收敛入口不发新 stop/start，供协调器在持久 settling 后调用。[详细运行观察](../packages/network/core-observer.md)补充实际 executable、精确 argv、核心 mount view 中的 credential 代次与认证 controller 监听归属。监管组件已通过 fixture 持久协议测试和实际 unit 语法解析，观察组件已通过合成 reader 验证；尚未安装服务，不能据此授权生产转发。

[socket 来源观察](../packages/network/sockets.md)通过 INET_DIAG 将核心/管理 FD 与实际 socket mark、UID、cgroup ID 交叉核对，并要求两个专用 UID 无额外进程；缺失属性、未知 FD 和未连接 UDP 都不能补造成就绪事实。[链路观察](../packages/network/link.md)另核对接口、网关地址、carrier、当前邻居及带 mark 的出口路由。[运行证据组合器](../packages/network/observer.md)已将核心、cgroup、socket、DNS/TUN、链路与资源回读连接起来，并在前后重新核验核心及管理身份；计划、规则和协调器共同绑定独立管理 UID，生产启用拒绝历史缺省身份。四角色隔离测试已读取真实核心 socket mark/cgroup 与真实 iproute2 输出；该环境复用既有 UID/cgroup，只证明局部内核事实。[主机预检](../packages/network/host.md)另只读验证可信初始主机视图、转发参数及旁路机制；完整正向目前来自合成 reader。资源会话已支持 blocked 下同保护参数的代次重绑定，协调器恢复先持久记录 settling 再显式收敛旧操作。固定生产驱动已连接这些组件与唯一核心监管者；[运行监测](../packages/network/watchdog.md)已提供串行周期检查和停止恢复，管理入口、实际服务失效绑定及关闭生命周期仍待完成。

协同路由器负责受管来源、外部代理开关、基础网络和独立关闭恢复；可由原厂固件、可选 AlwayRoute 或其他组件实现。Coproxy 独立安装、认证和运行，负责收到流量后的接管、DNS、分流与自身状态，不写路由器配置，也不依赖路由器的 RPC、账户或某个包名。当前角色、来源/MAC及回程契约见[协同路由器要求与说明](cooperating-router-requirements.md)；其他路由器须按能力映射及实测，不把开发组合当作固定前提。

本地域名由路由器处理，受管公网解析交给受限 Coproxy DNS；bootstrap 不经过同一转发循环。单终端阶段不能替换所有终端共用的解析路径。加密 DNS、来源丢失后的设备策略和未支持地址族单独声明能力。

按[首轮协作语义 v1](router-cooperation.md)，开启后的核心、DNS 或链路故障采用受管外网阻断，保留开启意图，用户关闭后恢复直连，不自动降级。可选 AlwayRoute 适配器的日常应用使用有界的新鲜 DNS 预检，旧 operator 观察入口仍保留；它的 revision/job/观测字段不属于 Coproxy 必需协议。当前适配器重启先恢复阻断，再显式应用；其他实现也须声明并验证其启动和故障行为。核心就绪与终端路径验收分别报告。
