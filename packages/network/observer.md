# 网关身份与运行证据组合

`observeGatewayIdentity(plan, settings)` 与 `observeGatewayEvidence(plan, settings, expectedIdentity, options, nativeSession)` 为受信网络驱动组合已有的真实观察组件。它们不安装服务、不启动或停止核心、不改变网络，也不把已保存的 ready 状态当成事实。生产入口固定调用各模块的生产读取函数，不接受可替换 reader；明确的 fixture 入口才能传入合成依赖，结果始终为 fixture。

计划必须经过重新渲染并匹配完整摘要，且显式绑定与核心不同的管理 UID。`settings` 中的核心 runtime settings 来自受保护部署；管理 PID 必须由固定服务的独立 manager 查询或经过认证的本地 peer 身份取得，不能直接接受浏览器提交的 PID。后续驱动还须固定唯一部署、authority 目录及写入锁，不能让调用方选择另一个网络域。

身份组合按顺序执行：

1. 读取[实际核心运行事实](core-observer.md)，核验配置代次、plan、binary/unit、PID/start time 和核心 UID。
2. 使用同一 boot/PID/start time 与计划中的两个 UID 执行[cgroup 身份观察](identity.md)，核验两固定 ControlGroup、唯一成员和完整 kernel ID。
3. 用这些真实身份执行[逐 socket 来源检查](sockets.md)的 identity 阶段，核对 DNS listener、所有持有 socket 的实际 mark/cgroup/UID 和管理隔离；该阶段不要求已有上游连接。
4. 再次读取核心和 cgroup，要求核心与管理进程均没有重启或更换身份。

成功输出完整内部 `NetworkIdentity`，包含管理 PID/start time、UID、固定 ControlGroup 和 cgroup ID。它不是公共管理 API；不能把 PID、内核身份或完整部署返回浏览器。生产两个固定服务下的正向验收仍需独立部署后完成，合成 reader 的结果不能替代这一步。

完整证据组合先取得新身份并与预期身份比较，然后执行[真实 UDP/TCP DNS 与 TUN 检查](probe.md)、[链路与当前邻居检查](link.md)、socket ready 阶段和已拥有资源的独立读回，最后再次取得完整身份。ready socket 阶段另外要求实际存在合格上游端点；连接存在本身不替代 DNS 查询成功。生产资源读取只接受本模块的真实 `NativeNetworkSession`，要求 scope、generation、plan 和 core-only/active 阶段全部匹配，并由会话重新验证 nft/RPDB/路由及持久归属。

各观察都必须在本次调用开始后完成；scope、代次、plan、具体检查项、两种服务身份和时间必须一致。整个组合窗口最多 30 秒，输出时间采用最早的必要证据时间，避免最后一次成功读取掩盖前面事实已过期。任何来源缺失、失败、混代、管理进程更换或时间异常都拒绝，不能用其他观察的成功补齐。

核心、链路、socket 和 DNS/TUN 观察的 `commandsSettled` 必须明确为 true。明确未收敛或缺失该字段时抛出脱敏 `NetworkDriverError(false)`，驱动不得并发发出恢复变更；普通检查失败且读取已收敛时抛出 `NetworkDriverError(true)`。未分类依赖异常同样保留未收敛 fence，没有异常原文或嵌套 cause。资源读取的 `NetworkCommandError` 保留其收敛分类；固定只读资源读回中的 `NetworkReadbackError` 和 `NETWORK_RESOURCE_MEMBERSHIP_CHANGED` 仅在查询已经返回后产生，因此作为已收敛的证据失败，允许驱动走显式阻断恢复。会话失效、其他原生错误和未知异常不采用此例外。

这个组件连接了观察来源，尚不等于完整生产 `NetworkDriver`。全局主机预检、核心/网络唯一监管、跨配置代次资源迁移、未知操作的显式收敛阶段、故障监测与阻断、关闭接管及管理入口仍须集成。两轮观察也不是原子快照，驱动在真正 authorize/activate 前必须于独占 fence 内重新使用这些检查，并核验即将修改的资源；公开状态继续不能推导真实终端路径已经验收。

针对性命令：`node --experimental-strip-types --test tests/network-observer.test.ts`。测试覆盖完整来源组合、固定 fixture scope、核心/管理重启、证据混代、缺失检查、资源阶段不符、过期窗口和未收敛错误传播。没有默认或自动选择的模拟成功 backend。
