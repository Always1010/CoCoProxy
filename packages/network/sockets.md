# 逐 socket 来源与实际 mark 观察

`observeSocketSources(plan, binding, { stage })` 为受信网络驱动提供只读证据，不执行 socket 设置、网络修改或服务操作。生产入口需要 Linux root、PID 1 的 user/net namespace、真实 procfs，以及 root 控制且祖先不可写的 Python 3 和本模块。Python 是网关观察组件的运行依赖；固定调用 `/usr/bin/python3 -I -S`，只使用标准库，不通过 shell、pip 或第三方包。部署流程须显式预检该依赖，模块不会自动安装软件。

`binding` 来自独立的运行身份与 cgroup 观察，包含 boot ID、核心和管理进程各自的 PID/start time、UID 和完整十进制 cgroup kernel ID。两者必须使用不同的非 root UID、PID 和 cgroup，核心 UID 还须等于可信 plan。plan 显式包含 `management.serviceUid` 时，管理 UID 也必须匹配，错绑在诊断命令启动前拒绝；缺省时保留不同 UID 的要求。辅助读取前后扫描 procfs，要求每个专用 UID 只对应指定进程；四类进程 UID 均须匹配。任一进程共享 socket FD、出现未知 FD、额外同 UID 进程或身份变化，都拒绝授权。

固定 `socket-diag.py` 经 `NETLINK_SOCK_DIAG` 分别读取 IPv4/IPv6 的 TCP/UDP。它将 `/proc/<pid>/fd` 中实际持有的 socket inode 与 INET_DIAG 输出交叉匹配，同时读取内核 socket cookie、UID、mark、cgroup ID 和端点；不把配置中的 routing-mark 或进程当前 cgroup 复制成 socket 事实。非 INET socket 只允许经内核表明确分类的 UNIX/netlink；其他类型保持未知。诊断输入、proc 扫描、消息、结果、时间与 socket 数量都有界，截断、dump 中断、重复属性、错误消息和未分类项均失败。

Linux v6.1 的 [`inet_diag_msg_attrs_fill`](https://github.com/torvalds/linux/blob/v6.1/net/ipv4/inet_diag.c) 仅在具备相应 `CAP_NET_ADMIN` 时返回 `INET_DIAG_MARK`，并通过 `sock_cgroup_ptr` 返回 socket 创建所属的 cgroup ID。属性编号及格式见 [`inet_diag.h`](https://github.com/torvalds/linux/blob/v6.1/include/uapi/linux/inet_diag.h)。缺失 mark 或 cgroup ID 视为未知，尤其不能把没有权限读取 mark 当成零。完整 64 位 cookie/cgroup ID 用十进制字符串传递。该语义须与受支持内核、真实 cgroup2 层级和独立 cgroup 观察一起核验。

核心必须持有精确网关地址和 DNS 端口的一对 TCP LISTEN、UDP CLOSE listener；拒绝 wildcard 或缺失/重复监听。所有核心非 loopback INET socket 必须是 IPv4、来自核心 cgroup/UID，且实际 mark 的保留位等于 egress mark；不允许额外对外 TCP listener。核心 loopback socket 的保留位允许零或 egress。管理 socket 必须来自管理 cgroup/UID，保留位为零。此处不证明管理 unit 文件或可执行文件身份，须由其他组件补充。

`stage: identity` 可在尚无上游连接时完成来源检查。`stage: ready` 另外要求观察到至少一个非 DNS、非 loopback 的核心连接：TCP/UDP 状态为 ESTABLISHED、两端口非零，remote endpoint 为非零、非 loopback、非组播 IPv4。未连接的 UDP bind 和 TCP SYN pending 不计入。这个计数只证明当时存在连接端点，不证明节点可达、DNS 解析或业务请求成功；驱动仍需独立探针，不能只凭该字段宣告就绪。

观察读取两轮完整诊断，均须独立通过来源校验，并在五秒内保持 boot、namespace、进程、UID 占用和 DNS listener cookie 等关键事实一致。允许正常临时上游 socket 在两轮间替换；每轮内部的目标 FD 集合必须稳定。进程或 FD 高频变化时可保守返回未验证，不会以旧快照补齐新事实。两轮读取不是原子内核快照，也不记录 FD 的历史转交；核心、root 和受信部署仍属于信任边界，实际授权前需重新观察并保持网络写入独占。

公开结果仅含来源、阶段、代次/plan 摘要、观察时间、检查项与计数；失败固定为 `NETWORK_SOCKET_UNVERIFIED`。原始 socket 地址、PID、cookie、namespace 和路径均不进入公开结果。内部低层 fixture 读取仍包含敏感事实，不得映射为管理 API 或写入默认可提交输出。

公开结果另含脱敏的 `commandsSettled`，默认为 `true`；解析、文件读取或普通检查失败仍为 `true`。只有固定命令传输抛出 `NetworkCommandError` 且 `childSettled: false` 时为 `false`，表示诊断读工具可能仍存活，驱动不得并行执行恢复写入。该字段不改变 `verified`、固定失败原因或 fixture scope，不携带异常原文。

`observeSocketSourcesFixture` 仅接受明确可信的合成 reader，结果永远为 fixture。`readSocketDiagnosticsFixture` 只用于已独立核验的新 user/network namespace，要求提供不同于当前 namespace 的外层证明。四角色内核测试使用真实 Mihomo FD，核对实际 mark 和 socket cgroup ID；该 fixture 复用现有 UID/cgroup，因此只能证明低层内核读取，不能证明生产两个专用服务身份隔离。生产正向验收需要安装并核验固定服务后另行执行。

[固定驱动](driver.md)已组合本模块与其他观察组件，完整生产部署未验收。聚合观察要求计划绑定专用管理 UID，并由规则及部署共同保护；逐 socket 检查、核心身份、链路、DNS/TUN 和资源回读必须属于同一代，缺失必要证据时保持阻断。

针对性检查：`node --experimental-strip-types --test tests/network-sockets.test.ts`。实际内核读取与透明路径由开发说明中的 `test:network-kernel` 执行；合成测试成功不能替代真实服务或终端验收。
