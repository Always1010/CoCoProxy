# 持久网络事务与恢复

`NetworkCoordinator` 将单终端网络计划与持久启用意图串联，要求显式提供受信的 `NetworkDriver`。模块没有默认替身，也没有自动选择的 native backend；它目前没有被 CLI、管理入口或 systemd 接入。测试 driver 只证明状态机，不是生产网络执行者。

生产驱动尚须实现真实资源归属、nft/ip 读回、固定 systemd 核心操作及完整就绪探针。仅实现本协调器不能宣称特权服务已安装或网关已经接管。四角色内核测试验证的是正式配置与规则，尚未通过本协调器执行。

## 持久与唯一写入边界

构造函数为 `new NetworkCoordinator(privateRoot, trustedDriver)`。生产 helper 必须固定唯一 root，位于 root 控制的可信祖先下，禁止浏览器、管理请求或普通服务 UID 选择它。目录为 0700，`network-state.json` 为 0600，包含完整网络部署输入，应留在私有区域。公共 status 只返回代次、revision、历史阶段及固定错误，不返回拓扑、PID、cgroup ID、路径或原始诊断。

协调器复用 `FileTransactionStore.exclusive` 的跨进程锁、boot ID/PID start time 死亡核验和私有原子写入。该目录的 `candidates/` 保留给后续核心与网络集成。不同 root 的锁相互独立，不能让多个 helper 以不同 root 管理同一网络域。真实核心配置事务、唯一 systemd 监管者与网络事务还须在服务端形成统一写入纪律；不能从两个入口并发切换同一核心。

原子写入依次同步文件、rename、同步目录。写入或同步失败都不返回成功，因为 rename 可能已经完成。锁目录创建后、owner 文件完成前的崩溃，可能留下无法自动回收的无 owner 锁；此时安全拒绝，不能声称任意掉电都能自动恢复。修复需要核验实际操作者与资源状态，不自动猜测或删除未知锁。

## 应用阶段

`apply(deploymentInput, expectedRevision)` 重新校验并冻结完整计划，不接受调用方提供的任意规则或操作数组。revision 使用 CAS；新实例发现已有 journal 时必须先 `recover()`。成功恢复或本实例成功应用后，门闩只对该 revision 有效，其他进程更改 journal 后必须重新恢复。锁释放或同步失败会清除此门闩。

执行顺序为：

1. 只读预检成功后，先持久保存启用意图。初次预检失败没有启用记录，也不变更网络。
2. 原子安装并读回 blocked guard，之后才能准备三表黑洞、策略规则、经路由器的出口／回程和非激活分类。
3. 由唯一安装的 systemd 监管者选择、启动本代核心，独立核验 binary、unit、PID、UID、启动时间和 cgroup。只开放 core-only 探针，客户端仍阻断。
4. 取得同一身份的精确 DNS socket、实际 UDP/TCP DNS 查询、TUN、链路／邻居、出口 mark 和已有资源读回证据。
5. 再次核验核心身份和全部证据，增加 capture 并原子激活规则；之后再次取得实际读回及探针证据，才能保存 ready。

每次驱动变更之前先持久写 `unsettled: true` fence，驱动成功且收敛后才清除。驱动所有方法必须有界；成功的变更必须已经完成内核读回，不能仅启动后台任务就返回。协调器不使用会放任旧操作继续写入的 Promise timeout。

启用后禁止静默切换接口、终端、MAC、服务 UID、监听、mark、表号、优先级或 TUN 等保护范围，只允许同一范围的 generation 与核心 binary/unit 摘要更新。改变保护范围需要另行实现经过审阅的生命周期，不能用替换 guard 的方式先释放旧终端。

## 证据与来源

驱动身份须绑定 generation、完整 plan SHA-256、boot ID、PID、PID start time、固定核心 ControlGroup、当前完整 cgroup kernel ID、服务 UID 和核心 binary/unit 摘要，且明确完成进程/unit 与逐 socket cgroup 隔离核验。[cgroup observer](identity.md)只提供其中的 cgroup 补充证明，不能单独填满全部条件。

生产 `apply` 强制 deployment 显式提供与核心不同的 `management.serviceUid`，在任何存储初始化或驱动调用前拒绝缺省的历史计划。绑定独立管理身份的计划还强制 `NetworkIdentity.management` 包含管理 PID/start time、计划 UID、固定管理 ControlGroup 和与核心不同的完整 cgroup ID。管理进程身份在探针前后及激活边界同样不得改变；管理 UID 属于不可静默修改的保护范围。历史共享 UID 计划只保留解析、fixture 及阻断恢复兼容，不能用来执行新的生产启用。

`NetworkEvidence` 还须逐项证明 DNS socket 所有权、真实 UDP/TCP DNS 查询、TUN 所有权、链路／邻居、socket 出口 mark 及拥有资源读回。协调器拒绝未知或缺失字段、accessor、Proxy、假值、错误身份、不同 scope、未来时间和超过 30 秒的证据。证据不会保存成下一次的许可；系统时钟后退也拒绝推进。

协调器校验证据之后还需要同步 mutation fence。因此 native `authorizeCore`、`activate` 和实际探针必须在使用时自行重核当前身份、鲜度与事实，不能省略为“上层刚刚查过”。内核资源状态本身由驱动证明，不能把这些接口中的 true 字段暴露为浏览器可提交的授权。

`scope` 在构造时固定，fixture 驱动及 journal 始终保留 fixture 来源，不能转成 production 使用。该标签是受信代码间的来源约束，不是对恶意进程内 JavaScript 的防护。`status()` 的 readiness 永远为 unknown 或 fault；只有本次完整应用返回短期 localReady 观察，且 `terminalPath` 仍为 unverified，不推导真实终端验收。

## 失败与启动恢复

已启用后的失败不恢复旧 active 或自动 DIRECT。只在确认先前操作已经收敛时，先重申并读回 blocked guard，再保留黑洞、撤回 capture／分类、读回阻断，持久保留启用意图。中途存储失败仍会在已知操作收敛的前提下尝试此阻断过程，且不会返回应用成功。

驱动仅能用 `NetworkDriverError(true)` 或已收敛的 `NetworkCommandError` 声明失败操作已终止。未知驱动异常、`childSettled: false` 都进入 unsettled fault，不并发发出恢复变更。驱动的只读观察调用同样参与异常分类，防止遗漏仍运行的工具。驱动不得吞掉底层未收敛异常再伪装成正常失败。

`recover()` 对所有已有启用意图执行恢复，包括历史 ready、blocked 和中断阶段，在同一跨进程唯一锁内依次执行：

1. `preflight(plan, 'settle')` 只读核验平台、可信操作回执及其归属、上下文和固定命令绑定。允许此前已绑定的 pending worker／manager 操作仍运行；不能为通过检查而 kill、修复回执或修改资源。此时实际资源可能仍在变化，因此不能把旧资源快照当作已收敛后的完整预检。
2. 先持久保存 `phase: settling` 与 `unsettled: true`，再显式调用必须实现的 `settlePending(plan)`。该方法必须自行重验可信来源，只能有界地终止或等待此前回执已经绑定的 worker／manager 操作，不能接收任意待 kill PID、启动新的业务操作、放行网络或修复网络资源。没有可信绑定时安全拒绝，不能猜测进程归属。
3. `assertSettled(plan)` 独立只读证明先前工具／systemd job／netlink 操作全部收敛，再执行 `preflight(plan, 'recover')` 完整只读资源预检。`settlePending` 成功返回本身不会清除持久 fence；缺少后续证明仍保持未收敛故障。
4. 完成上述证明后，重申并读回 blocked guard，再保留黑洞、撤回 capture／分类并读回阻断；每次实际变更继续先持久保存自己的 fence。

无论保存的 unsettled 标志为何，都必须经过这套显式恢复顺序。保存的 false 不能排除进程在记录异常前死亡，历史 `settling` 也只代表需要重新恢复。未知异常或 `childSettled: false` 立即保留未收敛故障，不在其后并发执行 contain；只有用户再次显式 `recover()` 才能尝试收敛已绑定的 pending。在 `assertSettled` 独立证明成功之前，任何调用失败即使带 `childSettled: true`，也仅证明该失败调用自身已结束，不能替代对更早操作的完整收敛证明，不能沿用保存的 false。驱动须保存或取得足够的可信事实，接口本身没有提供这份生产证明。

恢复仅返回阻断，绝不自动续做激活；重新启用需要显式 apply、新 revision 和新鲜证据。没有 journal 的新目录，status/recover 都不创建文件。损坏或跨 scope 的 journal 拒绝使用，不据此猜测网络资源。手动关闭与解除接管是独立的授权生命周期，本模块尚未提供卸载或恢复直连入口。

## 针对性验证

`npm run test:network-transaction` 使用明确 fixture driver 检查顺序、持久 fence、CAS、启动门闩、保护范围、证据失效、身份更换、异常收敛与 scope。Linux 非 root 子项实际通过目录权限模拟 ready 写入失败，另在独立进程的变更中途强制终止，验证文件锁与恢复记录；这些是真实文件/进程语义，不涉及真实网络或 systemd。固定内核资源驱动及服务集成仍需后续验证。
