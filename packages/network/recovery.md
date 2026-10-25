# 协调与恢复

本页适用于[保留框架](README.md)，不是当前原生网关的运维流程。资源方法见[执行与回读](execution.md)，身份来源见[运行观察](observations.md)。

## 协调器与写入边界

`new NetworkCoordinator(privateRoot,trustedDriver)` 无默认替身或自动backend。生产服务固定唯一root，祖先root控制，目录0700、network-state.json0600，含完整部署输入。status只返回代次、revision、历史阶段和固定码，readiness为unknown/fault，不代表当前ready。

协调器复用跨进程锁、boot/PID starttime死亡核验与私有原子写；不同root互不保护。存储遵循文件fsync→rename→目录fsync，失败不报告成功；无owner或回收guard残留锁可能需人工核验，不能仅凭年龄删除。

`apply(deployment,expectedRevision)` 重渲染并冻结输入，CAS核对revision。已有journal的新实例先recover；恢复／应用门闩只对应该revision，其他写入或同步／锁释放失败会使其失效。每次driver mutation前持久unsettled:true，成功且收敛后才清除，不用Promise timeout放任旧操作继续写。

## 应用顺序

1. 完成只读预检。首次失败不记启用意图，也不改网络。
2. 持久保存启用意图，安装并回读blocked guard，再准备黑洞、规则、出口／回程，分类保持不激活。
3. 唯一核心管理器在阻断证明下选择并启动本代核心，独立核验unit、binary、PID/UID/starttime及cgroup。
4. 开core-only，取得同身份DNS/TUN、socket、链路／邻居、出口及已有资源证据。
5. 再次核验新鲜证据，加capture并切active，再独立验证active，才保存ready与本次短期localReady观察。

生产apply在存储初始化前强制两个不同的显式非root服务UID。身份含generation、完整planSHA、boot、核心PID/starttime/UID、binary/unitSHA、固定cgroup和完整kernelID，管理身份也同代绑定。证据≤30秒、无未来时间／混scope／未知字段；写fence后到实际授权前仍须driver重查。

启用后不得静默改终端、接口、MAC、UID、监听、mark、表／优先级、TUN等保护范围。协调器模型允许同保护范围generation和artifact摘要变化，但实际固定驱动对核心artifact还有更严格限制，见下节。

## 驱动组合

`GatewayNetworkDriver.production(settings)` 固定组合host、持久资源session、核心runtime、管理PID及完整观察，无backend注入；fixture工厂显式注入并保持fixture。通过driver.coordinator()取得唯一协调器。

设置提供四个不重叠且互不嵌套的目录：协调器authority、资源authority、核心runtime state和coreHome；锁顺序为协调器→单组件。runtime必须等于重渲染计划，plan绑定UID、binary/unit及独立管理UID，工具路径固定。DNS wildcard／预期地址、路由探测目的均来自可信部署。

驱动流程与协调器一致，补充约束：

- 已有资源每次重新核验并打开，必要时recoverBlocked；同保护范围更新先blocked、无capture，再rebind，不沿用失效缓存session。
- 管理PID来自固定unit，身份比较忽略观察时间但保留两服务全部身份与计划绑定。
- 完整active证据失败且已收敛可阻断／停核；未知错误丢弃缓存并保留fence，不能直接重试。
- 显式恢复不依赖待应用候选或host旁路检查成功，避免就绪条件失效反而堵住阻断；来源、资源归属和工具信任仍必须成立。
- 当前驱动只支持固定binary/unit下的配置代次迁移。不能用新artifact设置恢复旧authority；升级需先按旧配置安全收敛，再核验新部署。
- 不实现用户关闭后的直连恢复，也不操作路由器。跨boot、namespace及工具二进制迁移仍不支持。

## 运行检查

成功apply只在同一协调器实例内保留精确激活身份／证据与ready revision。`checkActive()` 持锁独立assertSettled，再观察身份，与最初核心及管理身份比对，最后verifyActive取得新证据。

成功返回 `{status,observation:{scope,localReady:true,checkedAt,generation,planSha256,terminalPath:'unverified'}}`；不写journal、不增加revision或历史updatedAt。旧激活时间只作身份基准，不要求它永久满足30秒；本次新观察必须满足时效。

| 情形 | 行为 |
| --- | --- |
| 健康且身份未变 | 返回新鲜短期观察 |
| 已收敛的健康／身份失败 | 先guard、保黑洞、撤capture／分类并回读，记NETWORK_HEALTH_FAILED |
| 未知／未收敛或assertSettled失败 | NETWORK_COMMAND_UNSETTLED，保fence，不并发contain |
| 无journal、blocked或fault | observation:null，不初始化或自动激活 |
| 新实例读到历史ready | 拒绝当作当前证明，要求recover再apply |

检查／contain／recover／通过预检的新apply及锁释放失败清除内存激活证明。未拿锁的busy、CAS／保护范围拒绝、已收敛的只读预检失败不撤销健康实例；未知预检异常撤销门闩。不得根据检查失败自动apply。

## 故障与显式恢复

启用后失败保持启用意图，不恢复旧active或DIRECT。只有先前操作已证明收敛，才可重申guard、保黑洞、撤capture并回读阻断。

driver仅以NetworkDriverError(true)或已收敛NetworkCommandError声明本次操作结束；未知异常和childSettled:false保留unsettled。某个失败调用已结束，不能替代对更早pending的独立证明。

`recover()` 对所有已有启用意图（包括历史ready）持同一锁执行：

1. preflight(plan,'settle')只读核验旧receipt、固定命令、worker/manager身份与上下文，允许已绑定操作仍运行，不kill或改网络。
2. 持久保存phase:settling、unsettled:true，再调用settlePending；只收敛已绑定旧操作，不能接收任意PID、启动业务或修复资源。
3. assertSettled独立证明全部工具／systemd job已结束，再preflight(plan,'recover')核验实际完整资源。
4. 重申并回读blocked，保留黑洞、撤capture／分类；各mutation仍先持久fence。

settlePending返回不自动清fence，保存的unsettled:false也不替代上述步骤。任一步来源不明或未收敛时拒绝后继写入。恢复只返回blocked，不生成激活证明；重新启用须显式apply、新revision和新证据。无journal的status/recover不初始化，损坏或跨scope不猜测修复。

## 核心持久监管

`GatewayCoreRuntime.production({runtime,coreHome})` 使用[旧unit与credential](contracts.md#旧框架核心unit)，固定root state、服务UID coreHome和审核binary/unit，必须由外层协调器调用。

| 方法 | 边界 |
| --- | --- |
| preflight(plan) | 只读核对设置、unit、journal、候选 |
| assertSettled() | 独立证明旧worker退出、systemd Job为空，不kill或清pending |
| preflightSettlement() | 不依赖候选，仅校验旧journal／receipt来源；可信running可进入settle |
| settlePending() | 外层fence后重验并收敛旧worker，等旧manager job约1秒自然结束；不发新stop/start、不取消job |
| ensure(plan,assertBlocked) | 校验候选及语法，证明blocked，收敛后stop；确认MainPID=0、Job空、inactive/failed、cgroup空，再写selected并重证blocked后start |
| recoverStopped(assertBlocked) | 证明blocked与旧操作收敛后只stop，不恢复ready |
| inspect() | scope、选择代次、pending、PID/job/cgroup、readiness:unknown，不代表真实配置或业务健康 |

assertBlocked是受信内部回调，不是HTTP布尔值；每次命令pending落盘后、执行前再次证明。核心锁与外层网络authority不同，不嵌套相同root。

gateway-core-state.json含revision、settingsSHA、选择代次和pending action/token/commandSHA/boot/namespace/UID。命令固定systemctl --no-ask-password --no-pager start|stop coproxy-mihomo.service，20秒／16 KiB，无shell。成功result与独立manager状态都核验后才清pending；命令文件尚无自动回收策略。

配置通过LoadCredential快照，≤1,000,000 UTF-8字节，在语法检查／stop／选择之前拒绝超限。核心无自动重启／enable。读坏journal不修复，持久写失败下次重读；不存在锁所需candidates时拒绝伪装只读收敛为初始化。

## 监测生命周期

`NetworkWatchdog` 与处理apply的同一协调器实例共存：

```ts
const coordinator = driver.coordinator();
const watchdog = new NetworkWatchdog(coordinator);
await watchdog.start();
// 接收经认证的请求；停止时先停新请求并等待已有事务。
await watchdog.stop();
```

start先显式recover，历史启用退回blocked，无journal不初始化；成功后启动串行checkActive循环，默认2秒、可设100–30,000ms。一次完成再等间隔，无setInterval重叠或追赶。busy等下一轮，blocked/fault只读等待显式操作。

snapshot返回冻结running/status/observation/error，观察最多保留30秒，时钟倒退撤销。stop等待当前检查，再恢复blocked并停核；失败不得报告安全停止或再次start，可排障后显式重试stop。

监测停止不等于用户关闭，guard不解除。进程SIGKILL/断电不能执行stop，仍需要独立服务失效绑定；该循环不提供掉电或完整systemd生命周期保证。组件测试与隔离路径的范围见[框架入口](README.md#验证范围)。
