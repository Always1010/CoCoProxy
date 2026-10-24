# 受限原生网络资源会话

`NativeNetworkSession` 已实际调用固定 nft/ip 工具，执行本模块的 guard、三表黑洞、策略规则、经路由器的出口／回程、core-only 授权和 capture 激活，并独立回读内核状态。它是供未来特权 `NetworkDriver` 组合的资源执行组件，不是完整的生产执行服务。当前没有被 CLI、管理服务或 systemd 自动调用。

## 固定调用与来源

`create(deployment, tools, directory?)` 只接受重新校验的网络部署输入及固定允许的系统工具路径。提供由特权服务固定选择的私有 directory 后启用持久模式；省略时仍是原有进程内会话，不能用于生产恢复。生产入口要求 Linux root，user/net namespace 与 PID 1 相同。工具解析至固定 `/usr/bin` 或 `/usr/sbin` 下的 ip/nft，文件及全部祖先必须由 root 所有、不可被组或其他用户写入、类型正确且不经过替代符号链接。该条件不单独证明当前执行环境就是部署目标主机；特权入口还须核验受信部署、mount 视图和工具版本。

显式 `fixture(...)` 入口要求当前 user 和 network namespace 均不同于外层证据，必须提供受限测试 cgroup，输出固定 fixture 来源。它仅额外允许系统工具在新 user namespace 中显示的未映射 root UID 65534，其他类型、路径与权限约束不变；不能用它创建 production 观察。

首次会话只接受本模块 nft 表、三个 RPDB 规则及专用路由都不存在的初始状态，不接受外部 JSON receipt，不按同名或同配置认领已有资源。后续持久会话只读取同一私有 authority directory 的受保护凭据，并先要求显式恢复。v1 [回读校验](readback.md)要求无其他 nft 对象、无额外 RPDB 或自定义路由表；不满足时拒绝，不能清理发行版防火墙、容器网络或其他服务来通过预检。

命令通过[有界传输](command.md)直接执行，无 shell。所有 nft 批次和 ip 参数均重新来自固定 renderer，不能提交任意命令。`plan` 在构造时深度冻结；模式、规则基准和资源清单由会话维护，不接受调用方覆盖。

## 实际提交与回读

每个阶段先用既有期望状态核验当前内核，才执行下一步。nft 先做语法 check，再提交同一个受限批次，要求完整成功 JSON echo，合成下一份期望 AST 后用独立 list 精确比较。期望不取自待认领的当前 ruleset；规则表达式、原始顺序、链定义和所有对象 handle 均匹配。

实际验证的 nft 1.0.9 存在两个兼容陷阱：`--json --file` 配合原生文本输入可能退出 0 而未提交，匿名 literal set 在 replace echo 中可能回显重复或错误类型的成员。执行器使用单个无换行命令 argv 调用 `nft -j -n -e <batch>`，限制 16 KiB，且固定 renderer 输出标量规则以避开匿名集合。不会从 list 修复坏 echo，也不会只看退出码判断成功。具体来源与校验见[回读说明](readback.md)。

每条 ip 操作完成后再次读取 RPDB 和路由。清单只记录本会话实际发出的精确规则和路由，持久模式于核验后保存；即使另一个操作者添加了与计划完全相同的条目，也不能因为 partial 语义匹配就认领。额外、缺失或变化的成员都会终止会话。nft handle 同样防止同名同内容删除重建后沿用旧基准。

阶段如下：

- `installBlocked()` 原子建立两个固定表的 blocked 规则；客户端和核心非 loopback 输出仍阻断。
- `prepare()` 依次准备三张黑洞默认、三个 RPDB 规则和四条出口／回程路由。TUN 尚未存在时只允许精确 return 规则的 `iif_detached: null`；active 时拒绝它。
- `authorizeCore()` 仅在 prepared 后切至 core-only。调用方必须在调用前独立核验当前核心身份和 socket 隔离；本资源组件不代为生成该证明。
- `activate()` 仅在 core-only 后增加 capture，再原子切至 active。调用方必须于实际使用前重新核验完整新鲜运行证据。
- `retainBlocked()` 先重申 blocked，再撤回精确 capture，保留或补齐三张黑洞，回读确认。它不删除 guard、清空外部表或恢复 DIRECT。
- `recoverBlocked()` 只用于新建的持久会话，先收敛旧命令、核验凭据及内核，再重申 blocked、撤回 capture、保留三表黑洞。不恢复历史 ready。
- `inspect()` 只返回当前独立回读、代次、摘要、模式及 `terminalPath: unverified`，不宣称终端已验收；待恢复的新会话拒绝普通操作。

会话拒绝并发方法。任何操作失败或读回不符都会使会话失效，禁止继续盲目写入。底层未收敛异常继续保留原来的 `NetworkCommandError.childSettled`，不能吞掉后触发并行恢复。

## 持久与运行边界

持久模式使用[资源凭据](resource-journal.md)的跨进程锁，每次操作在锁内比较 revision，拒绝已经过期的实例。同一网络域必须固定唯一 authority directory；不同目录的锁不能互相保护。凭据绑定 scope、boot、user/net namespace、工具规范路径与二进制 SHA-256、renderer 和计划摘要。每次操作重新核验绑定，变化时拒绝；目前不执行跨 boot、namespace、工具版本或计划代次的迁移。

每次 mutation 前，完整旧 state 与 pending token、固定操作和命令摘要一次持久保存，再通过[命令启动屏障](fenced-command.md)执行。工具成功和独立回读均核验后，提交新 state 并清除 pending。文件或目录同步失败也使会话失效。命令回执当前保留在私有 commands 子目录，不包含 stderr；实际工具输出不进入正式日志或发布包。

恢复先确认 pending worker 的整个进程组已收敛，并核对其身份、摘要与 namespace。nft 仅从成功的持久 echo 重建下一份期望，且须与实际 AST、handle 和 IP 成员精确匹配；没有可信 echo 却发生规则变化时拒绝恢复。IP pending 仅接受完整旧清单或该固定单步之后的完整清单，不能任意认领 partial 子集。已采纳的 state 与清 pending 原子保存，防止恢复再次崩溃后丢失归属。

唯一允许的缺失资源是先前拥有的 capture 路由：TUN 消失会由内核自动撤销它。恢复仍须核验其余所有资源，只在立即转入 blocked 的过程中接受该精确缺失；到 blocked 成功前保留最后的 capture 归属记录。未知额外规则、其他缺失项、未收敛进程或损坏凭据都不会触发盲目修改。缺失首次 create echo 的不确定状态也可能需要人工排障；本实现不承诺所有断电窗口都自动修复。

[持久协调器](transaction.md)的 guard/prepare/authorize/activate 接口尚未与此会话及真实 systemd 核心生命周期连接。生产驱动还须形成统一写入纪律，并于每次真正授权前重新核验身份与证据。读取旧凭据、准备资源成功或恢复到 blocked 均不能替代这些运行事实。

接口、主机地址、sysctl、邻居、XDP/tc/eBPF、legacy iptables、其他 namespace 及 IPv6 整条路径不由本组件预检。源地址、TUN/DNS、出口 mark、两个服务 cgroup 隔离及真实终端路径也须由独立探针与服务边界证明。它不创建账户、安装单元或修改路由器。

## 已执行验证

`test:network-kernel` 在全新 user/network namespace 子树中，通过持久资源会话替代网关的手工初始 nft/ip 操作，并使用[实际 DNS/TUN 探针](probe.md)。四角色测试覆盖 blocked、prepared、core-only、active、退出后的 retain、规则污染和清单冲突拒绝；固定官方核心实际承载 HTTP、UDP 与 DNS。新增边界包括实际 ip/nft 执行完成但资源凭据仍 pending 后终止资源进程、重启恢复、过期实例拒绝、active 重启退回 blocked，以及核心退出和 capture 自动消失后恢复。pending 场景由可信 fixture 显式建立准确的持久中断点，不宣称测试了任意指令时刻的掉电。核心、TUN 和唯一节点故障还检查没有 DIRECT 回退。

fixture 复用既有真实 cgroup 并禁用管理例外，不证明生产两个固定服务的 cgroup 隔离。它没有通过持久协调器执行，不代表完整生产恢复、服务安装或真实设备联调已经完成。测试清理除原进程组外，也核对专用 user namespace 中的工具子进程，未清理完成时保留私有输入并失败。
