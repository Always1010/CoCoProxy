# 安装后的初始化、持久运行与维护

统一入口提供本机生命周期操作，远程部署器也可在目标主机调用相同入口。每次操作都需要原安装的 root 私有部署输入；入口重新生成文件计划，与完成状态的安装收据逐项核对路径、UID、权限和内容摘要，并验证整个已安装发布。未知安装、文件变化、额外 unit 覆盖或未完成安装均拒绝接管。

管理入口验收可使用[五项独立证据报告](setup-management-evidence.md)的 `management-report` 命令，分别记录 HTTPS、登录、终端证书信任、浏览器通知能力和测试通知实际显示。机器观察与人工记录分开，缺少证据不视为通过；该报告不替代下列动作的原有确认条件。

## 查询首次部署进度与下一步

在目标 Linux 的 root shell，用原安装私有输入查询；`SOURCE` 指已核验载荷或已安装发布内的 `source` 目录：

```sh
node --experimental-strip-types "$SOURCE/apps/setup/main.ts" status \
  --input /absolute/private/deployment.json
node --experimental-strip-types "$SOURCE/apps/setup/main.ts" status \
  --input /absolute/private/deployment.json --evidence /absolute/private/first-observations.json
```

`status` 不创建目录、写记录、初始化管理员、恢复事务、启动/启用服务或操作路由器。它重新核验安装收据、文件、发布和账号，以服务 UID 调用现有 CLI 的只读状态入口，并查询 systemd 当前状态及开机启用意图。核心观察复用 `runtime-status`，包含固定的本机回环控制器只读请求和本机核心版本检查；因此它不是绝对零 socket 操作。它不会向管理 origin、路由器或外网发送探测，也不会自动打开浏览器、发送测试通知或更改信任库。单独需要管理 origin 的机器 HTTPS 检查时，仍使用 `management-report --probe-https`。

报告分列安装、管理员、管理服务、首次配置、核心、路由器、终端和持久运行，并保留管理入口的五项独立结果。`completed` 是当前机器观察与匹配人工记录满足的项目，`pending` 是仍待处理的项目；`currentWait` 给出首个等待项及固定原因码，`next` 给出具体操作。后续独立项目仍继续观察，例如核心读取失败不会遮蔽持久意图。管理员合法不证明能登录，active 候选不证明核心健康，服务 active 不证明 HTTPS 或证书信任，持久 enabled 不证明冷启动稳定。

没有安装时，下一步指向 `install` 预检；发现中断、锁或未完成记录时先 `inspect`，只有已经写齐的安装事务才可审阅 `recover`。文件/输入/归属漂移则要求核对，不自动接管。已有自动生命周期处于 enabled 且未暂停时，启动管理服务的指引会先要求预览并显式执行 `pause-maintenance`，再处理管理服务，最后重新验收与恢复，避免直接调用被原约束拒绝的启动动作。所有动作仍遵守下面的摘要审阅和显式实施规则。

## 记录当前部署范围的人工观察

`--evidence` 使用下面的私有外层结构；这与单独 `management-report` 的证据文件有别。四项 `binding` 必须复制当前 `status` 的对应摘要，不能用真实地址或秘密代替。`management` 直接放入[原五项管理观察结构](setup-management-evidence.md#记录指定终端的观察)，其内层 `binding` 复制报告的 `managementBinding`；保留该结构的原校验，不可改成任填的 pass 布尔值。

```json
{
  "schemaVersion": 1,
  "binding": {
    "deploymentSha256": "<当前安装收据摘要>",
    "configurationSha256": "<当前部署输入摘要>",
    "activeGeneration": "<当前活跃候选摘要，首次配置前为 null>",
    "administratorSha256": "<当前管理员文件摘要，未初始化时为 null>"
  },
  "recordedAt": 1700000005000,
  "router": {
    "scope": "configured-lan", "observedAt": 1700000003000,
    "parametersMatched": true, "deliveryEnabled": true,
    "independentDisableVerified": true
  },
  "terminal": {
    "scope": "managed-clients", "terminalIds": ["terminalA", "terminalB"],
    "observedAt": 1700000004000,
    "proxy": true, "direct": true, "dns": true, "localAccess": true
  }
}
```

示例只表示格式，必须实际观察后填写。时间为真实 Unix 毫秒，不能填未来值，观察时间不能晚于记录时间；未做的整项省略。`router` 表示已人工核对当前配置对应 LAN 的两端参数、开启交付并验证独立关闭入口；它不证明适配器机器查询或通用路由器配置能力。`terminal` 只覆盖列出的短别名及四项检查，不覆盖所有终端。范围变化或增加终端须重新观察；终端真名、IP、MAC、口令、Cookie、订阅和自由文本均不应填入文件。

首次尚无 active 候选时，匹配的 HTTPS、登录和证书观察可以先通过，`next` 随后指向首次配置；路由器与业务终端观察必须绑定非空的当前 active 候选。安装收据、部署输入、活跃候选或管理员字节任一改变，旧人工记录降为 `unknown` 并要求复验。报告结束前还会复核安装与绑定状态，观察期间有变化则取消受影响的通过结论。旧单 action journal、`--terminal-path-verified` 或上次的成功布尔值都不能把整条流程标为完成。

人工记录保留原绑定、限定范围、终端别名和观察时间，属于历史自报观察。工具不因经过一天就要求重复验收；同样，摘要未变不能证明浏览器权限、终端信任或外部路由器此刻没有变化。证书轮换、终端/浏览器/系统或交付范围发生变化后，应重新观察并替换相应记录，不继续借用旧结论。

通知是可选能力：选择使用时，必须分别观察浏览器能力和操作系统实际显示测试通知；服务接受不算显示。不使用通知时，在 `management.notifications` 中明确填 `"declined"` 并省略 `notification`，两项未执行的通知检查可以为 `not-applicable`。若提供了真实 browser 失败观察，报告仍保留失败，不能以未选通知掩盖它。无需先启用通知才能使用其他部署功能；`status` 的证据报告不改变持久运行原有的终端确认门槛。

`evidenceComplete: true` 只表示这份报告要求的当前机器观察与绑定人工记录齐全；`next` 随后指向独立外部验收。它不宣称干净首装、冷启动、断线恢复、所有终端或长期稳定已经验证，也不自动授权持久启用。真实结果文件只保存在操作者选定的私有位置，默认不保存或复制；报告不输出 origin、私有配置、凭据内容或真实网络目标。

## 预览与显式实施生命周期动作

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
