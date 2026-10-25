# systemd 核心运行适配

本模块把[配置事务](../transaction/README.md)接到固定 `coproxy-mihomo.service`，支持 loopback 显式代理及可信设置启用的原生网关。核心就绪只表示身份与 controller 核验，不证明终端路径。部署操作见[部署与维护](../../docs/deployment.md)。

## 部署计划

`renderRuntimePlan(input)` 返回 `{unit, settings}`，只生成数据。必填字段为 `schemaVersion: 1`、`stateDirectory`、`binaryPath`、`binarySha256`、`systemctlPath`、`nodePath`、`sourceDirectory`、`settingsPath`、`unitPath`、非零 `serviceUid`；可选 `automaticGateway`，拒绝未知字段。输入见[显式合成样本](../../examples/runtime-deployment.json)。

路径为规范 POSIX 绝对路径，拒绝控制字符与被 ProtectHome 隐藏的 /home、/root、/run/user。unit 固定名为 `coproxy-mihomo.service`，`unitSha256` 覆盖完整 UTF-8/LF 字节。核心摘要必须是审核过的解压后二进制 SHA-256。CLI `runtime-plan` 仅写指定的新私有计划，不安装文件。

| 模式 | unit 行为 |
| --- | --- |
| 共用 | 非 root UID，Node 启动器，Restart=on-failure、KillMode=control-group、ProtectSystem=strict、ProtectHome、PrivateTmp、NoNewPrivileges、UMask=0077；无 ExecReload |
| 显式代理 | 不授予网络 capability |
| 原生网关 | 仅 CAP_NET_ADMIN/CAP_NET_RAW、开放 TUN；Requires/After/BindsTo 依赖独立网络 unit，由其准备 guard／出口／回程 |

ReadWritePaths 只允许状态目录；Install 段仅描述显式 enable 的目标。systemd 参数经独立转义，不通过 shell。完整管理与网络计划由[部署模块](../deployment/README.md)组合。

## 应用与恢复

`SystemdMihomoRuntime` 实现 validate/activate/confirm/restore，由事务引擎在共同锁内调用：

1. 核验候选摘要，以可信部署重编译；默认显式模式拒绝网关候选，原生模式只接受固定审核核心与相符网络设置。核验 unit、核心和运行状态后执行 `-t`。
2. stop，确认 MainPID=0、Job 为空、状态 inactive/failed，再持久写 selection 并 start。
3. 核对 selection、systemd PID、/proc 身份、argv、controller 监听归属与认证 /version，前后复核身份后确认。
4. 事务确认后持久提交 active。失败先停核，再恢复上一确认配置；首次应用则保持停止。停止或恢复无法确认时保留 fault，拒绝新 apply。

启动器以 `process.execve` 替换自身，保留 MainPID/cgroup，不创建第二个监管进程；只传固定 PATH/LANG 和私有 HOME。Node 22.x 的 execve 为实验 API，不支持时拒绝。持久 fault 阻止普通启动；仅 restoring 阶段允许启动该事务 previous，其他 pending 先 recover。

```sh
npm run cli -- runtime-status --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json
npm run cli -- runtime-apply --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json --generation <SHA256> --expected-active none
npm run cli -- runtime-recover --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json
```

上述路径为合成角色示例，实际服务控制须按已审阅部署执行。none 仅匹配首次 null；后续使用实际 active。历史 status.readiness 为 unknown，runtime-status.core 为实时 `core_only` 观察；无 active 返回 null，不初始化状态目录。

## 核心身份与受限观察

完整观察核验进程 exe/EUID/starttime/argv，以及该 PID 对所有匹配 IPv4 loopback controller LISTEN inode 的归属，再认证 /version。结果标记 `proc-exe-and-fd`。

原生 capability 可能使无特权管理进程读取 /proc exe/fd 被 PTRACE_MODE_READ_FSCREDS 拒绝。只有可信原生模式且明确 EACCES/EPERM 才允许受限观察：重新核验 root 所有、摘要一致且无 drop-in/待 reload 的 unit，固定 MainPID、四个 UID、启动时间、精确 argv、固定 cgroup、恰为 NET_ADMIN/NET_RAW 的 permitted capabilities、磁盘核心及候选摘要、认证 controller，并在末尾复核。

受限结果标记 `native-unit-and-controller`，不声称已证明 exe 或 FD。可读但不匹配、网络表读取失败和未知错误不允许降级。显式模式始终要求完整证据；不为此修改全局 ptrace/dumpable 或给管理进程 CAP_SYS_PTRACE。

## 操作边界与验证

unit、systemctl 及路径祖先须受可信身份控制；unit 无 drop-in、无待重载，FragmentPath/User 匹配。设置和状态为服务身份私有。核心只可由 root 或服务 UID 持有且不可被组／其他用户写入，流式核验摘要并复核文件身份。管理身份只获固定核心 show/start/stop，不接受通用提权。

systemctl 限时 15 秒、输出 16 KiB；客户端结束不代表 manager job 结束，适配器 stop 后最多两次核验，未收敛前不启动后继。controller 限时 1 秒、4 KiB、无重定向。确认目标 10 秒，但等待在途有界观察后总耗时可能更长；激活与恢复不通过 Promise.race 并行。

`npm run test:runtime` 覆盖证据、计划、启动器、受限观察与恢复；真实组件入口见[开发说明](../../docs/development.md#真实组件与隔离检查)，实机范围见[发行说明](../../docs/release-notes.md)。依据：[systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[execve](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)、[ptrace 权限](https://man7.org/linux/man-pages/man2/ptrace.2.html)。
