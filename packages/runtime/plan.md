# 生成受审阅的 systemd 部署计划

`renderRuntimePlan(input)` 是纯函数，返回 `{ unit, settings }`，不写系统文件，不调用
`systemctl`，也不安装、启动或启用服务。输入必须完整给出 `schemaVersion: 1`、
`stateDirectory`、`binaryPath`、`binarySha256`、`systemctlPath`、`nodePath`、
`sourceDirectory`、`settingsPath`、`unitPath` 和非零数字 `serviceUid`；可选 `automaticGateway`，不接受其他字段。
路径必须是规范的 POSIX 绝对路径。`unitPath` 的文件名固定为
`coproxy-mihomo.service`。核心二进制 SHA-256 固定到部署配置；返回的
`unitSha256` 覆盖完整服务文件的 UTF-8 字节，包括末尾换行。

服务文件通过独立的 systemd 参数转义处理空格、双引号、反斜杠、百分号和命令中的
美元符号，不经 shell 拼接执行。`ExecStart` 只执行显式指定的 Node.js 22.18+
及源码目录里的 `apps/runtime/launch-core.ts --settings <settingsPath>`，启用原生
TypeScript 类型剥离。输入中的换行、回车、NUL 和其他控制字符均被拒绝。

服务以指定的非 root UID 运行，由 systemd 负责失败重启和整个控制组的停止。
固定限制包含 `ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、
`NoNewPrivileges=true` 和 `UMask=0077`，只有显式状态目录被列入
`ReadWritePaths`。计划拒绝位于 `/home`、`/root`、`/run/user` 的源码、状态、
核心二进制、Node 和设置路径，避免这些路径被 `ProtectHome` 隐藏。
发布前必须将源码、Node、固定版本核心和设置文件放到受审阅的安装目录，再另行
取得系统安装授权；路径的祖先、链接目标和服务用户访问权限仍需部署审阅。
不要直接把个人开发目录当作服务安装目录。

部署者需预先创建可供服务 UID 使用的私有状态目录，设置文件仅允许该身份读取，
并保证服务能读取不可写的源码和二进制。当前计划不创建账户、不调整目录权限、
不修改机器依赖。`[Install]` 的 `WantedBy=multi-user.target` 仅描述显式启用时的
目标，不代表已经执行 `enable`。显式模式不授予网络 capability；原生模式仅授予
`CAP_NET_ADMIN/CAP_NET_RAW`、开放 TUN，并以 Requires/After/BindsTo 依赖独立网络单元。
网络单元准备 guard、出口和回程，Mihomo 管理自动接管；两种模式均无 `ExecReload`。

`runCore(settingsPath)` 仅在 Linux 且 Node 提供 `process.execve` 时运行。它核对
当前有效 UID、持久故障与恢复阶段、已持久化的选择、固定核心摘要和候选配置安全边界，创建私有核心
工作目录，然后执行 `execve(binary, [binary, '-d', home, '-f', candidatePath], env)`。
这直接替换启动器进程并保留 systemd 的 MainPID，不产生第二个守护或看门狗。
模块导入不启动核心，主入口只接受 `--settings <绝对路径>` 或静态 `--help`。
失败只输出包含固定错误码的 JSON，不输出路径、配置或控制器 secret。

`tests/runtime-plan.test.ts` 的启动验证在临时目录创建明确的 Node shebang 可执行
fixture，记录替换后的 PID 和参数；它不执行真实代理核心、不调用 systemctl、
也不访问设备。候选由编译器和文件存储生成，额外验证摘要错误、缺选择及启用
TUN 的配置及持久故障的普通启动被拒绝，同时允许显式 restoring 启动 previous。root 测试进程仅对可删除的 fixture 文件设置非 root 所有权，
随后以该 UID 启动 child。测试结束删除整个临时目录。
