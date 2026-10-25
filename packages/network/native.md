# 受限原生网络资源会话

`NativeNetworkSession` 已实际调用固定 nft/ip 工具，执行本模块的 guard、三表黑洞、策略规则、经路由器的出口／回程、core-only 授权和 capture 激活，并独立回读内核状态。它是供未来特权 `NetworkDriver` 组合的资源执行组件，不是完整的生产执行服务。当前没有被 CLI、管理服务或 systemd 自动调用。

## 固定调用与来源

`create(deployment, tools, directory?)` 只接受重新校验的网络部署输入及固定允许的系统工具路径。提供由特权服务固定选择的私有 directory 后启用持久模式；省略时仍是原有进程内会话，不能用于生产恢复。生产入口要求 Linux root，user/net namespace 与 PID 1 相同。工具解析至固定 `/usr/bin` 或 `/usr/sbin` 下的 ip/nft，文件及全部祖先必须由 root 所有、不可被组或其他用户写入、类型正确且不经过替代符号链接。该条件不单独证明当前执行环境就是部署目标主机；特权入口还须核验受信部署、mount 视图和工具版本。

显式 `fixture(...)` 入口要求当前 user 和 network namespace 均不同于外层证据，必须提供受限测试 cgroup，输出固定 fixture 来源。它仅额外允许系统工具在新 user namespace 中显示的未映射 root UID 65534，其他类型、路径与权限约束不变；不能用它创建 production 观察。

首次会话只接受本模块 nft 表、三个 RPDB 规则及专用路由都不存在的初始状态，不接受外部 JSON receipt，不按同名或同配置认领已有资源。后续持久会话只读取同一私有 authority directory 的受保护凭据，并先要求显式恢复。v1 [回读校验](readback.md)要求无其他 nft 对象、无额外 RPDB 或自定义路由表；不满足时拒绝，不能清理发行版防火墙、容器网络或其他服务来通过预检。

## 严格只读入口

`preflight(deployment, tools, directory?, purpose = 'apply')` 与 `assertSettled(deployment, tools, directory?)` 可供持久协调器在任何初始化或修改之前调用。两者沿用生产 root、PID 1 user/net namespace、受信工具及资源凭据上下文校验，只读取既有凭据，不调用 `create()`、不获取会创建目录的资源锁，不创建 authority、commands 或 receipt，不推进 revision，不终止旧 pending worker，也不调用恢复。只读 nft/ip 查询沿用有界传输；查询超时只收敛本次查询自己的子进程组。

`preflight()` 对无 receipt 的 authority 要求实际 nft、RPDB 及专用路由全部 absent；目录不存在仍保持不存在。已有 receipt 必须绑定当前 boot、namespace、工具二进制及旧计划重新渲染的 renderer。目标计划可属于同保护范围的新代次：旧、新输入均完整校验，仅忽略 generation、core.binarySha256 和 core.unitSha256，UID、cgroup、接口、地址、MAC、端口、mark、策略规则及路由均不能改变。旧 receipt 的上下文、pending 固定命令及实际内核始终使用其自身旧 deployment 重建，不能用新计划伪造旧 renderer。通常用独立内核列表核验具体归属，不能把历史 state 当成实际资源。pending 的命令必须由固定 renderer 重建且摘要相同；只观察其启动回执、结果与进程组，apply/recover 对 running 或 uncertain 均拒绝。已收敛的 pending 只允许匹配旧归属或准确的单步后归属；成功 nft echo 只允许匹配提交后的 AST 与 handle。没有可信 echo 而实际 nft 已变化时拒绝。所有候选仅用于当前核验，绝不采纳或保存。

`purpose: 'recover'` 仅额外容许先前已拥有的 capture 路由精确消失，以便之后显式进入 blocked 恢复；其余归属仍须完整匹配。该观察本身不会撤回 capture、安装 blocked 或生成运行授权。`assertSettled()` 独立核验当前 receipt 的 pending 固定命令摘要、worker boot、UID、user/net namespace 与整个进程组均已消失，不依赖历史的完成布尔值，也不要求此时内核仍匹配旧 state；无 receipt 时仍确认资源 absent。命令启动屏障确认 pending 无启动回执且无孤立结果时，也能只读证明该命令尚未获得执行许可。

`purpose: 'settle'` 只校验旧 receipt、执行上下文、固定 pending 命令及 worker 来源，允许已通过身份核验的 worker 仍运行；此时旧命令可能正在改变内核，不能提前要求实际资源等于旧 state 或单步后 state。无 receipt 时仍确认所有资源 absent。它不会发送信号、获得资源锁或写入凭据。

`preflightFixture(deployment, tools, proof, directory?, purpose?)` 与 `assertSettledFixture(deployment, tools, proof, directory?)` 使用与 `fixture()` 相同的外层 user/net namespace 和受限 cgroup 证据，始终只产生 fixture scope；缺失或无效 proof 不能退回 production。预检只返回冻结的 scope、initialized、recoveryRequired、pending、revision、generation、planSha256、binding 与 `terminalPath: unverified`，不返回工具输出、原始 AST 或私有路径。generation 和 planSha256 始终描述目标；binding 为 absent、current 或 previous-generation，分别表示无 receipt、摘要已匹配目标、仍绑定同保护范围的旧计划。`initialized` 表示已经存在资源 receipt，`recoveryRequired` 表示以该 receipt 新建持久会话后必须显式恢复，不代表长期运行中的驱动会话需要重建。

读取末尾再次核对完整 receipt 与上下文，可发现观察过程中发生的版本或域变化；它不预留未来的内核状态。外层生产驱动仍须持有统一的写入 fence，并在实际修改前重新校验，保证没有另一写入者在预检返回后启动命令。pending 已完成不代表完成 blocked 恢复，`assertSettled()` 也不证明 systemd 管理操作已收敛；后者由组合驱动的独立管理回执证明。

命令通过[有界传输](command.md)直接执行，无 shell。所有 nft 批次和 ip 参数均重新来自固定 renderer，不能提交任意命令。`plan` 在构造时深度冻结；模式、规则基准和资源清单由会话维护，不接受调用方覆盖。

## 显式收敛与代次重绑定

`settlePending(deployment, tools, directory)` 与 `settlePendingFixture(deployment, tools, proof, directory)` 是允许终止旧 worker 的独立 mutation 边界。调用方须先把统一协调器的 settling/unsettled fence 持久化；入口在资源锁内重新核验旧 receipt、上下文、固定命令摘要和 worker 身份，再通过启动屏障收敛该 worker。uncertain 的身份不会触发盲目信号，不能证明进程组收敛时拒绝。它不修改网络、不清 pending、不推进资源 revision；无 receipt 时只读确认 absent 后返回，authority 保持未初始化。随后仍须执行 `assertSettled()`、完整 recover 预检和 blocked 恢复，不能从进程已退出推导网络已恢复。

`openForUpdate(targetDeployment, tools, directory)` 与 `openForUpdateFixture(targetDeployment, tools, proof, directory)` 是持久会话明确的新初始化边界。无 receipt 时按目标进行严格 create；已有 receipt 时仅接受同保护范围的目标，在锁内用 receipt 自带的旧 deployment 完整重渲染并精确核验旧上下文，打开的 `session.plan` 仍是旧计划，且必须显式 `recoverBlocked()`。原 `create()`/`fixture()` 继续要求完整上下文及计划摘要精确相同，不能通过同名资源、同 UID 或目标代次自动认领旧资源。

`session.rebind(targetDeployment)` 仅允许已恢复的持久会话处于 blocked、无 capture、无 pending。它在同一资源独占锁内重新核验旧 receipt revision、完整旧上下文及实际内核归属，旧、新计划均完整渲染，并比较所有模式下的实际 nft 批次、全部 IP 步骤与 cgroup 绑定完全一致。随后通过一次原子 journal 替换同时更新 deployment、planSHA、rendererSHA 与原 state，再切换会话的只读 plan。它不会发出网络修改命令、启动核心或赋予核心授权；新核心仍须经过独立身份及 socket 隔离核验后才能进入 core-only/active。提交失败使该实例失效；旧实例通过 revision CAS 拒绝后续操作。跨 boot、namespace、工具二进制或保护范围的变化均不属于此迁移。

## 实际提交与回读

每个阶段先用既有期望状态核验当前内核，才执行下一步。nft 先做语法 check，再提交同一个受限批次，要求完整成功 JSON echo，合成下一份期望 AST 后用独立 list 精确比较。期望不取自待认领的当前 ruleset；规则表达式、原始顺序、链定义和所有对象 handle 均匹配。

实际验证的 nft 1.0.9 存在两个兼容陷阱：`--json --file` 配合原生文本输入可能退出 0 而未提交，匿名 literal set 在 replace echo 中可能回显重复或错误类型的成员。执行器使用单个无换行命令 argv 调用 `nft -j -n -e <batch>`，限制 16 KiB，且固定 renderer 输出标量规则以避开匿名集合。不会从 list 修复坏 echo，也不会只看退出码判断成功。具体来源与校验见[回读说明](readback.md)。

每条 ip 操作完成后再次读取 RPDB 和路由。清单只记录本会话实际发出的精确规则和路由，持久模式于核验后保存；即使另一个操作者添加了与计划完全相同的条目，也不能因为 partial 语义匹配就认领。额外、缺失或变化的成员都会终止会话。nft handle 同样防止同名同内容删除重建后沿用旧基准。

阶段如下：

- `installBlocked()` 原子建立两个固定表的 blocked 规则；客户端和核心非 loopback 输出仍阻断。
- `prepare()` 依次准备三张黑洞默认、三个 RPDB 规则和四条出口／回程路由。TUN 尚未存在时只允许精确 return 规则的 `iif_detached: null`；active 时拒绝它。
- `authorizeCore()` 仅在 prepared 后切至 core-only。调用方必须在调用前独立核验当前核心身份和 socket 隔离；本资源组件不代为生成该证明。
- `activate()` 仅在 core-only 后增加 capture，再原子切至 active。调用方必须于实际使用前重新核验完整新鲜运行证据。
- `retainBlocked()` 先重申 blocked，再撤回精确 capture，保留或补齐三张黑洞，回读确认。它不删除 guard、清空外部表或恢复 DIRECT。
- `recoverBlocked()` 只用于新建的持久会话，先收敛旧命令、核验凭据及内核，再重申 blocked、撤回 capture、保留三表黑洞。不恢复历史 ready。
- `inspect()` 只返回当前独立回读、代次、摘要、模式及 `terminalPath: unverified`，不宣称终端已验收；待恢复的新会话拒绝普通操作。

会话拒绝并发方法。任何操作失败或读回不符都会使会话失效，禁止继续盲目写入。底层未收敛异常继续保留原来的 `NetworkCommandError.childSettled`，不能吞掉后触发并行恢复。

## 持久与运行边界

持久模式使用[资源凭据](resource-journal.md)的跨进程锁，每次操作在锁内比较 revision，拒绝已经过期的实例。同一网络域必须固定唯一 authority directory；不同目录的锁不能互相保护。凭据绑定 scope、boot、user/net namespace、工具规范路径与二进制 SHA-256、renderer 和计划摘要。每次操作重新核验绑定，变化时拒绝；计划代次迁移仅通过上述显式 blocked 重绑定入口执行，不支持跨 boot、namespace 或工具版本迁移。

每次 mutation 前，完整旧 state 与 pending token、固定操作和命令摘要一次持久保存，再通过[命令启动屏障](fenced-command.md)执行。工具成功和独立回读均核验后，提交新 state 并清除 pending。文件或目录同步失败也使会话失效。命令回执当前保留在私有 commands 子目录，不包含 stderr；实际工具输出不进入正式日志或发布包。

恢复先确认 pending worker 的整个进程组已收敛，并核对其身份、摘要与 namespace。nft 仅从成功的持久 echo 重建下一份期望，且须与实际 AST、handle 和 IP 成员精确匹配；没有可信 echo 却发生规则变化时拒绝恢复。IP pending 仅接受完整旧清单或该固定单步之后的完整清单，不能任意认领 partial 子集。已采纳的 state 与清 pending 原子保存，防止恢复再次崩溃后丢失归属。

唯一允许的缺失资源是先前拥有的 capture 路由：TUN 消失会由内核自动撤销它。恢复仍须核验其余所有资源，只在立即转入 blocked 的过程中接受该精确缺失；到 blocked 成功前保留最后的 capture 归属记录。未知额外规则、其他缺失项、未收敛进程或损坏凭据都不会触发盲目修改。缺失首次 create echo 的不确定状态也可能需要人工排障；本实现不承诺所有断电窗口都自动修复。

[固定驱动](driver.md)已在持久协调器下组合资源会话和核心生命周期；组合测试仍使用 fixture，完整生产服务未验收。本框架不在当前原生网关启动链路中。读取旧凭据、准备资源成功或恢复到 blocked 均不能替代运行事实。

接口、主机地址、sysctl、邻居、XDP/tc/eBPF、legacy iptables、其他 namespace 及 IPv6 整条路径不由本组件预检。源地址、TUN/DNS、出口 mark、两个服务 cgroup 隔离及真实终端路径也须由独立探针与服务边界证明。它不创建账户、安装单元或修改路由器。

## 已执行验证

`test:network-kernel` 在全新 user/network namespace 子树中，通过持久资源会话替代网关的手工初始 nft/ip 操作，并使用[实际 DNS/TUN 探针](probe.md)。四角色测试覆盖 blocked、prepared、core-only、active、退出后的 retain、规则污染和清单冲突拒绝；固定官方核心实际承载 HTTP、UDP 与 DNS。新增边界包括实际 ip/nft 执行完成但资源凭据仍 pending 后终止资源进程、重启恢复、过期实例拒绝、active 重启退回 blocked，以及核心退出和 capture 自动消失后恢复。pending 场景由可信 fixture 显式建立准确的持久中断点，不宣称测试了任意指令时刻的掉电。核心、TUN 和唯一节点故障还检查没有 DIRECT 回退。

fixture 复用既有真实 cgroup 并禁用管理例外，不证明生产两个固定服务的 cgroup 隔离。它没有通过持久协调器执行，不代表完整生产恢复、服务安装或真实设备联调已经完成。测试清理除原进程组外，也核对专用 user namespace 中的工具子进程，未清理完成时保留私有输入并失败。
