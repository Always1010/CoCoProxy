# systemd 核心运行适配

本模块把[配置事务](../transaction/README.md)接到固定 `cocoproxy-mihomo.service`，支持 loopback 显式代理及可信设置启用的原生网关。核心就绪只表示身份与 controller 核验，不证明终端路径。部署操作见[部署与维护](../../docs/deployment.md)。

## 部署计划

维护协调可以使用 `runtime-maintenance-pause --state-dir <绝对路径>`，在事务共锁内暂停并返回本次的 `maintenanceRestore`。将该对象保存为服务身份所有的 0600 私有 JSON 后，通过 `runtime-maintenance-restore --state-dir <绝对路径> --input <私有JSON>` 恢复原 enabled/paused，原标记不存在时精确撤销本次新增标记。恢复凭据绑定暂停后的字节及文件身份；期间再次暂停、禁用或替换标记会使旧凭据失效。这两个入口仅操作受当前身份控制的私有状态，不读取核心版本、不启动服务、不操作路由器，适用于跨核心版本维护。它不替代停止服务或安装收据检查。

`renderRuntimePlan(input)` 返回 `{unit, settings}`，只生成数据。必填字段为 `schemaVersion: 1`、`stateDirectory`、`binaryPath`、`binarySha256`、`systemctlPath`、`nodePath`、`sourceDirectory`、`settingsPath`、`unitPath`、非零 `serviceUid`；可选 `automaticGateway`，拒绝未知字段。输入见[显式合成样本](../../examples/runtime-deployment.json)。

路径为规范 POSIX 绝对路径，拒绝控制字符与被 ProtectHome 隐藏的 /home、/root、/run/user。unit 固定名为 `cocoproxy-mihomo.service`，`unitSha256` 覆盖完整 UTF-8/LF 字节。核心摘要必须是审核过的解压后二进制 SHA-256。CLI `runtime-plan` 仅写指定的新私有计划，不安装文件。

| 模式 | unit 行为 |
| --- | --- |
| 共用 | 非 root UID，Node 启动器，Restart=on-failure、KillMode=control-group、ProtectSystem=strict、ProtectHome、PrivateTmp、NoNewPrivileges、UMask=0077；无 ExecReload |
| 显式代理 | 不授予网络 capability |
| 原生网关 | 仅 CAP_NET_ADMIN/CAP_NET_RAW、开放 TUN；Requires/After/BindsTo 依赖独立网络 unit，由其准备 guard／出口／回程 |

ReadWritePaths 只允许状态目录；Install 段仅描述显式 enable 的目标。systemd 参数经独立转义，不通过 shell。完整管理与网络计划由[部署模块](../deployment/README.md)组合。

## 应用与恢复

`SystemdMihomoRuntime` 实现 validate/activate/confirm/restore，由事务引擎在共同锁内调用：

1. 核验候选摘要，以可信部署重编译；默认显式模式拒绝网关候选，原生模式只接受固定审核核心与相符网络设置。核验 unit、核心和运行状态后执行 `-t`。
2. 默认 stop，确认 MainPID=0、Job 为空、状态 inactive/failed，再持久写 selection 并 start。仅手动组成员排序改变且符合下述条件时使用 controller 热切换。
3. 核对 selection、systemd PID、/proc 身份、argv、controller 监听归属与认证 /version，前后复核身份后确认。
4. 事务确认后持久提交 active。失败先停核，再恢复上一确认配置；首次应用则保持停止。停止或恢复无法确认时保留 fault，拒绝新 apply。

启动器以 `process.execve` 替换自身，保留 MainPID/cgroup，不创建第二个监管进程；只传固定 PATH/LANG 和私有 HOME。Node 22.x 的 execve 为实验 API，不支持时拒绝。稳定状态及已持久提交的事务只允许启动 active；未提交事务必须以 ownerToken 绑定仍存活的共同锁持有者，并核对 Linux boot ID、PID 启动时间及非僵尸状态。activating/confirming 只允许 target，restoring 只允许 previous，显式 recovering-target 只允许对应 target；validating/fault 拒绝启动。候选加载前和 exec 前分别复核，exec 前还复核 selection。旧未提交记录缺少 ownerToken 或原操作者已退出时必须先 recover，不能凭残留 selection 自动重启。

持久运行由服务身份私有的 `stateDirectory/lifecycle.json` 明确启用，格式为 `{ "schemaVersion": 1, "enabled": true, "paused": false }`。缺失标记保持原有行为，不自行启用；损坏标记拒绝启动。`setRuntimeLifecycle` 与应用、恢复及控制变更共用事务锁，遇到活锁最多等待 60 秒，成功暂停后在途协调已经结束。管理进程只在 `enabled && !paused` 时每 5 秒串行协调已提交 active：先恢复 pending，再核验网关前置资源，保留健康核心，让 systemd 完成已有 job，必要时通过固定 unit 恢复 active。依赖暂时不可用时持续重试，不应用 desired 或工作区草稿。systemd 仍是唯一持有和监管核心进程的组件。

维护前执行 `runtime-pause`，再按部署流程停止服务；暂停持久化并由启动器在候选加载前及 exec 前核验，重启主机也不能绕过。`runtime-disable` 写入 `enabled:false, paused:true`，不会立即停止现有核心或撤销路由器交付；此后再次启动须先 `runtime-enable`，或在仍已启用时 `runtime-resume`。`runtime-lifecycle-status` 只读标记。持久部署只 enable 管理与网页入口，由管理恢复核心，不需要单独 enable 核心；路由器明确关闭交付后，网关核心继续运行也不会替路由器重新开启交付。

手动节点热切换仍经过不可变候选、共同锁、active CAS、`-t`、激活、观察及持久提交。只有现有 `select` 组的同一成员集合重新排序，且其他配置完全相同、`profile.store-selected=false` 时才可跳过 stop/start；第一成员表示持久选择。修改节点、规则、DNS、组属性或成员集合仍走完整重启。先核验旧进程，再以认证 loopback PUT 更新变化组，使用一次认证 `GET /proxies` 核对目标全部手动组的真实 `now`。

热切换将目标 generation 与一个固定物理进程的 base generation、PID、Linux boot ID、启动时间原子写入私有 selection。回执不累积历史链；观察仍检查可信二进制、unit、UID、argv、controller 归属与认证及前后进程身份。只有身份严格匹配且 base/目标配置仍只差选择时，才允许 argv 保持 base 候选。核心正常重启会按 selection 启动目标候选，旧回执不能授权其他进程使用旧 argv。部分 PUT 失败、进程中途重启或目标回读不符，均通过既有恢复流程 stop/start 上一代；未提交时管理进程崩溃同样恢复上一代。已持久提交后崩溃保留目标，启动授权规则不变。

```sh
npm run cli -- runtime-status --state-dir /var/lib/cocoproxy --runtime-settings /etc/cocoproxy/runtime.json
npm run cli -- runtime-apply --state-dir /var/lib/cocoproxy --runtime-settings /etc/cocoproxy/runtime.json --generation <SHA256> --expected-active none
npm run cli -- runtime-recover --state-dir /var/lib/cocoproxy --runtime-settings /etc/cocoproxy/runtime.json
```

经显式配置迁移后，旧候选可能已不匹配当前部署。普通恢复仍优先恢复前一代；若它进入 `RESTORE_FAILED`，操作者应保持路由器交付关闭并核查故障事务及目标，再显式运行 `runtime-recover-target --state-dir <状态目录> --runtime-settings <当前运行设置> --generation <故障事务目标摘要> --expected-transaction <故障事务ID>`。该入口只允许匹配当前故障的原目标，重新校验不可变候选、实际激活并确认核心后才提交；校验、启动、确认失败或操作中断都保留故障记录，不根据 selection 文件推断成功。

上述路径为合成角色示例，实际服务控制须按已审阅部署执行。none 仅匹配首次 null；后续使用实际 active。历史 status.readiness 为 unknown，runtime-status.core 为实时 `core_only` 观察；无 active 返回 null，不初始化状态目录。

## 核心身份与受限观察

完整观察核验进程 exe/EUID/starttime/argv，以及该 PID 对所有匹配 IPv4 loopback controller LISTEN inode 的归属，再认证 /version。结果标记 `proc-exe-and-fd`。

原生 capability 可能使无特权管理进程读取 /proc exe/fd 被 PTRACE_MODE_READ_FSCREDS 拒绝。只有可信原生模式且明确 EACCES/EPERM 才允许受限观察：重新核验 root 所有、摘要一致且无 drop-in/待 reload 的 unit，固定 MainPID、四个 UID、启动时间、精确 argv、固定 cgroup、恰为 NET_ADMIN/NET_RAW 的 permitted capabilities、磁盘核心及候选摘要、认证 controller，并在末尾复核。

受限结果标记 `native-unit-and-controller`，不声称已证明 exe 或 FD。可读但不匹配、网络表读取失败和未知错误不允许降级。显式模式始终要求完整证据；不为此修改全局 ptrace/dumpable 或给管理进程 CAP_SYS_PTRACE。

## 操作边界与验证

unit、systemctl 及路径祖先须受可信身份控制；unit 无 drop-in、无待重载，FragmentPath/User 匹配。设置和状态为服务身份私有。核心只可由 root 或服务 UID 持有且不可被组／其他用户写入，流式核验摘要并复核文件身份。管理身份只获固定核心 show/start/stop；原生网关额外仅获固定网络 unit 的 start/reload，不接受通用提权。

systemctl 限时 15 秒、输出 16 KiB；客户端结束不代表 manager job 结束，适配器 stop 后最多两次核验，未收敛前不启动后继。controller `/version` 限时 1 秒、4 KiB；组回读为一次限时 1 秒、最大 16 MiB／6016 个代理的请求，均无重定向。热切换 PUT 最多四个并发，启动新批次的预算为 3 秒，当前批次最多再耗时 1 秒；失败等待本批请求全部结束才恢复，防止迟到写入覆盖恢复结果。确认目标 10 秒，但等待在途有界观察后总耗时可能更长；激活与恢复不通过 Promise.race 并行。

`npm run test:runtime` 覆盖证据、计划、启动器、受限观察与恢复；`tests/runtime-selections.test.ts` 还以纯 Node 注入覆盖热切换、不相关配置重启、部分写入回滚、未提交崩溃恢复及进程身份失效，并以合成 loopback HTTP 核对认证、编码及一次完整回读。这些测试不代替 Linux/systemd 和真实核心验收。真实组件入口见[开发说明](https://github.com/Always1010/CoCoProxy/blob/main/docs/development.md#真实组件与隔离检查)，实机范围见[发行说明](../../docs/release-notes.md)。依据：[systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[execve](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)、[ptrace 权限](https://man7.org/linux/man-pages/man2/ptrace.2.html)、[Mihomo controller 实现](https://github.com/MetaCubeX/mihomo/blob/Meta/hub/route/proxies.go)。
