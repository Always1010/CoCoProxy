# 持久命令屏障

`runFencedNetworkCommand(root, token, binary, args, options)` 仅用于固定受信任的 ip/nft helper。调用方先在其事务日志中持久写入 pending token、预期步骤及 `fencedNetworkCommandDigest`，并持有全局 mutation lock。`root` 必须由特权 helper 固定选择，祖先可信，目录属于当前有效 UID 且权限为 0700；工具路径的授权与验证由调用方完成。本接口不是任意命令入口，也不是针对恶意程序的沙箱。

每个唯一 token 对应 `fencedReceiptName(token)` 和 `fencedResultName(token)` 两个固定文件。token 使用安全字母数字、下划线或连字符，长度 16–96；UUID 可直接使用。文件不保存命令参数、输入、原始 stderr 或系统错误信息。成功 stdout 可能含实际内核对象信息，因此仍属于私有事务状态；它以 base64 保存以限制 JSON 最坏体积。文件及目录遵循私有存储的原子替换与 fsync 规则，不自动删除。

目录路径必须为规范绝对路径，每个祖先逐级 `lstat`，拒绝符号链接、其他 UID 所有者与 group/other 可写目录；只有 root 所有的 sticky 临时目录可作为公共祖先。最终目录严格为 euid 所有且权限 0700。文件读取使用 `O_NOFOLLOW`，校验打开前 inode/dev 与打开后的 `fstat`，要求普通文件、euid 所有、权限 0600、`nlink === 1`，并在读取后再次检查。写入前后亦检查目录与目标文件，拒绝既有符号链接和硬链接。此边界建立在可信 root/euid 不恶意同时替换路径的部署前提上。

默认 scope 为 `'production'`。隔离 fixture 仅可由可信外层测试 supervisor 传入 `FencedCommandScope` 的 `{ scope: 'fixture', outerUser, outerNet }`，证明来源与 `NativeNetworkSession.fixture` 相同；该参数不能来自 HTTP 或客户端 JSON。run 的第六参数以及 inspect/settle/readResult 的第三参数均接受此 scope。父进程与 worker 分别验证外层 user/net namespace 字符串格式，以及自身两个 namespace 都与证明不同，之后才允许祖先上的 UID 65534 作为未映射 root；最终私有目录及文件仍必须归当前 euid。fixture 不产生生产身份，也不把 `/proc/1/ns` 的读取权限错误当作隔离证明。未给 proof、只换 user namespace 或只换 net namespace都不能启用例外。

父进程通过固定 Node worker 模块创建独立 session/process group。worker 等待 IPC ACK，父进程读取 `/proc` 身份，将 boot ID、PID、start time、user/net namespace、UID、PGID、SID、token、commandSHA 写入 start receipt，完成文件与目录 fsync 后才发送 ACK。worker 再读取同一 receipt、比对自己的身份并确认 IPC 仍连接，随后执行非 detached、无 shell 的受信任工具。start 持久化失败、父进程死亡或伪造的无 receipt ACK 均不能启动工具。

工具与后代必须留在 worker 的 session/process group，不能 `setsid`、改变 namespace 或逃逸到其他执行器；这由受信工具契约保证。worker 捕获 TERM，保持 leader 存活直到 300ms 后 KILL 整组。父进程 IPC 断开、超时、输出超限和工具失败都使用该终止流程。即使直属工具退出，worker 仍会检查残余 group 成员；有存活后代时不返回成功。stdout/stderr 共用输出限额，stderr 不落盘。错误只返回固定码，`NetworkCommandError.childSettled === false` 禁止后续恢复 mutation。

无输入或输入为空字符串时，工具 stdin 使用 `/dev/null`，避免快速退出的工具与空管道关闭之间的 EPIPE 竞态。只有非空输入才创建 stdin 管道；非空输入写入失败仍按命令失败处理，不能用工具零退出码覆盖输入传输错误。

成功工具退出后，worker 在自身退出前原子写入 result 并 fsync。result 包含 token、commandSHA、完整 worker 身份、ok、stdout 和固定 code；调用方能够在重启后恢复 nft echo 等证据，不能把缺失 result 当作“工具没执行”。`commandSHA` 使用 SHA-256，输入为 JSON 数组 `[binary,args,input默认空串,timeoutMs默认15000,maxOutputBytes默认1048576]`，不存储原始材料。

恢复使用 `inspectFencedNetworkCommand(root, token)` 或 `settleFencedNetworkCommand(root, token)`，状态为：

- `absent`：start receipt 不存在，ACK 未获授权，工具未执行。调用方必须先排除仍在运行的同 token 操作者，使用其事务锁完成串行恢复。
- `settled`：boot 已改变，或同 boot 的 `/proc` 全量扫描证明该 PGID 无存活成员；僵尸不能再执行 mutation。
- `running`：当前 UID/userNS/netNS 与 receipt 一致，活 session leader 身份完整匹配，且组内成员身份符合预期。settle 在发送每次信号前重新核验，依次 TERM、KILL 并重新扫描。
- `uncertain`：身份不符、namespace 不符、读取失败，或 leader 消失但仍有存活成员。接口拒绝猜测/信号并保留 fence，需明确排障或重启证明旧 boot 结束。PID 消失本身从不代表 group 结束。

`readFencedNetworkCommandResult` 只在 absent/settled 时返回结果，并验证 token、digest 和 worker 身份与 start receipt 一致。receipt/result 使用精确字段集合，拒绝未知字段、非规范 base64、非法 UTF-8、越界 stdout 与错误的成功/失败组合。不存在 start 却存在 result 时视为损坏并保留屏障，不允许同 token 重用。调用方仍须将 receipt/result 的 `commandSHA` 与其 pending 预期 digest 比对，随后做内核状态读回。成功 stdout 表示工具报告成功，不替代实际内核验收。已 settled 但无 result 表示执行结果未知；不能重放不幂等操作。事务 receipt 安全提交后，调用方可按导出的两个固定文件名删除该 token 的文件并同步目录；不得提前清除未解决屏障。

此实现依赖 Linux `/proc`、boot ID、namespace 身份及进程组信号。身份检查与信号间没有 pidfd 原子绑定，因此必须满足单一特权操作者、可信同 UID 软件与受信 helper 的部署前提；它不防御同权限恶意进程主动制造 PID/group 竞争。
