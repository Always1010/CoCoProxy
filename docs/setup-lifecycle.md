# 安装后的初始化、持久运行与维护

统一入口提供本机生命周期操作，远程部署器也可在目标主机调用相同入口。每次操作都需要原安装的 root 私有部署输入；入口重新生成文件计划，与完成状态的安装收据逐项核对路径、UID、权限和内容摘要，并验证整个已安装发布。未知安装、文件变化、额外 unit 覆盖或未完成安装均拒绝接管。

| 操作 | 作用 | 额外输入 |
| --- | --- | --- |
| `initialize` | 创建管理员凭据；已有合法凭据保持原样 | 首次创建需要 root 私有 `adminInput`，格式为用户名和密码 |
| `start-management` | 启动管理服务及收据内的托管 HTTPS | 凭据已初始化；自动生命周期关闭或暂停 |
| `enable-persistence` | 启动早期 guard，启用管理与 HTTPS 的开机启动，作为服务 UID 执行 `runtime-enable` | 操作者明确确认终端路径已验收 |
| `pause-maintenance` | 作为服务 UID 执行 `runtime-pause`，等待现有事务协调结束 | 无路由器操作 |
| `stop-maintenance` | 暂停协调、停止并禁用部署服务、核验 PID/Job，然后用旧发布的 helper 移除有归属证明的网络资源 | 自动网关必须由操作者确认路由器交付已关闭 |
| `resume-persistence` | 恢复已启用的持久运行及管理服务开机启动 | 生命周期此前已启用；操作者确认终端路径 |

这些操作默认只读，输出动作列表及 `reviewedPlanSha256`。实施时必须同时提交 `--apply` 与上次审阅摘要；摘要绑定当前输入、完成收据、动作、操作者确认项、现有生命周期、凭据摘要及待执行步骤。终端或路由器确认是操作者提供的验收证据，不代表入口探测了终端或读取了路由器状态。入口不会操作路由器、申请证书、创建服务账号、安装依赖或变更主机信任。

以下示例中的 `SOURCE` 指已安装发布内的 `source` 目录，参数和目录均为占位。先预览，再将输出中的摘要填入同一动作：

```sh
node --experimental-strip-types "$SOURCE/apps/setup/main.ts" initialize \
  --input /root/private-deployment.json --admin-input /root/private-login.json
node --experimental-strip-types "$SOURCE/apps/setup/main.ts" initialize \
  --input /root/private-deployment.json --admin-input /root/private-login.json \
  --apply --reviewed-plan-sha256 <预览摘要>
```

管理员凭据通过受限密码派生函数产生，并以独占创建方式写入既有可信父目录，所有者设为服务 UID，权限为 `0600`。明文登录输入只在原私有文件和当次进程内读取，不复制到安装目录、日志或记录中。已有文件永不覆盖，损坏或归属不正确的文件要求单独修复。

实施期间入口持有安装器共用的 `install.lock`，并在获得锁后再次核对输入、收据、unit 和恢复锁。每个动作前先持久记录意图，完成后再记为完成；记录位于 root 私有部署收据目录中的 `lifecycle.json`。失败或进程中断会保留锁和动作记录，避免下一次安装把中间状态当作普通完成状态。

如果记录和锁能够证明属于同一动作、同一输入及安装收据，并确认旧进程已退出，可以重新预览并使用新的摘要明确继续。继续会重新检查当前状态并重放固定、可重复执行的停止、禁用或启动动作；之前的完成标记不能替代当前 PID/Job 核验。初始化只有在现有凭据与记录摘要完全相符时才认作已完成。网络 helper 若留有未完成回执则要求人工审阅，不自动再次移除。

未知锁、旧格式锁、记录不匹配、遗留恢复/认领锁或变更后的安装文件不会自动清理。现场排障仍须先使用[只读检查](maintenance-recovery.md)，根据实际证据处理，不能删除锁后盲目重试。生命周期操作保留业务状态和凭据，也不提供通用程序回滚。
