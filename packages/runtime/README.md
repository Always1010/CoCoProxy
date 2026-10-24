# systemd 核心运行适配

本模块把持久化配置事务接到固定的 `coproxy-mihomo.service`。它只支持当前编译器的回环显式代理配置，不授予网络管理能力，也不证明网关 DNS、接管或终端出口健康。生产默认实现没有模拟成功路径；测试通过显式代码注入替身，部署 JSON 不能替换这些函数。

## 部署输入与信任边界

`renderRuntimePlan` 的输入和输出见[计划说明](plan.md)及 `examples/runtime-deployment.json`。示例中的 SHA 是占位值，必须用已审阅的**解压后可执行文件**摘要替换，不能用压缩资产摘要。`runtime-plan` 只在显式输出路径创建包含 unit 文本和 settings 的私有 JSON，不安装服务，不覆盖已有文件。将 unit 落为系统文件时须保持 UTF-8、LF 与末尾换行，摘要覆盖这些完整字节。

实际安装前分别审阅 Node、源码、核心、账户、路径和控制权限。服务文件须 root 所有、不可由组或其他用户写入，无 drop-in、无待 daemon-reload 的修改；实际 FragmentPath 和 User 须匹配 settings。设置、状态目录、候选文件须为服务身份私有，路径祖先与所有链接目标须由可信部署控制。核心可执行文件只能由 root 或服务 UID 所有，拒绝组/其他用户写入；按固定摘要流式核验并复核文件身份。systemctl 仅执行 root 所有且不可被组/其他用户写入的规范路径。

管理事务的身份必须能读写该私有状态，并通过单独审阅的受限授权对**这一单元**执行 show/start/stop。当前代码不创建用户、不安装 polkit/sudo 规则、不自动提权，也不提供通用命令执行接口。不能为了运行 CLI 放宽状态文件权限或给管理服务任意 root shell。安装授权与真实环境验证另行完成。

## 应用、确认与恢复

`SystemdMihomoRuntime` 实现 `RuntimeAdapter`，由 `TransactionManager` 在同一跨进程锁内调用：

1. 校验不可变候选摘要，再重编译以证明当前回环监听、TUN 关闭和受保护字段约束；核验服务和既有核心，调用核心 `-t` 模式。
2. 显式 stop，并观测 MainPID 为零、Job 为空且状态为 inactive/failed，才持久化 `selection.json` 并 start。
3. 逐项确认 selection、systemd 的 PID/状态、`/proc` 的 exe/EUID/starttime/命令行后缀，以及该 PID 对所有匹配 IPv4 回环 controller LISTEN socket inode 的归属。只有随后带认证的 `/version` 返回合法版本且身份复核通过，才报告核心就绪。
4. 事务仅在确认后提交 active。启动或确认失败先停止，再选择上一代并重新确认；首次应用失败只确认停止并清除 selection。无法确认停止或恢复时，保留故障事务，禁止新 apply。

systemctl 客户端限时 15 秒、输出合计 16 KiB；超时终止客户端进程组并完成清理，但不能将客户端退出当作 systemd job 已取消。适配器显式 stop，并最多两次核验实际状态；不在未收敛的 job 上启动后继。controller 请求总时限 1 秒、响应上限 4 KiB，无重定向；确认循环目标 10 秒，当前在途的有界 systemctl/观察步骤先结束，因此整个调用可能超过 10 秒。没有用 Promise.race 令激活与恢复并发。

启动器通过 `process.execve` 替换自身，保留 systemd 的 MainPID/cgroup；systemd 是唯一失败重启者，不启动第二个 watchdog。它只向核心传递固定 PATH/LANG 和私有 HOME，不继承调用者的代理或加载器环境。持久 fault 阻止普通启动；显式 recover 已写入 restoring 时，仅允许选择该事务的 previous 代次，以免故障保护同时堵死恢复路径。进程崩溃留下的其他 pending 事务仍须执行 recover；网关层不得据核心启动就放行流量。

```sh
# 只有已完成独立安装授权、真实核心审阅和服务预检后才执行以下服务控制命令。
node --experimental-strip-types apps/cli/main.ts runtime-apply --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json --generation <SHA256> --expected-active none
node --experimental-strip-types apps/cli/main.ts runtime-status --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json
node --experimental-strip-types apps/cli/main.ts runtime-recover --state-dir /var/lib/coproxy --runtime-settings /etc/coproxy/runtime.json
```

后续 apply 的 expected-active 必须是读到的上一提交代次；none 只匹配 null。历史 `status.readiness` 仍为 unknown；`runtime-status.core` 是针对所列 generation 的独立实时观察，`scope=core_only`。无 active 时 core 为 null，不创建缺失状态目录。

## 验证范围

`tests/runtime-evidence.test.ts` 使用真实 Linux `/proc` 和 Node HTTP child 验证进程/端口归属、错代次、私有文件、超时和脱敏。`tests/runtime-plan.test.ts` 验证生成计划、exec 保持 PID、输入拒绝和 fault 恢复启动边界。`tests/runtime-systemd.test.ts` 用真实事务存储和显式假的 systemctl 验证提交、超时后残留 job、停止未收敛与拒绝不可信单元，命令包装器另用真实 Node 子进程验证限额。

这些夹具测试不安装或控制真实系统服务，不构成节点协议、WAN DNS 或网关验收。另有显式的 mihomo-live 测试，已验证固定核心的 `/version`、回环 HTTP 代理和 localhost DNS；实际 systemd 沙箱、服务授权与服务重启恢复仍待验证。Node `process.execve` 在所用 22.x 文档中仍为实验 API；不支持时启动器明确拒绝，不能退回第二个子进程监管器。

依据：[systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[systemctl job 语义](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html#--job-mode=)、[Node 22 process.execve](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)。
