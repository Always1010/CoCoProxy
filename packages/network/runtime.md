# 网关核心的持久监管入口

`GatewayCoreRuntime` 是独立于显式代理 runtime 的核心生命周期组件。它使用[严格网关候选](candidate.md)、[固定 unit 计划](runtime-plan.md)和[持久命令屏障](fenced-command.md)，由[固定驱动组合](driver.md)在协调器的外层网络锁内调用。管理服务、CLI 和特权 helper 入口尚待接入；该组件不单独证明网关就绪。

生产入口为 `GatewayCoreRuntime.production({ runtime, coreHome })`。`runtime` 是固定计划生成的 `RuntimeSettings`，其完整字段与 unit 摘要必须等于重新生成的结果；不能用另一份 unit 的 hash 随意启用此 profile。入口要求 Linux root。实际操作还核验与 PID 1 相同的 user/net namespace、root 所有且不可被其他身份写入的二进制／控制工具／unit 与全部祖先、root 私有 state、服务 UID 私有独立 coreHome、固定核心 SHA、unit 的加载文件／用户／drop-in／reload 状态，以及固定 ControlGroup。目录和文件均须由部署流程预先准备，本组件不安装、修复权限或创建账户。

fixture 工厂要求显式提供全部七项可信依赖，缺失、额外字段、getter、Proxy、null 或 undefined 均拒绝，不能退回 production backend。fixture 实例和其 journal 固定为 fixture 来源。该入口只服务测试，不接受浏览器 JSON。

## 运行顺序

- `preflight(plan)` 是只读检查：核验部署、unit、journal 和完整候选，不创建存储，不 stop/start。
- `assertSettled()` 是只读收敛检查：pending worker 必须已不存在或整个进程组已结束，且 systemd `Job` 已清。它不 kill worker、不取消 job、不清除 pending，也不把运行中的核心当作 ready。
- `preflightSettlement()` 是不依赖候选文件的只读恢复预检：核验部署、unit、journal 和旧命令的 receipt/result 绑定。已验证的 running worker 可以进入后续显式收敛，不确定或无身份的 worker 仍拒绝。没有 pending 却出现 manager job 时拒绝；它不等待 job 或发出信号。
- `settlePending()` 由协调器在唯一外层网络锁内、持久保存 settling 屏障之后调用。它先只读校验旧 journal 与 receipt 的 token、固定命令摘要、boot/namespace/UID 和 result worker，只有已绑定的 running worker 才允许终止；终止后重新核验同一 worker，并独立给予旧 systemd job 最多约一秒的自然完成窗口。它不需要 blocked 证明，不发新的 stop/start，不取消 manager job，不清 pending、不推进 revision，也不初始化缺失的 journal 或存储。它使用现存 runtime 存储锁，缺失锁所依赖的 candidates 目录时拒绝。
- `ensure(plan, assertBlocked)` 校验候选与实际核心语法，取得可信 blocked 证明，收敛旧工具操作，再 stop 固定 unit。只有 stop 的成功回执、无 job、MainPID 为零、unit 已 inactive/failed 且 cgroup 无成员均确认后，才写入新的 canonical `selected-core.json`。持久保存选中代次后再次证明 blocked，最后启动同一固定 unit。
- `recoverStopped(assertBlocked)` 是显式恢复变更。它先证明 blocked，确认旧 worker 已收敛，再停止固定 unit 并确认 manager 与 cgroup 已收敛；它从不启动核心或自动恢复旧 ready。
- `inspect()` 只返回 scope、选中代次、pending、PID、job、ControlGroup 与 `readiness: unknown`。它核验选中文件摘要，但不代替进程二进制／启动时间、credential 实际快照、socket、DNS、TUN 或终端路径观察。

`assertBlocked` 是内部可信代码回调，必须在唯一外层网络写锁内独立读取实际资源并证明阻断。它不是布尔字段或外部请求提供的执行钩子。每次 stop/start 的 pending 已落盘后、调用工具前还会再次执行此证明；证明失败不发出核心命令。组件自己的 `FileTransactionStore` 锁只保护这一 runtime authority，不能替代协调器锁，两个锁的目录必须不同，锁顺序固定为外层网络 authority → runtime。

## 持久操作与配置传递

root-owned 私有 `gateway-core-state.json` 保存 schema、scope、revision、完整运行设置摘要、选中代次及待确认 action/token/command SHA/boot/namespace/UID。所有实际工具变更之前先原子写入 pending 并同步文件、rename 与目录；固定工具取得其启动 ACK 后才执行。只有匹配 token、digest、context 和 worker 的成功 result，以及独立 manager 状态检查均成功后，才清除 pending。

命令固定为 `/usr/bin/systemctl --no-ask-password --no-pager start|stop coproxy-mihomo.service`，无 shell、不接收额外 unit 或 action。工具超时 20 秒，合计输出最多 16 KiB。systemctl 客户端退出不代表 manager job 已收敛；失败、缺失结果、残留 job/PID/cgroup 和不确定 worker 均保留 pending，不自动并发重试。所有旧操作的信号都必须晚于只读来源校验；`ensure` 和 `recoverStopped` 也复用这一检查，并等待旧 job 自然结束。恢复只有在旧 worker 和 manager job 均已证明收敛后，才能用新的 stop 意图替代旧 pending；超出固定等待窗口仍保留旧 pending。命令回执留在私有 commands 目录，尚未实现自动回收策略。

核心不遍历 root state。systemd `LoadCredential` 在启动时读取 root-only `selected-core.json`，向非 root 核心提供独立只读快照；核心直接执行固定二进制与 `-d coreHome -f %d/core-config`。完整 canonical 配置超过 1,000,000 UTF-8 字节时，在语法校验、stop、选择文件和 start 之前拒绝，给 systemd 的累计 credential 上限留出余量。unit 不自动重启，也无自动启用的 Install 段，避免绕开每次新核心所需的阻断与授权流程。

读取不修复损坏 journal，拒绝单文件多硬链接、非私有文件、非规范内部 JSON 与错域 scope。写入或目录同步失败，包括 rename 可能已完成的情况，都不能被当作成功；下一次显式恢复重新读取实际状态。公共运行方法只抛固定 `NetworkDriverError`，未知错误保留 `childSettled: false`，不附带 secret、原始工具诊断或文件路径。仅有明确的只读输入／绑定拒绝可以表明该拒绝本身未发起 mutation。

## 验证范围

`test:network-runtime` 使用真实私有候选、journal、原子文件和跨实例文件锁，systemd 与 worker 则是明确的 fixture 模型。它验证持久顺序、旧 pending 保留、只读收敛、result 绑定、残留 PID/cgroup 拒绝、恢复只 stop、blocked 门槛、credential 大小、来源隔离、并发和错误脱敏。它不证明真实 systemd lifecycle 已安装或运行。

`test:network-runtime-plan` 另在已有 Linux `systemd-analyze` 可用时，实际解析普通及含空格／引号／反斜线／specifier 的路径；该检查只读解析临时 unit，不安装、不 reload、不启动服务。缺少工具时明确跳过，不能计为语法验证通过。

固定驱动组合已连接资源恢复、受信配置代次切换、详细进程与两个固定服务的 cgroup 身份、逐 socket mark／来源、本机链路和路由器邻居，以及 DNS/TUN 探针；组合测试仍使用 fixture。安装后的 systemd credential 快照与实际进程须独立验收，不能由本组件的已选代次推导成功。
