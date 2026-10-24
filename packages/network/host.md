# 只读生产主机预检

`observeNetworkHost(deployment, options)` 重新渲染完整网络部署，读取主机平台、挂载、命名空间、sysctl 和旁路程序事实。它不初始化存储，不安装缺失工具，不修改 sysctl、链路、路由、规则或 BPF，不发送 ARP、ping 或探针流量。入口地址、邻居和实际出口事实由独立的 [link observer](link.md) 检查；本模块不替代资源归属、核心身份或终端验收。

`options` 必须显式指定 `ipBinary`、`tcBinary`、`iptablesLegacySaveBinary`、`ip6tablesLegacySaveBinary`。只允许 `/usr/sbin/`、`/usr/bin/`、`/sbin/`、`/bin/` 下对应的固定工具名。每个工具及其真实目标、祖先必须由 root 控制，普通用户不能写入；缺失、不可执行或不可信即返回固定的 `NETWORK_HOST_UNVERIFIED`。legacy save 可以是 root 控制的符号链接，目标必须仍是同名工具或 `xtables-legacy-multi`，不能解析到 nft applet。执行时保留原 save 路径及其 applet 名称。

## 主机视图与稳定性

生产入口只接受 Linux 6.x 且 minor ≥ 1、x64 或 arm64、实际有效 UID 0。它验证 `/proc`、`/sys`、`/sys/fs/cgroup` 的 procfs、sysfs、cgroup2fs 魔数及完整根挂载。已知观测路径上的 proc/sysfs 重叠子挂载、任意 cgroup 子挂载和裁剪过的 cgroup 根挂载均拒绝。self 与 PID 1 的 user、net、pid、cgroup、mnt 命名空间必须一致；完整初始 UID map、实际 root UID 四元组及单层 NSpid 也必须读回，容器内同名路径不能直接取得通过结果。

每轮在命令前后重读上述上下文和工具元数据；连续两轮全部观测一致，且总时间不超过 10 秒才能通过。工具输出最多 256 KiB，单次命令最多 750 ms，接口最多 64 个，每接口 qdisc 最多 128 个；超出支持范围安全拒绝。接口列表同时与实际 sysfs 清单核对。生产入口必须是没有 master、没有虚拟 link kind 的独立 Ethernet，真实 sysfs 路径位于 `/sys/devices/` 且不属于 `virtual/`。

要求 `ip_forward=1`。`all`、`default`、入口，以及已经存在的计划 TUN，其 `rp_filter`、`send_redirects`、`accept_redirects`、`accept_source_route`、`route_localnet` 必须全部为 0；不满足时只报告未核验，不自动修正。

## 固定只读命令与输出契约

- `ip -d -j link show`：检查全部接口，无 XDP 附着字段。实际 iproute2 同命名空间 veth 的 `link` 字段属于已支持输出；仅 fixture 允许其作为入口。
- `ip -j xfrm policy list` 与 `ip -j xfrm state list`：必须执行成功且为空。当前 iproute2 的空 XFRM dump 可以完全没有 stdout，因此只接受空白或 JSON 空数组；任何规则、状态、诊断文本或非零退出都拒绝。[官方 policy dump](https://github.com/iproute2/iproute2/blob/main/ip/xfrm_policy.c)、[state dump](https://github.com/iproute2/iproute2/blob/main/ip/xfrm_state.c) 沿 netlink 列举并逐项打印，失败则非零退出。
- 对每个接口执行 `tc -j qdisc show dev IFACE`，随后查询 `tc -j filter show dev IFACE root`、`ingress`、`egress` 及每个实际 qdisc handle、parent。所有 filter dump 必须为空；没有指定 chain，保留完整 chain dump。仅接受 `noqueue`、`fq_codel`、`pfifo_fast`、`mq`、`ingress`、`clsact` 的受支持字段。未知 qdisc、共享 block、qevents、未知选项或附着分类器全部拒绝。字段以 [官方 qdisc renderer](https://github.com/iproute2/iproute2/blob/main/tc/tc_qdisc.c) 和 [filter dump](https://github.com/iproute2/iproute2/blob/main/tc/tc_filter.c) 为依据；不只查询 root 后推断嵌套位置为空。
- 固定本地 `host-bpf.py` helper：通过受信包装器只读调用 `BPF_PROG_GET_NEXT_ID`、`BPF_PROG_GET_FD_BY_ID`、`BPF_OBJ_GET_INFO_BY_FD`，全局枚举已加载程序、持有 FD 并验证稳定性。只允许真实 kernel program type `CGROUP_DEVICE`；包括未附着在内的任何其他已加载程序、权限失败、截断或不稳定结果都拒绝。主机模块仅接收严格 canonical JSON `{schemaVersion:1,devicePrograms,inventorySha256}`，数量最多 4096、SHA-256 必须完整，并将摘要纳入两轮稳定性比较；不接受调用者提交的“无 BPF”布尔值。
- `iptables-legacy-save` 与 `ip6tables-legacy-save`：两者均须成功。允许空输出，或严格完整的空表；只允许已知 filter、nat、mangle、raw、security 表的完整 builtin chain 集合、ACCEPT policy、计数器及 COMMIT。任何规则、自定义 chain、非 ACCEPT policy、缺失 chain、未提交表、重复表或混入未知内容都拒绝。权限不足、命令不存在和非零退出不能解释为“没有 legacy 规则”。

helper 固定使用 root 控制的 Python 3 与 `-I -S -B`，隔离用户 Python 环境、禁用 site 初始化和字节码缓存写入。调用枚举前从可信 procfs 读取自身状态，要求唯一的 `Seccomp: 0`；过滤或缺失状态均拒绝。seccomp 可以跨 exec 继承，并在不执行 syscall 时直接返回自选 errno，因此受过滤的 `ENOENT` 不能证明列表为空，见 [Linux seccomp 文档](https://www.kernel.org/doc/html/v6.1/userspace-api/seccomp_filter.html)。三个固定命令及 info 的前两个字段取自 [Linux 6.1 BPF UAPI](https://raw.githubusercontent.com/torvalds/linux/v6.1/include/uapi/linux/bpf.h)，没有加载、附着或 map 更新命令。

`CGROUP_DEVICE` 是设备文件访问程序类型，只能决定 mknod/read/write 设备访问是否被拒绝，不授予网络旁路；该语义来自 [Linux cgroup v2 device controller 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html#device-controller)。systemd `PrivateDevices` 等设备限制可以产生这种程序，因此保留该保护，不通过删除设备限制来满足主机检查。实际 DNS/TUN 探针仍须独立验证对应设备是否可用。

不依赖 bpftool 的空 net/cgroup 输出：其 [官方 net 实现](https://github.com/libbpf/bpftool/blob/main/src/net.c) 会静默忽略某些 TCX/netkit 查询失败，空数组不能单独证明不存在附着；而 [prog show 的 PID 引用枚举](https://github.com/libbpf/bpftool/blob/main/src/pids.c) 在常见构建中会加载并附着 iterator BPF，不能用于严格只读预检。因此不执行这些命令，不要求特殊 bpftool 构建，也不安装该工具；固定原生 syscall helper 直接核验实际 program type，并在任何无法证明的情况保持未核验。

解析器拒绝重复 JSON 字段，包括转义后重名；未知形状继续未核验。工具输出格式本身不是稳定 ABI，兼容新形状前必须再次核对实际输出和官方实现，不能为扩大通过率省略关键观察。

## 结果与证据范围

结果只含固定 scope、verified、commandsSettled、checkedAt、generation、完整 plan SHA、reason 和少量检查项；不返回拓扑、接口名、PID、路径、原始命令输出或嵌套错误。明确的 `NetworkCommandError` 保留其 childSettled 分类；未知命令依赖异常保守返回 `commandsSettled:false`，禁止据此并发推进恢复变更。读回成功后的内容拒绝不会伪装成未结束的命令。

`observeNetworkHostFixture(deployment, options, reader)` 是受信合成 reader 接口，无论 reader 提供什么平台资料，结果始终为 fixture。测试覆盖完整正向、实际 noqueue/veth/空 XFRM 形状、嵌套 parent 查询、现存 TUN、命名空间与挂载替换、工具来源、旁路程序、仅设备 BPF 摘要、legacy 混入规则、输出漂移和未收敛分类；不需要网络写入或软件安装。

此观察证明的是上述明确支持的主机条件，保守拒绝所有非设备类型的已加载 BPF，包括当前未附着的程序；不能据此宣称兼容其他命名空间、所有第三方网络栈或未来内核功能。两轮读取也不是原子内核快照，外层唯一写入者仍须在实际操作前重验，阻断规则和资源完整读回继续独立负责。本轮完整正向来自合成 reader；初始主机命名空间中的 root 与完整工具链生产正向尚待授权服务环境验收。实际 BPF 枚举还要求内核授予读取权限：Linux 6.1 的 GET_NEXT_ID 要求 CAP_SYS_ADMIN，单独 CAP_BPF 不足，见 [内核 syscall 实现](https://github.com/torvalds/linux/blob/v6.1/kernel/bpf/syscall.c)。缺少任何必需工具、helper 或读取权限时保持未核验，不自动提升权限。
