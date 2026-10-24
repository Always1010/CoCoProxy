# 受限原生网络资源会话

`NativeNetworkSession` 已实际调用固定 nft/ip 工具，执行本模块的 guard、三表黑洞、策略规则、经路由器的出口／回程、core-only 授权和 capture 激活，并独立回读内核状态。它是供未来特权 `NetworkDriver` 组合的资源执行组件，不是完整的生产执行服务。当前没有被 CLI、管理服务或 systemd 自动调用。

## 固定调用与来源

`create(deployment, tools)` 只接受重新校验的网络部署输入及固定允许的系统工具路径。生产入口要求 Linux root，user/net namespace 与 PID 1 相同。工具解析至固定 `/usr/bin` 或 `/usr/sbin` 下的 ip/nft，文件及全部祖先必须由 root 所有、不可被组或其他用户写入、类型正确且不经过替代符号链接。该条件不单独证明当前执行环境就是部署目标主机；特权入口还须核验受信部署、mount 视图和工具版本。

显式 `fixture(...)` 入口要求当前 user 和 network namespace 均不同于外层证据，必须提供受限测试 cgroup，输出固定 fixture 来源。它仅额外允许系统工具在新 user namespace 中显示的未映射 root UID 65534，其他类型、路径与权限约束不变；不能用它创建 production 观察。

会话只接受本模块 nft 表、三个 RPDB 规则及专用路由都不存在的初始状态，不接受外部 JSON receipt，不按同名或同配置认领已有资源。v1 [回读校验](readback.md)要求无其他 nft 对象、无额外 RPDB 或自定义路由表；不满足时拒绝，不能清理发行版防火墙、容器网络或其他服务来通过预检。

命令通过[有界传输](command.md)直接执行，无 shell。所有 nft 批次和 ip 参数均重新来自固定 renderer，不能提交任意命令。`plan` 在构造时深度冻结；模式、规则基准和资源清单由会话维护，不接受调用方覆盖。

## 实际提交与回读

每个阶段先用既有期望状态核验当前内核，才执行下一步。nft 先做语法 check，再提交同一个受限批次，要求完整成功 JSON echo，合成下一份期望 AST 后用独立 list 精确比较。期望不取自待认领的当前 ruleset；规则表达式、原始顺序、链定义和所有对象 handle 均匹配。

实际验证的 nft 1.0.9 存在两个兼容陷阱：`--json --file` 配合原生文本输入可能退出 0 而未提交，匿名 literal set 在 replace echo 中可能回显重复或错误类型的成员。执行器使用单个无换行命令 argv 调用 `nft -j -n -e <batch>`，限制 16 KiB，且固定 renderer 输出标量规则以避开匿名集合。不会从 list 修复坏 echo，也不会只看退出码判断成功。具体来源与校验见[回读说明](readback.md)。

每条 ip 操作完成后再次读取 RPDB 和路由。进程内清单只记录本会话实际成功发出的精确规则和路由；即使另一个操作者添加了与计划完全相同的条目，也不能因为 partial 语义匹配就认领。额外、缺失或变化的成员都会终止会话。nft handle 同样防止同名同内容删除重建后沿用旧基准。

阶段如下：

- `installBlocked()` 原子建立两个固定表的 blocked 规则；客户端和核心非 loopback 输出仍阻断。
- `prepare()` 依次准备三张黑洞默认、三个 RPDB 规则和四条出口／回程路由。TUN 尚未存在时只允许精确 return 规则的 `iif_detached: null`；active 时拒绝它。
- `authorizeCore()` 仅在 prepared 后切至 core-only。调用方必须在调用前独立核验当前核心身份和 socket 隔离；本资源组件不代为生成该证明。
- `activate()` 仅在 core-only 后增加 capture，再原子切至 active。调用方必须于实际使用前重新核验完整新鲜运行证据。
- `retainBlocked()` 先重申 blocked，再撤回精确 capture，保留或补齐三张黑洞，回读确认。它不删除 guard、清空外部表或恢复 DIRECT。
- `inspect()` 只返回本次同进程回读、代次、摘要、模式及 `terminalPath: unverified`，不宣称终端已验收。

会话拒绝并发方法。任何操作失败或读回不符都会使会话失效，禁止继续盲目写入。底层未收敛异常继续保留原来的 `NetworkCommandError.childSettled`，不能吞掉后触发并行恢复。

## 持久与运行边界

此组件没有跨进程锁、持久所有权 receipt、工具进程启动回执、未知命令收敛核验或重启 adoption。调用方必须在唯一权威 helper 的锁内使用；不能创建多个独立会话并发管理同一网络域。异常后不能仅重建会话去认领既有资源。

[持久协调器](transaction.md)的 guard/prepare/authorize/activate 接口尚未与此会话及真实 systemd 核心生命周期连接。完成生产驱动时，必须把进程内基准转为受保护 receipt，在 mutation 前记录意图及工具身份，确认旧命令完全收敛后才能恢复，并于每次真正授权前重新核验身份与证据。这个缺口不能通过测试替身或保存 true 字段补上。

接口、主机地址、sysctl、邻居、XDP/tc/eBPF、legacy iptables、其他 namespace 及 IPv6 整条路径不由本组件预检。源地址、TUN/DNS、出口 mark、两个服务 cgroup 隔离及真实终端路径也须由独立探针与服务边界证明。它不创建账户、安装单元或修改路由器。

## 已执行验证

`test:network-kernel` 在全新 user/network namespace 子树中，通过本会话替代网关的手工初始 nft/ip 操作，并使用[实际 DNS/TUN 探针](probe.md)。四角色测试覆盖 blocked、prepared、core-only、active、退出后的 retain、规则污染拒绝和进程内清单冲突拒绝；固定官方核心实际承载 HTTP、UDP 与 DNS。故障场景仍分别控制核心、TUN 和唯一节点，检查没有 DIRECT 回退。

fixture 复用既有真实 cgroup 并禁用管理例外，不证明生产两个固定服务的 cgroup 隔离。它也没有通过持久协调器执行，不代表上述生产恢复、服务安装或真实设备联调已经完成。测试清理除原进程组外，也核对专用 user namespace 中的工具子进程，未清理完成时保留私有输入并失败。
