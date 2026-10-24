# 入口链路、当前邻居与出口路由只读观察

`observeNetworkLink(plan, options)` 在生产边界执行固定只读 ip 查询。`observeNetworkLinkFixture(plan, options, reader?)` 使用相同校验，输出始终为 `scope: 'fixture'`；提供的 reader 是可信测试缝，不可映射成生产 API。两个入口都不修改 sysctl、地址、链路、邻居、路由或规则，不执行 ping/arping，不发送探测数据包，不主动刷新或补建 ARP。

`options` 严格为 `{ ipBinary, probeIPv4 }`，来自部署所有者。ip 路径仅允许 `/usr/sbin/ip`、`/usr/bin/ip`、`/sbin/ip`、`/bin/ip`，生产执行前解析真实位置并逐层检查二进制及全部祖先由 root 持有、不可由组/其他用户写入、非符号链接，二进制还须为可执行常规文件；生产需 Linux/root。fixture 默认真实 reader 额外兼容隔离 user namespace 中映射成 65534 的宿主 root 文件，只影响 fixture scope。该检查沿用项目其他固定命令观察器的可信祖先边界；不是允许任意程序路径的命令接口。

`probeIPv4` 必须为规范 IPv4 单播，位于部署网段外，排除 0/8、127/8、169.254/16、组播/高位保留范围和整个 198.18/15 基准测试池。它不能等于网关、路由器、终端或 TUN 地址。这里只做路由查询，不证明该目的可达或能提供业务；真实部署须自行配置受信的实际单播目的，合成测试可使用文档地址。

每轮查询如下，参数只来自已重渲染的可信 plan 与 options。第二轮完整重复，全部观察须在五秒内完成：

```text
ip -d -j link show dev <ingressInterface>
ip -d -j address show dev <ingressInterface>
ip -j -4 neigh show to <routerIPv4> dev <ingressInterface>
ip -j -4 -N route get <probeIPv4> from <gatewayIPv4> mark <egressMark> uid <coreServiceUid>
```

生产仅接受独立 Ethernet 接口：精确 ifname、正 ifindex、单播 MAC、`link_type=ether`、无 master 或 bridge/slave 角色、无虚拟 `info_kind`。fixture 额外允许 veth。TUN、bridge、bond、VLAN、macvlan 等拓扑暂不属于此观察器契约；不能把它们的配置猜测为物理入口证明。ifindex/MAC/MTU/flags/kind 在 link/address 两个输出及前后两轮必须一致，MTU 至少承载计划 TUN MTU。接口必须 operstate UP，具备 UP、LOWER_UP 且无 NO-CARRIER；LOWER_UP 是实际 carrier 事实，若 ip 版本另输出 carrier，则它必须为 1。拒绝 promiscuous、proto-down 和重复 flag。

地址必须恰有一个 IPv4，即明确网关/prefix，global scope，标签缺省或为精确接口名；额外 IPv4、别名标签、重复 local、secondary、tentative、deprecated、dadfailed 和零有效/首选寿命均不通过。兼容 Linux 正常的 IPv6 link-local 地址，但拒绝全局 IPv6 或重复地址；观察前后 link-local 集合也须相同。寿命倒计时与邻居统计计数不作为接口身份，避免正常计时漂移造成假失配。

邻居必须是请求的 routerIPv4、精确 routerMAC，且状态只能为单一 REACHABLE 或 PERMANENT；STALE、DELAY、PROBE、FAILED、INCOMPLETE、NOARP 均明确返回未验证。两个合格状态之间发生切换也不能算本次稳定观察。iproute2 在命令已指定 dev 时会有意省略邻居 JSON 的 dev；接口事实由受限内核查询的 dev 过滤器提供，若输出额外含 dev 则必须一致。邻居 JSON 的 router 标志也兼容 iproute2 实际输出的 null。相关字段行为依据 [iproute2 官方邻居实现](https://github.com/iproute2/iproute2/blob/main/ip/ipneigh.c)，不会把计划中的 MAC 直接复制成观察证据。

route get 必须输出实际目的、from=网关、gateway=路由器、dev=入口、mark=egress mark、uid=核心 UID、table=egress 表；mark/uid 是实际 JSON 数字，table 兼容 JSON 数字或规范十进制字符串。`-N` 避免本机 rt_tables 别名被误当数字身份；如额外输出 prefsrc，也须为网关。拒绝其它 route type、额外 nexthops、非空 flags/cache 或缺失字段，不从命令参数补造缺失路由事实。字段输出依据 [iproute2 官方路由实现](https://github.com/iproute2/iproute2/blob/main/ip/iproute.c)。这证明当前 mark/source/UID 路由选择，不能证明任意 socket 已真实拥有 mark 或网络分类器已经执行。

每条输出最多 64 KiB；自包含 JSON parser 限制深度与节点，拒绝重复键（含转义后同名）、危险键、非整数数字、负零、尾随内容与不合约字段。输出对象的受保护事实缺失或类型错误均保持未验证，不暴露 parser/OS 原始错误。支持常见 Linux/iproute2 的驱动队列、offload 上限、linkmode、IPv6 地址生成方式等已知元数据；不会因未输出 carrier 或邻居 dev 就伪造它们。

返回仅含 `scope`、`verified`、`checkedAt`（毫秒）、`planSha256`、`generation`、固定 reason 和 checks。checks 包含 interfaceIdentity/carrier/gatewayAddress/mtu/routerNeighbour/egressRoute/stable，只有完整稳定观察通过时才全部为 true；失败 reason 固定 `NETWORK_LINK_UNVERIFIED`。合法 plan 的绑定即使观察失败仍返回；无效 plan 的绑定为 null。没有实际拓扑、接口名、MAC、probe 目的或 raw 输出。观察只能说明本地瞬时事实，不构成终端/路由器业务验收、资源所有权、socket cgroup 来源或捕获 ready 的充分证据。

fixture reader 为 `{ platform, root, command(args), now() }`，`command` 返回原始 JSON 字符串；默认 reader 执行上述相同固定查询。合成测试不访问设备或网络：

回归测试还覆盖真实 iproute2 veth 的正常省略：linkinfo 可仅含 info_kind、IPv4 地址可无 broadcast、address 输出可省略 link 输出中的 linkmode/IPv6 地址生成元数据。邻居 DELAY 继续拒绝；隔离 fixture 需要明确安排当前合格邻居事实，不能为测试通过放宽生产状态契约。

```text
node --experimental-strip-types --test tests/network-link.test.ts
```
