# 网络资源回读边界

`verifyNetworkReadback` 是纯函数。输入必须来自执行器刚完成的只读命令：

```text
nft -j -n -a list ruleset
ip -j -4 rule show
ip -j -4 route show table all
```

调用者传入完整 deployment，函数重新验证 plan。`expected.nft` 是可信执行器维护的已知期望状态，不能来自浏览器/API 请求、当前待认领的 ruleset 或可写的应用配置。它可以包含零张表、只有 guard 表，或 guard/data 两张表；存在的每张表必须有全部三条固定基础链。

函数检查固定 inet 表和六条链的 type、hook、priority、policy；按每条链的原始规则顺序比较完整 JSON expression。语义摘要仅剔除数字 handle 和已知 libnftables 版本元数据，所有权身份摘要保留每个对象的 handle。实际与期望必须同时满足语义和 handle 精确相同，所有对象必须提供 handle；同名同规则但被删除重建的对象不能沿用旧基准。表或链的 comment、flags、新对象类型、额外链、额外规则或表达式字段均不会被忽略。表达式对象属性顺序不影响比较，数组顺序仍然影响比较。

表达式无需另写一份 nft 编译器：期望 AST 必须来自固定 renderer 源码的可信内核提交输出或隔离环境加载后的内核读回。任何不认识的顶层对象或属性都拒绝；表达式内的所有属性完整保留，只能与可信编译结果逐字段匹配。这里没有把未知表达式解释成安全行为的白名单。

v1 有意要求独占 nft ruleset：所有 foreign nft 对象均拒绝，包括其他 family、空表、flowtable、额外 CT mark/packet mark 修改和 offload。该限制可能与发行版防火墙管理器、容器网络或其他网络服务不兼容；执行器不能通过清理它们来使预检通过。

IPv4 RPDB 仅允许三个标准无条件内建规则，以及 plan 指定的三个精确 fwmark/mask/priority/table 规则；return 规则额外要求精确 iif 与目标地址。重复、未知 selector/action、占用相同 priority 或额外 foreign 规则都拒绝。`rules` 的 `absent`、`partial`、`complete` 分别要求没有本模块规则、允许合法规则子集、要求三条齐全。

先安装 RPDB、再启动核心创建 TUN 时，内核可能为 return 规则输出 `iif_detached: null`。只在 return 规则的所有 selector 精确匹配且路由阶段为 `partial`、`prepared` 或 `retained` 时接受这个注记；`active`、其他规则及非 null 值一律拒绝。

三个专用路由表只允许 plan 中精确匹配的路由，包括 protocol 186（iproute2 的标准名称 `bgp`）、metric、目标、下一跳、接口、首选源和 scope。无下一跳的 capture 路由要求内核默认的 link scope。`routes: partial` 允许任意合法子集，供每条命令前后检查；`prepared` 和 `retained` 要求三个黑洞及四条 egress/return 路由，禁止 capture 路由；`active` 额外要求 TUN capture 路由；`absent` 要求三张表为空。builtin local/main/default 表只接受有限普通路由字段，不允许 multipath、nhid、封装、未知 flags 等属性。专用 TUN 在这些表中只允许固定 `198.18.0.1/30` 地址带来的精确 kernel connected/local/broadcast 路由，协议、前缀、首选源、scope 和 table 都必须匹配，不允许额外 metric 或 gateway。priority-zero local 表只接受 local/broadcast 类型，不能通过 unicast 路由提前绕过 fwmark 规则；其 local/broadcast 前缀也不得覆盖受保护客户端地址。

函数返回已验证的 rule priorities、route IDs 和摘要。`nftSha256` 表示 nft 语义，`nftIdentitySha256` 额外包含 handle；`sha256` 表示 plan 约束下的本模块存在状态及这两个 nft 摘要，不代表完整主机网络配置摘要，必须和 plan hash 一起绑定。返回值只能证明这次输入在结构上匹配期望，不能单独证明资源属于本进程。

## 可信基准与所有权

[libnftables 官方文档](https://git.netfilter.org/nftables/tree/doc/libnftables.adoc) 将 echo 定义为成功提交至内核之后回显变更。`nft -c -e -j` 不构成已提交内核事实，也不能被当作跨版本稳定的源码到 list AST 编译接口。真实提交的 `-e -j` 输出可以作为同次可信固定批次的参考来源，但执行器仍须确认整个子进程已成功退出、输出完整、echo 对象和数量覆盖预期批次，并立即用独立 list 命令精确回读。

执行器必须在 root 私有且祖先目录可信的位置保留 receipt，至少绑定 boot ID、network namespace 身份、plan hash、renderer/工具身份、mode、可信 nft 基准以及专用 RPDB/route 资源清单。目录/文件所有者、权限、硬链接/符号链接、原子写入及锁都属于执行器职责。仅凭表名、chain 名、protocol 或 comment 不能认领已存在资源；首次安装只能在确认不存在后创建，重启后的已存在资源必须和受保护 receipt 精确匹配。

`nftSnapshotFromEcho(previous, echo, updates)` 将成功提交的 JSON echo 合成为下一份完整期望 snapshot。每次 update 指定固定表、create/replace 以及从可信 renderer 源码独立计算的每链规则数量。create 必须准确回显一张表和三条链；replace 只能回显新规则，不允许增加表或链。函数保留之前核验过的 table/chain 定义，撤下目标表旧规则后按 echo 顺序放入新规则，要求各链规则数量完全匹配。非目标对象、缺少规则、多出的规则、未知操作均拒绝。可选 flush echo 只允许目标表的固定链；没有 flush echo 不能替代执行器对实际固定批次包含三条 flush 的检查。

执行器必须验证具体 nft 版本和调用方式确实提交并生成 JSON echo。部分版本的 `-j -f` 配合原生文本输入会成功退出但没有提交；退出码零和空 stdout 不构成成功。可用固定 renderer 将文本批次转为一个无换行的命令 argv，经不使用 shell 的命令执行器调用 `nft -j -e <batch>`，并在确认完整 echo 后立即独立 list。参数长度应受限、拒绝超限且不得写入日志。这里不执行命令，也不会为失败的 JSON echo 自动降级为从当前 list 自行建立期望值。

已知 nft 1.0.x 的匿名 literal set 在链替换时可能出现 echo 缓存成员重复或类型污染，而独立 list 中的成员正常。正式 renderer 因此只输出标量规则：TCP/UDP 和正向 IPv4 集合展开成连续规则，负向目的地址集合保留在同一条规则里，变为两条 `!=` 的 AND。此处理只作用于固定 renderer 的内部语法，不解析用户 source，也不从 list 反向修正 echo。若无 set 的真实 echo 与 list 仍不一致，执行器必须拒绝，不得继续建立基准。

receipt 应在 mutation 前记录待执行意图，并在命令已 settled 且独立内核读回成功后记录新状态。中途 crash、输出截断、receipt 写入失败或基准不完整时不得根据目前看到的规则生成新的“期望值”自我证明。执行器必须保持 blocked 或进入需人工处理的 fault。receipt 与读回之间仍需要单一授权写入者；本纯函数不能消除其他拥有 CAP_NET_ADMIN 的进程与验证/写入之间的竞态。

当前受限资源 session 只维护进程内基准；启动时仅接受本模块资源完全不存在的状态，不能从外部 JSON 或同名资源认领所有权。它不提供跨进程恢复、持久 receipt adoption 或真实服务安装。上述持久协议、未知命令收敛和服务生命周期完成之前，不能将这个 session 描述为完整生产执行器。

IPv6 RPDB、XDP、tc/eBPF、legacy iptables、其他 namespace、接口/TUN、sysctl、邻居、核心身份和真实 DNS/TUN 流量证明不在本函数输入中。正式执行器必须另外验证适用的平台边界，不能以这三个 JSON 命令推出整条路径已安全。

所有错误统一为 `NETWORK_READBACK_INVALID`，不附带输入、属性路径、命令输出或嵌套 cause。JSON 大小、深度和节点数量有界，重复键、原型键、unsafe integer、getter 和 proxy 输入均拒绝。
