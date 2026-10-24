# 固定网络规则渲染

`renderNetworkRules(input, { mode })` 每次重新调用 `renderNetworkPlan`，仅接受完整部署输入，不信任调用方传回的 plan。输出包含 `generation`、规范 plan 的 `planSha256`、`scope`、两个固定 nft 表的批次和独立 `ip` argv。渲染不读取本机状态，不执行命令，不证明已具备权限或内核能力。

发出的规则使用标量匹配。固定的 TCP/UDP 与正向地址集合展开为连续规则；负向目的集合变为同一条规则中两个 `!=` 的 AND，不能展开成任一地址不等即可通过的替代规则。此处理避开已实测的 nft 1.0.9 匿名 set 在 replace JSON echo 中出现重复／错误类型成员的问题，使提交回显可与独立内核 list 精确比较；不会从 list 反向修补期望规则。展开只处理本 renderer 内部的固定形式，不接受用户规则文本作为命令。

`nft.guard` 与 `nft.data` 分别含 `create`、`replace`。首次创建使用 `create`；执行器确认既有表、链、hook、priority 和所有权完全相符后使用 `replace`，后者仅清空三个固定链。执行器应将本次需要的批次拼接为一次 `nft -f -` 事务，先通过 `nft -c -f -` 验证。不能在失败后盲试另一批次，不能销毁未知表，也不能把表名相同当成所有权证明。

支持 `blocked`、`core-only` 和 `active` 三个阶段。`blocked` 不提供客户端转发、TUN 转发、LAN DNS 或共享核心 UID 非 loopback 输出例外。三个阶段均允许从 loopback 接口、127.0.0.1 源地址访问精确网关 IPv4 DNS TCP/UDP 端口，供 root helper 显式绑定 127.0.0.1 做真实本地 DNS 探针；该规则不开放 LAN DNS。`core-only` 仅在执行器已经核验核心 PID、binary、unit 和 cgroup 后使用，开放与 active 相同的精确核心输出及独立管理 cgroup 无保留 mark 例外，客户端转发、LAN DNS 和 capture/return 分类仍保持阻断。执行器取得真实 DNS/出口证据后才能进入 active。

`active` 对客户端只允许入口接口、路由器源 MAC、原始客户端 /32、TCP/UDP、capture 保留位和 TUN 出口同时匹配；TUN 回程只允许客户端 /32、return 保留位和指定物理出口。其余客户端源或 TUN 转发丢弃。到达本网关的路由器来源 IPv6 转发丢弃；客户端通过其他路径直出的 IPv6 仍须由路由器阻断。

每包仅对入口接口上的客户端源 /32，以及 TUN 上的客户端目的 /32 清除保留位后重新分类，不从 conntrack 恢复标记，保留其他 mark 位；同接口的其他业务不修改 mark。output 分类链为空，本地输出保留 socket 原始 mark。核心输出要求 socket 原始 cgroup、UID、既有 egress mark、IPv4 网关源地址、TCP/UDP 和指定物理出口全部匹配；缺失 SO_MARK 的核心 socket 不会由渲染规则补标。共享 UID 的管理服务仅能通过另一个固定 cgroup 的无保留 mark 例外访问正常网络；其他共享 UID 非 loopback 输出丢弃。`blocked` 故障期会同时暂时阻断该 UID 管理服务外连。

生产 cgroup 固定为 `/system.slice/coproxy-mihomo.service` 和 `/system.slice/coproxy-management.service`，`socket cgroupv2 level 2` 匹配对应层级。执行器必须真实核验 cgroup v2、内核身份、进程归属、不可委派及禁止共享 UID 迁移；祖先匹配本身不能证明没有额外进程或子 cgroup。不得退化为仅 UID 放行。规则语法参考 [nftables 官方手册的 socket 表达式及 route output hook](https://www.netfilter.org/projects/nftables/manpage.html)。内核不支持该表达式或无法证明归属时保持 blocked。

`fixtureCgroups: { core, management }` 仅供隔离内核测试中的真实进程 cgroup 路径，路径必须为受限绝对路径且不得相同或互为祖先。测试不能建立独立管理 cgroup 时可将 `management` 设为 `null`，完全省略管理外连例外，输出的 `cgroups.management` 也为 `null`。设置 fixture 参数后输出强制 `scope: 'fixture'`，即使填写生产路径也如此；生产执行器必须拒绝 fixture，生产配置 JSON 不接受该参数。

DNS 仅允许指定接口、路由器 MAC、客户端或路由器 /32 来源访问精确网关 IPv4 与 UDP/TCP 端口；UDP 入口还必须查得同一核心 socket cgroup，不能让意外占用端口的共享 UID 管理进程接收 LAN DNS。管理服务的独立外连例外仅允许 TCP/UDP，且源端口必须不同于 DNS 端口，防止管理 cgroup 将未标记 DNS 回复作为普通管理外连放行。其他到此端口的流量丢弃，也覆盖 IPv6 和错误地址上的监听暴露。精确监听与同核心 PID 归属仍需执行器验证。

仅 active 阶段为 Linux 6.1 的 TCP DNS 握手提供一个受限替代证明：该版本的 nft socket cgroup 查询不能将 SYNACK 的 request_sock 转换为完整 socket，因此正常 cgroup 输出规则可能无法匹配握手应答。对应实现见 Linux v6.1 的 [nft_socket.c](https://github.com/torvalds/linux/blob/v6.1/net/netfilter/nft_socket.c)；[nft_meta.c](https://github.com/torvalds/linux/blob/v6.1/net/netfilter/nft_meta.c) 的 skuid 查询采用不同的完整 socket 查找。入口仅对上述精确 LAN DNS tuple、original 方向和初始 SYN，在 socket cgroup 证明属于已核验核心监听器时，将 CT mark 的保留位替换为 egress，其他 CT 位保留；再次出现初始 SYN 必须重新证明监听器，不能复用旧 CT 标签绕过。之后 original 方向的同一 DNS tuple 可凭该标签接收 TCP 握手及数据。

输出替代规则仅允许服务 UID、已有 SO_MARK egress、CT egress 保留位、reply 方向、网关 IPv4 源、客户端或路由器 /32 目的、DNS TCP 源端口、指定物理出口以及严格 SYNACK flags 同时满足的握手应答。普通核心上游输出、DNS 非握手应答仍必须通过原始 socket cgroup 规则。blocked 和 core-only 均不创建此 CT 标签或替代例外；loopback DNS 探针独立允许且不写 CT。执行器必须预检 CT 保留 mask 无其他使用者，不能将 CT mark 全局恢复到包 mark。

`ip.blackholes` 为三表 metric 32760 blackhole 默认路由；`ip.rules` 为独立 `rule add`，return 规则额外限制 TUN 入口与客户端 /32。`ip.prepareRoutes` 配置 egress 经路由器默认路由、return 经路由器客户端 /32，绝不为客户端建立直连邻居路由；`ip.activateCapture` 只配置 capture 表经 TUN 默认路由，`ip.withdrawCapture` 仅撤回这条精确路由。每条 `args` 交给固定 ip 程序直接执行，禁止 shell 拼接。`rule add` 只在预检证明缺失后执行，已存在时必须逐项核验；不能因为重复错误而跳过核验。

iproute2 多条操作不具备 nft 的事务性。执行器必须先安装并读回持久 blocked guard，再准备黑洞、策略规则、egress/return、非激活分类，取得新鲜核心证据后才安装 capture 并原子开放 active guard 与分类。任何失败先重申 blocked guard，保留三个黑洞；不得声明本渲染器已经完成运行时证据核验。外部 flowtable/offload 可绕过普通 forward hook，预检必须拒绝可能绕过本 guard 的外部流卸载。禁止 SNAT、全局 flush 和对外国防火墙或路由资源的修改。
