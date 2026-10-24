# 核心 cgroup 只读身份观察

`observeCoreCgroup` 只读取固定 `/proc` 和 `/sys/fs/cgroup`，不执行命令，不改变网络、cgroup、服务或软件配置。调用方传入已经独立核验的 `corePid`、`corePidStartTime`、`bootId`、`managementPid` 和共享 `serviceUid`。输入没有替换 procfs/cgroupfs 根目录的选项，也不接受 JSON 快照作为生产事实。

输出 `scope: production` 只表明来源为本机真实内核接口；必须同时检查 `verified`，失败时 `identity` 为 null，固定 `NETWORK_CGROUP_UNVERIFIED` 不携带路径、异常原因或原始输出。成功输出绑定 boot ID、PID/start time、固定 ControlGroup 和完整十进制 kernel ID，另带管理进程的独立 cgroup 身份以及毫秒 `checkedAt`。没有 `ready` 属性。调用方必须与 binary/unit/generation 的实际核验结果组合，并检查证据时效及同一身份。

观察内容包括：

- procfs 与 cgroup2fs 的真实文件系统 magic；mountinfo 中 `/proc` 与 `/sys/fs/cgroup` 必须各有唯一完整根挂载。cgroupfs 下层挂载全部拒绝；procfs 拒绝覆盖实际读取路径及其祖先的挂载，包括 boot ID、PID 1 的 namespace、核心与管理进程子树，以及 observer 自身的 `self` 别名和实际数字 PID 子树。与读取路径无关的挂载（例如 `/proc/sys/fs/binfmt_misc` 的 autofs/binfmt_misc）允许存在；覆盖 `/proc/sys`、受检 PID 或其 `status`、observer 的数字 PID `mountinfo` 等仍拒绝。observer 自身必须处于 PID 1 的 mount namespace，不能在容器提供的替代视图中声称主机验证。执行环境必须由受信部署确认是目标主机 PID 1 的命名空间；该模块不能单独区分拥有自己 systemd 的完整容器与宿主机。
- observer、核心及管理进程与 PID 1 的 user/pid/cgroup/net namespace 一致。核心和管理服务可因 `PrivateTmp` 或 `ProtectSystem` 使用不同 mount namespace，不因此被拒绝。
- 核心固定为 `/system.slice/coproxy-mihomo.service`，管理固定为 `/system.slice/coproxy-management.service`；二者必须是 `domain`、无子 cgroup、无启用的下级控制器，各自恰有指定的唯一进程。额外成员、线程化 cgroup、不同路径或两个相同的 kernel ID 都拒绝。
- 从文件系统根至两个 cgroup 的目录，由 root 所有，不能被组或其他用户写入；cgroup 根、system.slice 及两叶节点的 `cgroup.procs`、`cgroup.threads`、`cgroup.subtree_control` 同样受 root 控制。拒绝目录符号链接和叶节点内符号链接。
- 两进程的四类 UID 都匹配服务 UID，`NoNewPrivs` 为 1；管理进程的 inheritable/permitted/effective/ambient capabilities 全空。核心只允许 `CAP_NET_ADMIN` 和 `CAP_NET_RAW`，不允许 DAC、身份切换、cgroup 管理等能力绕过权限证明。这个检查本身没有授予任何能力。
- 两轮完整读取必须完全一致，包括 boot ID、PID start time、mountinfo、namespace、cgroup ID、权限和 ctime；读取失败、身份更换、目录替换或超过五秒都丢弃证据。两轮观察是竞态探测，不是内核原子快照，不能保证读取之间未出现又消失的成员。后续 privileged helper 必须在独占协调和 generation CAS 下，于实际使用前再次观察；运行时故障仍须保持阻断。

## Kernel ID 的依据和受支持范围

该实现仅接受 Linux 6.x（从 6.1 起）及 x64/arm64 的 64 位内核/Node 部署；其他架构、较老内核及尚未审查的未来大版本拒绝。发行版内核仍须保持下面的上游实现语义，版本号不是对自定义内核的完整认证。已逐段核实上游 v6.1 与 v6.12，生产部署需对实际发行版完成只读验收。

这不是把任意文件的 inode 直接当作 cgroup ID。推导限定于核验过的真实 cgroup2fs 与完整主机层级：

1. 上游 [`nft_sock_get_eval_cgroupv2`](https://github.com/torvalds/linux/blob/v6.1/net/netfilter/nft_socket.c) 从 socket 的 cgroup 数据取得指定层级祖先，然后读取 `cgroup_id`。
2. [`cgroup_id`](https://github.com/torvalds/linux/blob/v6.1/include/linux/cgroup.h) 返回该 cgroup 的 `kn->id`。
3. [`kernfs_id_ino` / `kernfs_ino`](https://github.com/torvalds/linux/blob/v6.1/include/linux/kernfs.h) 在内核 `ino_t` 为 64 位时返回完整 `kn->id`；32 位内核只返回低 32 位，所以拒绝 32 位部署。
4. [`kernfs_get_inode` / `kernfs_iop_getattr`](https://github.com/torvalds/linux/blob/v6.1/fs/kernfs/inode.c) 用此号码获取 inode 并经 `generic_fillattr` 提供属性，因此这些约束下的 bigint `st_ino` 对应同一 64 位 kernel ID。全程以 bigint/十进制字符串保留，避免 Number 在 2^53 以上截断。

v6.12 对应实现见 [kernfs.h](https://github.com/torvalds/linux/blob/v6.12/include/linux/kernfs.h)、[cgroup.h](https://github.com/torvalds/linux/blob/v6.12/include/linux/cgroup.h) 与 [nft_socket.c](https://github.com/torvalds/linux/blob/v6.12/net/netfilter/nft_socket.c)。cgroup2fs magic、domain、进程迁移与权限语义见 [Linux cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)。

该来源链说明身份数值的含义，并不证明当前主机的 nft socket 表达式已可用、已安装或在正确 hook/level 中实际阻断。固定路径的层级为 2；后续 nft driver 必须核验其 namespace/level 语义、每 socket 来源、规则读回及同 UID 管理流量确被排除。禁止 UID-only 降级。

## 证据边界与只读验收

`observeCoreCgroupFixture(input, trustedReader)` 是内部可信代码的失败注入入口，输出始终为 `scope: fixture`，不能产生生产证据。测试使用合成路径、UID、PID 和 boot ID；fixture 成功仅说明解析及拒绝逻辑符合预期。生产函数不接收这个 reader。scope 是调用方必须检查的来源标签，不是对已被恶意 JavaScript 修改的进程的安全边界。

本模块不证明 binary/unit/generation、进程启动前 socket 来源、已有 socket 的历史创建者、socket/FD 转交、继承的可写 cgroup FD、同 UID ptrace/进程注入限制，也不证明网络规则与 DNS/TUN 行为。root 和受信 core 必须属于部署的信任边界；unit/helper 启动纪律需防止这些能力被转交给管理进程。仅凭本模块成功不得开放网络。

最小单元验证命令是 `node --experimental-strip-types --test tests/network-identity.test.ts`。在已独立部署两固定 unit 的 Linux 测试机上，可由受信主机视图的只读操作者取得 systemd MainPID 及既有进程证据，再调用生产 observer；比较输出与独立的 procfs/cgroupfs 读取，确认共享 UID 但两个不同 kernel ID，核对 64 位 inode 与内核来源链。若需独立核对 kernfs handle，可使用现场已存在且已审查的 `name_to_handle_at` 工具；本模块不安装或编译额外依赖。

没有正确固定 unit 时，应保留生产 `verified: false` 的结果，不为正向验收创建服务或迁移进程。成员污染、权限变更、重启及实际 nft 排除测试须在另行授权的隔离 Linux 环境执行，不能把本机只读验收扩大成主机变更授权。当前交付的单元测试覆盖合成正向身份、64 位精度、伪文件系统/覆挂、namespace、权限、成员、子 cgroup、capabilities、PID reuse/boot change/cgroup replacement 和非 Linux 生产拒绝；尚未获得真实固定 unit 下的正向生产验收。
