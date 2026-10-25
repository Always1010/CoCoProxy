# 身份与运行观察

本页适用于[保留框架](README.md)。观察器分别证明主机、进程、cgroup、socket、链路和DNS/TUN事实；全部通过才可组合证据，不能互相补缺。它们不安装或修复系统，DNS探针会发送受限查询，其他观察仅只读。

## 共用结果与时效

生产入口读取真实主机视图，不接收浏览器自报PID、任意路径或可替换reader。明确Fixture入口始终输出fixture，不自动fallback。public结果只含scope、verified、commandsSettled、checkedAt、generation/plan绑定、检查项及固定reason；内部身份含敏感PID／地址，不映射管理API。

两轮读取用于探测竞态，不是原子内核快照。除host为10秒外，单项成功观察窗口通常5秒；最终组合最多30秒，采用最早必要证据时间。时钟倒退、身份变化、缺项、混代／混scope或过期均拒绝。

commandsSettled只表示本次工具后代是否已收敛，不等于verified。明确NetworkCommandError保留childSettled，普通解析／事实不符属于已收敛失败；组合器遇缺失或false以及未分类依赖异常保留未收敛fence，不并发恢复写入。终端路径始终unverified。

## 核心与管理服务

| 入口 | 证明 |
| --- | --- |
| observeGatewayCore(settings,deployment) | 重新生成旧runtime plan，核对配置、unit／binary摘要、实际进程和认证controller |
| observeGatewayManagement({systemctlPath,managementUid}) | 从固定管理unit取得可信PID和最小身份，不接受调用者PID |
| observeCoreCgroup(input) | 对同一boot/PID/starttime验证两服务cgroup真实成员、权限和完整64位ID |

核心观察要求固定root控制systemctl、unit和祖先，unit loaded/active/running、无Job、drop-in或待reload，精确数字User、FragmentPath与ControlGroup。流式核验磁盘及实际运行executable inode／摘要；四类UID、进程状态、启动时间和完整argv匹配。argv固定binary、-d coreHome、-f systemd credential。

配置证据读取核心实际mount view中的 `/proc/<pid>/root/run/credentials/cocoproxy-mihomo.service/core-config`，要求普通单链接、无写位、有界canonical JSON、摘要等于generation。root selected-core.json相符不能替代实际快照。可信候选loader重编译提供controller端口和secret。

controller须唯一精确127.0.0.1 TCP listener，拒绝wildcard、IPv6或其他地址，inode由核心FD持有；再以认证/version作有界HTTP请求，无重定向／resolver／代理。前后复核unit、进程、namespace、binary、credential和socket。该观察不证明socket创建cgroup或FD转交历史。

管理观察核对root控制固定 `cocoproxy-management.service`、loaded/active/running、无job/drop-in/待reload、数字UID和固定cgroup，前后绑定boot、PID/starttime、四UID及mount视图；单命令1秒、16 KiB，整次5秒。它不证明unit正文摘要、二进制、cgroup唯一成员或socket，需与其他观察关联。

## cgroup 身份

生产只支持Linux6.x（6.1起）、x64/arm64的64位内核与Node。input包含corePid、corePidStartTime、bootId、managementPid、serviceUid，可选managementUid；省略只为旧共享UID兼容。生产驱动仍强制两个不同专用UID。

共同视图要求真实procfs/cgroup2fs及唯一完整根挂载，无覆盖实际读取路径或cgroup子挂载。observer的user/net/pid/cgroup/mnt与PID1一致，服务可因systemd sandbox拥有不同mnt；服务其余namespace与PID1一致。已裁剪容器视图不能当主机证明，完整systemd容器仍需部署边界确认。

两固定cgroup必须：

- 路径为/system.slice/cocoproxy-mihomo.service与cocoproxy-management.service，domain、无子组、无下级控制器，各恰有指定唯一进程。
- 根至叶目录及procs/threads/subtree_control由root控制、不可被其他身份写入，无目录／叶链接。
- 四类UID对应受信请求，NoNewPrivs=1；管理所有capabilities为空，核心只允许NET_ADMIN/NET_RAW。
- 两轮boot、starttime、mount、namespace、权限、ctime与ID一致。不同服务ID不能相同，ID全程bigint／十进制字符串，不经Number截断。

64位身份来源链是nft socket祖先cgroup→cgroup_id→kernfs kn->id→64位st_ino，只在已核验cgroup2fs与完整层级成立，不能将任意inode当ID。依据：[nft_socket.c](https://github.com/torvalds/linux/blob/v6.1/net/netfilter/nft_socket.c)、[cgroup.h](https://github.com/torvalds/linux/blob/v6.1/include/linux/cgroup.h)、[kernfs.h](https://github.com/torvalds/linux/blob/v6.1/include/linux/kernfs.h)、[inode.c](https://github.com/torvalds/linux/blob/v6.1/fs/kernfs/inode.c)，已核对v6.1/v6.12。规则level为2，不能退化为UID-only。

该证据不证明历史socket创建／继承／转交、同UID ptrace或可写cgroup FD未转交；root、核心及部署仍属信任边界。

## Socket 来源

`observeSocketSources(plan,binding,{stage})` 要求可信绑定的两套boot、PID/starttime、UID和cgroup ID。前后扫描每专用UID仅有指定进程；额外成员、共享FD、未知FD或身份变化拒绝。

固定 `/usr/bin/python3 -I -S` 调用socket-diag.py，通过NETLINK_SOCK_DIAG交叉核对/proc FD与INET_DIAG的cookie、UID、实际mark、cgroup ID和端点，非INET只允许明确UNIX/netlink。程序和祖先root控制；生产需PID1 user/net视图。缺mark不能当零；Linux6.1读取INET_DIAG_MARK需相应NET_ADMIN，依据[内核实现](https://github.com/torvalds/linux/blob/v6.1/net/ipv4/inet_diag.c)。

| socket | 约束 |
| --- | --- |
| DNS | 精确gateway:dnsPort的一对TCP LISTEN／UDP CLOSE，核心持有，无重复或wildcard |
| 核心非loopback | IPv4、核心UID／创建cgroup、实际mark保留位=egress，不允许额外对外TCP listener |
| 核心loopback | 保留位可为零或egress |
| 管理 | 独立管理UID/cgroup，保留位为零 |

identity阶段无上游连接也可通过；ready另需至少一条非DNS／非loopback的TCP或UDP ESTABLISHED，双端口非零、远端有效单播IPv4。未连接UDP和SYN pending不计。两轮保留DNS cookie及关键身份，允许合格临时上游socket替换，每轮FD集合仍要稳定。连接存在不证明业务成功。

## 主机预检

`observeNetworkHost(deployment,options)` 接受固定系统路径ipBinary、tcBinary、iptablesLegacySaveBinary、ip6tablesLegacySaveBinary；工具及真实目标root控制。legacy链接只允许对应名或xtables-legacy-multi，不能落到nft applet。

生产要求Linux6.x minor≥1、x64/arm64、真实euid0，完整初始UID map、root四UID、单层NSpid，self与PID1所有受检namespace一致；proc/sys/cgroup真实magic与根挂载、无受保护路径覆挂。入口是无master／虚拟kind的独立Ethernet，真实sysfs位于/sys/devices而非virtual。

ip_forward=1；all/default/入口/已存在计划TUN的rp_filter、send_redirects、accept_redirects、accept_source_route、route_localnet均0。只检查不修正。

| 查询 | 接受范围 |
| --- | --- |
| ip -d -j link show | 全接口，无XDP，和sysfs清单一致 |
| ip -j xfrm policy/state list | 成功且空白或[]，任何配置／错误拒绝 |
| 每接口tc qdisc及root/ingress/egress/实际handle和parent filter | filter均空，仅支持noqueue/fq_codel/pfifo_fast/mq/ingress/clsact已知字段；拒绝共享block、qevents、未知选项 |
| host-bpf.py | 全局只读枚举program，全部必须为CGROUP_DEVICE，未附着的其他类型也拒绝 |
| iptables-legacy-save与ip6tables-legacy-save | 成功、空输出或完整空内建表；已知表、ACCEPT policy、完整chain/COMMIT，拒绝任何规则／自定义chain |

单命令750ms／256 KiB，最多64接口、每接口128 qdisc；两轮10秒内完全稳定。JSON拒绝重复键和未知形状，兼容新工具输出前核对实现。

BPF helper以Python -I -S -B仅调用GET_NEXT_ID、GET_FD_BY_ID、GET_INFO_BY_FD，不加载或附着；枚举前要求可信/proc自身唯一Seccomp:0，避免过滤器伪造ENOENT。输出canonical的schemaVersion/devicePrograms/inventorySha256，最多4096，摘要纳入稳定比较。Linux6.1枚举需SYS_ADMIN，单独BPF能力不足。CGROUP_DEVICE只限制设备访问，可由systemd创建，不删除它来通过检查。依据：[BPF syscall](https://github.com/torvalds/linux/blob/v6.1/kernel/bpf/syscall.c)、[seccomp](https://www.kernel.org/doc/html/v6.1/userspace-api/seccomp_filter.html)。

不采用bpftool空net/cgroup结果：某些查询可忽略错误，prog show的PID枚举还可能加载iterator，不能作为严格只读证明。

## 链路与路由

`observeNetworkLink(plan,{ipBinary,probeIPv4})` 每轮读取link、address、精确router邻居和带from/mark/uid的 `route get`，两轮5秒内稳定，每输出≤64 KiB。probe为部署网段外的规范单播IPv4，排除0/8、127/8、169.254/16、组播、高位及198.18/15，不等于任一角色；只作路由查询。

| 对象 | 约束 |
| --- | --- |
| 接口 | 独立Ethernet，无master/bridge/slave/虚拟kind，精确ifname/index/MAC，UP、LOWER_UP、无NO-CARRIER/promisc/proto-down；MTU容纳TUN |
| 地址 | 唯一global IPv4精确gateway/prefix，无alias/secondary/tentative/失效寿命；允许稳定IPv6 link-local，不允许global IPv6 |
| 邻居 | 精确routerIPv4/MAC，仅单一REACHABLE或PERMANENT，两轮状态也须相同；不主动刷新ARP |
| 出口 | route get的实际目的、from、gateway、dev、mark、UID、table逐一匹配，拒绝额外nexthop、type、非空flags/cache |

ip -N避免表别名；邻居查询已带dev时JSON可省略dev，router标志可为null，不能因此伪造字段。生产不支持VLAN、bridge、bond等拓扑，fixture额外允许veth。来源：[iproute2邻居](https://github.com/iproute2/iproute2/blob/main/ip/ipneigh.c)、[路由](https://github.com/iproute2/iproute2/blob/main/ip/iproute.c)。

## DNS 与 TUN 探针

`observeNetworkReadiness(plan,identity,options)` 在同一受信namespace核对核心FD，并分别发送UDP/TCP DNS。DNS精确IPv4 gateway:dnsPort各一个核心listener，拒绝其他地址／IPv6；TUN FD为字符设备10:200，iff=cocoproxy-tun，ip回读为tun/UP/计划MTU/唯一198.18.0.1/30，前后身份稳定。

options的queryDomain为部署者控制的wildcard测试域，随机子域最终返回expectedIPv4，不从浏览器或订阅取值。每传输独立128-bit名称nonce和随机16-bit ID，本地绑定127.0.0.1，目标固定gateway:dnsPort，无系统resolver、重试或预热。

响应核对完整问题、IN/A、ID、QR/opcode/TC/保留位、普通与EDNS RCODE，≤4096字节／128记录／CNAME深度16；从问题开始的无环链最终仅含预期IPv4，拒绝未关联答案、压缩循环／前向指针和尾字节。TCP核对长度前缀，完整bind/connect/read默认1秒、最高3秒。依据：[RFC1035](https://www.rfc-editor.org/rfc/rfc1035.html)。

该探针不证明节点可达、上游代理、客户端回程或FD历史共享。fixture可在独立namespace运行真实proc/ip/socket，映射UID例外仍仅fixture。

## 证据组合

`observeGatewayIdentity` 按核心事实→cgroup→socket identity→复核核心/cgroup生成内部NetworkIdentity。管理PID由固定unit或认证本地peer取得，两UID与plan一致。

`observeGatewayEvidence` 先取得并比对预期身份，再作DNS/TUN、链路、socket ready、真实NativeNetworkSession的独立资源读回，最后复核完整身份。资源scope、generation、plan及core-only/active匹配，每项在本次调用后完成，30秒内采用最早证据时间。

固定驱动已组合这些入口，但真实两个固定服务的完整正向和终端验收仍未完成。明确的读回结构／membership失败在查询返回后可归类已收敛；会话失效和未知原生异常不能套用该例外。真正authorize/activate前仍须在独占fence内重新核验。
