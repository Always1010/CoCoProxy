# 持久化配置事务

本模块提供离线候选存储和带恢复能力的事务状态机。systemd 生产适配见 [runtime](../runtime/README.md)，固定发行的实际验收范围见[发行说明](../../docs/release-notes.md)。事务提交、核心就绪与终端连通性分别观察。

## API

```ts
const store = new FileTransactionStore(absolutePrivateDirectory);
await store.stage(candidate);
await store.status();
const manager = new TransactionManager(store, runtimeAdapter);
await manager.apply(candidate.id, expectedActive);
await manager.recover();
```

`candidate` 必须是可信输入经过 `compileConfig` 生成的结果；内容 hash 只证明字节完整性，不是配置安全认证。`stage` 核对规范 JSON 的 SHA-256、拒绝修改已有候选，只保存文件，不调用适配器。候选最多 4 MiB。`manager.stage/status` 分别委托存储的同名方法。`status` 仅读取已有状态，目录不存在时返回空状态，不创建目录或修改权限。

`apply(id, expectedActive)` 使用严格 CAS：`null` 只匹配尚无已提交代次的状态。代次是候选内容 hash。存在未完成事务时，先调用 `recover`。公开状态只含 desired、active、事务 ID/阶段、fault 和 checkedAt，不包含配置；成功后的 readiness 仍为 `unknown`。checkedAt 是事务检查时间，不是对当前核心健康的观测。错误仅通过 `TransactionError.code` 暴露稳定代码，不透传适配器异常内容。

## 提交与恢复

应用顺序为持久化 validating、离线校验、持久化 activating、激活、持久化 confirming、确认。适配器确认成功后，原子写入 `active=target` 和 `pending.phase=committed`，这是唯一持久提交点；随后另行清理 pending。恢复见到该提交点只完成清理，不把已提交目标回滚。

其他未完成事务恢复到 previous，首次应用则调用 `restore(null, null)` 停止核心。恢复成功保留 desired 作为最近意图；恢复失败保留 pending 和 `RESTORE_FAILED`，清空公开 active 并报告 readiness=fault，禁止新应用。恢复可重试，适配器必须保证恢复操作幂等。

`RuntimeAdapter` 必须提供 `validate(path)`、`activate(path,generation)`、`confirm(generation)` 和 `restore(previousPath,previousGeneration)`。每次操作必须自行设置合理超时，并在返回错误前终止该操作的后续副作用。引擎不会通过 Promise.race 让尚未停止的激活与回滚并发执行。`restore` 只有在确认上一代已恢复、或首次应用的核心已停止后才能成功返回；无法确认必须抛错。适配器确认的含义、进程管理和健康检查均由实际集成实现。

## 文件和锁边界

stage/apply/recover 使用同一跨进程目录锁，活锁竞争返回 `STORE_LOCKED`。exclusive 回调取得本次随机 ownerToken；apply 将它写入 pending，恢复在实际恢复启动前绑定新的 token。Linux 启动器通过只读核验 token、boot ID、PID 启动时间和进程状态，拒绝已退出操作者留下的未提交启动意图，也不能借用无关写入的活锁。旧 pending 缺少 token 仍可读取和恢复，但不能直接启动；已持久 committed 不受锁释放影响。

Linux 仅在 boot ID、PID 启动时间或僵尸/退出状态能够证明原持有者已退出时回收锁；PID 存活、身份不明或元数据损坏均拒绝接管。锁目录刚创建但 owner 尚未写入时崩溃，以及锁回收保护目录持有期间崩溃，会保守阻塞；操作者必须先核验所有持有者已停止，再处理残留锁，不能仅凭文件年龄删除锁。

存储路径必须为绝对路径，其祖先目录由可信部署控制，不放在其他用户可任意替换目录项的位置。POSIX 下新目录为 700、文件为 600；已有目录或文件的 UID 必须与有效运行用户一致，暴露组/其他用户权限时直接拒绝，不自动修复所有者或权限。读取拒绝符号链接并检查文件句柄、限制大小。原子替换包含文件同步，Linux 还同步目录项。Windows 需要调用者预先提供私有父目录 ACL，且本模块不提供 Linux 目录 fsync 等价保证。测试中的模拟适配器只用于状态机验证，不能作为生产就绪依据。
