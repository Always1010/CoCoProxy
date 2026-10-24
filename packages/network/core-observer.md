# 网关核心的只读运行事实

`observeGatewayCore(settings, deployment)` 面向受信 `NetworkDriver`，读取固定 `coproxy-mihomo.service` 的实际运行事实。它不启动或停止服务、不修改网络、不安装软件、不保存就绪状态。生产入口仅允许 Linux root；配置和完整 deployment 来自受保护部署资料，不是浏览器输入。

成功返回 `scope: production`、`verified: true`、毫秒 `checkedAt` 及 `facts`，绑定配置 generation、完整 plan SHA-256、boot ID、PID/start time、服务 UID、实际核心 binary SHA-256、unit SHA-256 和精确 `/system.slice/coproxy-mihomo.service`。任何失败均返回 `verified: false`、`facts: null` 和固定 `NETWORK_CORE_UNVERIFIED`，没有原始命令、凭据、配置、路径诊断或嵌套异常。

结果还包含脱敏的 `commandsSettled`。默认及正常检查失败时为 `true`；只有固定命令传输抛出 `NetworkCommandError` 且 `childSettled: false` 时为 `false`。此时读工具可能仍存活，驱动不得并行执行恢复写入。该字段只说明读命令是否收敛，不改变 `verified` 或 scope，也不暴露异常内容。

观察重新生成受审阅的 gateway runtime plan，核验 runtime settings、独立 core home 与 unit 摘要。通过固定、root 控制且祖先不可写的 `/usr/bin/systemctl` 只读查询完整单位状态与 ControlGroup，要求 loaded/active/running、无 job、无 drop-in、无需 daemon reload、精确数字 User、单位文件路径和 ControlGroup。生产另外复用 `assertManagedUnit` 的实际单位文件摘要核验及 `verifyBinary` 的流式二进制摘要核验；所有路径祖先、文件类型、权限、硬链接和实际运行 executable inode/字节均独立检查。

核心的四类 UID 必须全部匹配。观察者与核心的 user/net/pid/cgroup namespace 必须与 PID 1 一致；观察者 mount namespace 也必须与 PID 1 一致，服务允许因 systemd 沙箱拥有独立 mount namespace。检查真实 procfs magic、完整 proc 根挂载以及所读取路径没有被其他挂载覆盖。PID start time、进程状态、cgroup 成员路径和精确完整命令行均须匹配，命令行只接受受信 binary、`-d` 独立 core home、`-f` 固定 systemd credential 路径。

配置证明来自核心实际 mount view：读取 `/proc/<verified-pid>/root/run/credentials/coproxy-mihomo.service/core-config`，要求 regular file、单硬链接、无写权限、有界 canonical JSON，完整内容摘要等于 generation。root 侧 `selected-core.json` 相符不能替代这份证明；核心可能仍持有上一代 systemd credential。`loadGatewayCandidate` 另行从受保护候选存储重新验证完整候选和计划，提供受信的 controller 端口与认证 secret。

controller 必须是唯一的精确 `127.0.0.1` IPv4 TCP listener，拒绝同端口 wildcard、其他地址或 IPv6 listener。其 socket inode 必须存在于该核心的 FD 集合中，然后向固定回环 `/version` 发起一次带认证的有界 HTTP 请求。没有代理、重定向、系统 resolver 或外部地址请求。整个观察前后重新核验单位、进程、namespace、binary、实际 credential 和 controller socket，任一变化、时钟倒退或超过五秒均丢弃证据。

这是受信主机上的两轮竞态检测，不是原子内核快照。它不证明 socket 创建 cgroup、socket/FD 历史转交、同 UID ptrace 隔离、管理单元身份、socket mark、DNS/TUN、物理链路/邻居或客户端终端路径。它不输出 `socketCgroupIsolationVerified`，也不生成完整 `NetworkIdentity`；驱动必须组合独立的 cgroup/socket 观察，并在实际授权边界重新核验。`terminalPath` 永远为 `unverified`。

`observeGatewayCoreFixture(settings, deployment, reader)` 接受明确的合成 reader，结果始终为 `scope: fixture`，缺失或损坏 reader 不会选择生产 backend。永久测试验证实际 credential 与 root selection 的区别、单位/进程/namespace/运行 executable/监听归属污染，以及查询中途身份更换和五秒窗口。fixture 成功不能充当真实固定 unit 的生产正向验收；该验收需要独立授权安装并核验服务，本轮未执行。
