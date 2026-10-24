# 网关运行监测与停止恢复

`NetworkWatchdog` 是特权 helper 同一进程内的持续检查组件。它只接受实际 `NetworkCoordinator` 实例，通过协调器的唯一文件锁执行检查与阻断；没有自动 apply、核心重启、DIRECT 回退或路由器操作。

必须复用处理应用请求的同一个协调器实例，否则历史 ready 不具备内存中的激活身份。典型接入顺序为：

```ts
const coordinator = driver.coordinator();
const watchdog = new NetworkWatchdog(coordinator);
await watchdog.start();
// 此后才接收经认证的请求，并在同一个 coordinator 上执行显式 apply。
// 服务关闭时先停止接收新请求并等待已有请求结束。
await watchdog.stop();
```

`start()` 先执行显式 `recover()`，将历史启用状态恢复到 blocked；新安装没有 journal 时不初始化目录。只有这一步成功后才启动循环。它不恢复历史 active，操作者仍需显式应用。重复 start、启动／停止重叠及上次停止未完成均拒绝。

循环调用 `checkActive()`，一次完成后再等待默认 2 秒；部署代码可以选择 100～30,000 ms 的间隔。没有 `setInterval` 重叠，也不因耗时超过间隔而追赶并发执行。检测延迟包括本次有界观察时间和调度间隔，不声明即时故障检测。与其他请求争用锁时只记录 busy 并等待下一轮；健康失败由协调器按已收敛／未收敛分类处理，循环不擅自恢复或重新激活。blocked/fault 后继续读取状态，等待明确的恢复／应用操作。

`snapshot()` 返回冻结的 `{ running, status, observation, error }`。status 只表达历史意图和状态；当前就绪来自独立 observation，最多保留 30 秒，时钟倒退也立即撤销。异常只返回固定错误码，未知原文、cause、路径及进程身份不进入快照。成功检查不为每轮更新持久 journal 或 revision。

`stop()` 先中止间隔等待并等待当前检查完成，再显式恢复 blocked 和停止核心。只有恢复成功才返回成功；不能只清掉计时器就报告安全停止。失败时撤销就绪观察、保留固定错误，并拒绝再次 start；调用方解决原因后可显式重试 stop。已成功 stop 再次调用不重复写入。停止监测不等于用户关闭代理，也不解除 guard 或要求路由器恢复直连。

此组件仍须由实际 helper 启动和监管。Node 进程被强制终止时无法运行 stop，部署必须提供独立的停核／失效绑定；管理服务及其 cgroup 消失也须由服务依赖和实际恢复联合验证。不能把进程内循环当作断电、helper 被杀或 systemd 生命周期的独立保护。完整关闭接管、跨 boot 恢复及真实生产服务故障验收仍待完成。

`test:network-watchdog` 在 Linux 使用真实协调器、文件锁和 journal，网络及核心为显式 fixture。它验证启动恢复、短期观察、运行故障阻断、未知命令屏障、没有自动重新激活、成功停止的幂等性，以及停止失败不得宣称成功。测试不安装服务或修改主机网络。
