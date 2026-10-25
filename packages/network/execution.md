# 执行与资源回读

本页适用于[保留框架](README.md)，配置和阶段见[资源契约](contracts.md)，整体写入顺序见[协调与恢复](recovery.md)。生产组件要求受信Linux root与唯一操作者，不提供任意命令接口。

## 有界命令与持久屏障

`runNetworkCommand(binary,args,options?)` 仅接受Linux绝对可执行路径，无shell；最多64参数、每个16 KiB，无控制字符。stdin最多256 KiB且无NUL；空输入用/dev/null。环境只保留固定PATH/LANG/LC_ALL。

默认15秒、最多60秒，stdout/stderr合计默认1 MiB、最高4 MiB；只返回严格UTF-8 stdout，stderr不公开。超时、管道失败或超限先收敛进程组再返回。`NetworkCommandError.childSettled=false` 表示仍可能有后代，禁止并发恢复；进程已退出也要独立回读资源。此约束假定可信工具不脱离进程组，不是恶意程序沙箱。

`runFencedNetworkCommand(root,token,binary,args,options,scope?)` 要求外层先持久保存pending token与命令摘要并持有全局写锁。摘要为JSON数组 `[binary,args,input默认空串,timeoutMs默认15000,maxOutputBytes默认1048576]` 的SHA-256。token为16–96位字母数字／下划线／连字符，每token有固定receipt/result文件，不存原始参数和stderr。

启动顺序：

1. 固定Node worker建立独立session/process group，等待ACK。
2. 父进程读取boot、PID/starttime、UID、namespace、PGID/SID，持久同步start receipt后发ACK。
3. worker复核自己的receipt和IPC连接后执行工具。无receipt、父进程死亡或持久化失败不得执行。
4. 成功工具退出且整个group无后代后，worker持久写result再退出。TERM后300ms升级KILL整组；IPC断开、超时和失败走同一收敛路径。

result保存token、摘要、worker身份、ok、固定code及有界base64 stdout，属于私有状态。目录euid:0700、文件euid:0600且单硬链接，O_NOFOLLOW与前后inode/dev复核；祖先可信不可被其他身份写入，root sticky临时目录是受限例外。不支持与恶意同权限进程竞争；身份检查与信号没有pidfd原子绑定。

`inspectFencedNetworkCommand` 与 `settleFencedNetworkCommand` 返回：

| 状态 | 含义 |
| --- | --- |
| absent | 无start receipt，未获ACK；仍须以外层锁排除同token操作者 |
| settled | boot已改变，或同boot扫描证明整个PGID无存活成员 |
| running | leader、group和receipt身份吻合；settle可重验后发送TERM/KILL |
| uncertain | 身份／namespace不符、读取失败、leader消失但仍有成员；拒绝猜测或发信号 |

`readFencedNetworkCommandResult` 只在absent/settled后读取，复核token、摘要、身份、canonical base64与输出限制。start缺失却有result视为损坏。settled无result表示结果未知，不能重放非幂等变更。外层事务安全提交后才可按两个固定文件名回收并同步目录。

fixture必须显式提供外层user/net namespace证明，当前两者均不同；只放宽新user namespace下未映射root UID65534，输出仍fixture，不能由HTTP JSON创建。

## 资源凭据

`ResourceJournal(root,scope)` 保存native-resource-receipt.json，只提供存储和锁，资源真实性由session回读。scope在构造时固定。

| 方法 | 行为 |
| --- | --- |
| read | 不创建目录；校验私有单链接、有界严格JSON、plan／renderer／工具／boot／namespace绑定、阶段、资源清单和pending |
| exclusive | 共享私有文件锁，按需初始化0700目录与保留candidates；锁不替代revision CAS |
| write | 仅锁内调用，revision+1；调用方先读并核对当前revision，pending与旧state一次持久保存 |

写入依次文件同步、rename、目录同步，任一步失败使调用者会话失效；不能从旧内存推测落盘结果。锁owner未写完的崩溃或回收guard残留可能拒绝自动恢复。不同root的锁互不保护，同一网络域只能有一个authority。

生产目录及祖先root控制；fixture只接受受限映射与sticky临时祖先。receipt仅是受保护的历史凭据，不是当前ready或所有权的充分证明。

## 资源会话入口

`NativeNetworkSession.create(deployment,tools,directory?)` 首次只接受本模块nft/RPDB/专用路由完全不存在。directory启用持久模式；省略只保留进程内基准，不能用于生产恢复。production要求与PID1相同user/net namespace，工具在固定系统目录且路径／祖先root控制、无替代链接。

持久receipt绑定scope、boot、user/net namespace、工具真实路径／二进制SHA、renderer、完整plan和资源清单。重新打开必须先恢复blocked；不按同名、同配置或外部JSON认领资源。

| 入口 | 行为 |
| --- | --- |
| preflight(...,purpose='apply') | 严格只读，既有receipt与实际资源核验；不create、取初始化锁、推进revision、kill或恢复 |
| assertSettled | 独立证明旧group已退出或pending未获启动许可，不采纳历史完成布尔值 |
| purpose=recover | 仅额外允许先前拥有的capture路由准确消失 |
| purpose=settle | 只查旧操作来源／receipt绑定，允许可信worker仍运行，不要求变化中的资源匹配旧快照 |
| settlePending | 外层已持久settling fence后，锁内重验来源并仅收敛旧worker；不改网络／清pending／推进revision |
| openForUpdate | 无receipt则严格create；已有同保护范围receipt按旧deployment打开，先recoverBlocked |

只读结果包含scope、initialized、recoveryRequired、pending、revision、generation、planSha256与binding（absent/current/previous-generation），无原始输出。generation/plan始终描述目标，receipt仍按旧部署重建。读取末尾复核上下文；不预留未来状态，外层写锁仍必需。

方法阶段：

| 方法 | 结果 |
| --- | --- |
| installBlocked | 原子建立／切换两个表的blocked |
| prepare | 三个黑洞、三个RPDB、四条出口／回程，尚无TUN可接受精确return iif_detached:null |
| authorizeCore | prepared→core-only，调用方在使用前核验身份和socket |
| activate | 增capture再切active，使用前重核新鲜完整证据 |
| retainBlocked | 先blocked再撤capture，保留／补黑洞并回读 |
| recoverBlocked | 新持久会话先收敛、核验，再回blocked，不恢复历史ready |
| inspect | 独立回读阶段／摘要，terminalPath=unverified；待恢复会话拒绝普通操作 |

并发方法、任何命令或回读失败均使会话失效。每次mutation前持久旧state、pending token、操作和摘要，ACK后才执行；成功工具与独立回读后才提交state并清pending。

## 提交与回读

`verifyNetworkReadback(deployment,input,expected)` 是纯函数，输入应来自刚完成的：

```text
nft -j -n -a list ruleset
ip -j -4 rule show
ip -j -4 route show table all
```

expected.nft来自受信固定renderer的成功提交echo及既有受保护基准，不从当前待认领ruleset反推。首次不存在才创建，已存在资源必须匹配receipt。

| 对象 | 核验 |
| --- | --- |
| nft | 固定inet表、六条基础链及原顺序完整expression；全部对象handle、定义精确一致，属性顺序可变、数组顺序不可变 |
| 外部资源 | v1拒绝任何foreign nft对象、额外RPDB／自定义表；不得清理系统防火墙或容器网络来满足要求 |
| RPDB | 三个标准无条件内建规则和本计划三个精确规则；return额外iif与终端目标 |
| 路由 | protocol186（bgp）、metric、目的／下一跳／接口／源／scope匹配；absent、partial、prepared/retained、active分别约束清单 |
| builtin表 | 只支持有限普通字段，无multipath/nhid/encap；精确TUN connected/local/broadcast允许，local优先表不得以unicast或覆盖终端前缀绕行 |

return的iif_detached:null仅在partial/prepared/retained允许，active拒绝。prepared/retained要求三个黑洞和四条出口／回程，不含capture；active多一条capture。结构通过不能单独证明归属。

`nftSnapshotFromEcho(previous,echo,updates)` 要求create准确回显表、三链和每链预期规则数；replace仅允许新规则，保留旧表／链定义。缺项、超项、未知操作均拒绝，flush echo只能为目标固定链。成功echo后仍须独立list比较语义及handle。

兼容结论必须保留：

- nft1.0.9的 `--json --file` 配合原生文本可能退出0却未提交。session将固定批次转为单个无换行argv，调用 `nft -j -n -e <batch>`，上限16 KiB；先语法check，再实际提交及完整echo回读。
- 匿名literal set在replace echo可能成员重复／类型污染。renderer使用标量规则：TCP/UDP和正向集合展开；负向集合在同规则以多个!=做AND。不得从list修补坏echo。
- 每条ip操作前后回读，清单只认本会话实际操作；别人添加同配置条目也不能认领。handle防止同名删除重建沿用旧归属。

回读返回语义SHA、含handle身份SHA和本计划存在状态SHA，须绑定plan；不是全主机安全摘要。依据：[libnftables echo](https://git.netfilter.org/nftables/tree/doc/libnftables.adoc)。

## 恢复与代次迁移

pending恢复先证明worker group结束。nft只用成功持久echo重建下一期望，再与内核精确匹配；无echo而规则变动拒绝。IP只接受完整旧清单或该固定单步后完整清单，不采纳任意partial。采纳state和清pending原子保存，防止再次崩溃丢归属。

TUN消失可自动撤capture，这是唯一允许的已拥有资源缺失，且只能立即恢复blocked；其他缺失、污染、损坏receipt或未知操作均拒绝。

`rebind(target)` 仅持久blocked、无capture/pending时调用，锁内核验旧receipt revision及内核，重渲染新旧计划。只忽略generation与core binary/unit SHA，所有保护范围及实际renderer批次、IP步骤和cgroup绑定必须相同。原子更新deployment/plan/renderer SHA，不写网络、不授权新核心。旧实例被revision拒绝。

跨boot、namespace、工具二进制或保护范围不支持迁移；部分执行／缺失首次echo可需人工处理，不能删receipt认领资源。资源层允许忽略artifact摘要，不代表组合核心驱动支持artifact升级，限制见[恢复文档](recovery.md#驱动组合)。

## Helper HTTP

`serveGatewayHelper({port,tokenSha256},handler)` 只提供loopback HTTP边界，生产端口1024–65535；返回port和幂等异步close。fixture额外允许端口0。handler负责status、stage、apply、recover和版本约束，transport不部署驱动或获取订阅。

| 路径 | 请求 |
| --- | --- |
| GET /v1/status | 无正文 |
| POST /v1/candidates | policy，可选sources |
| POST /v1/apply | generation（64小写hex）、expectedRevision（非负安全整数） |
| POST /v1/recover | 空对象 |

HTTP/1.1、精确Host:127.0.0.1:port，Bearer明文64位小写hex；服务端只存其SHA-256并恒时比较。拒绝重复认证／Host／内容头；精确路径，无query、编码或尾斜杠，拒绝Origin/Referer/Sec-Fetch-*、升级、CONNECT、编码或chunked正文。

POST为application/json、规范Content-Length，≤1 MiB、3秒内读完，正文须等于JSON.parse后JSON.stringify，顶层精确字段。最多8请求，header16 KiB／接收5秒、keep-alive1秒、Connection:close。响应为有界JSON对象，≤1 MiB，禁止getter/toJSON/循环等，no-store/nosniff。过载503 NETWORK_HELPER_OVERLOADED，未知500 NETWORK_HELPER_FAILED，不透传原异常。

断开不取消已进入backend的事务；close停新连接、关闭空闲并等既有事务，不能强杀驱动。backend不结束则close继续等待，进程强制退出由上层生命周期负责。
