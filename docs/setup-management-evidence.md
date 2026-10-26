# 管理入口的五项独立证据

使用已有统一入口检查部署输入并输出报告：

```sh
./cocoproxy management-report --input /absolute/private/deployment.json
./cocoproxy management-report --input /absolute/private/deployment.json --probe-https
```

第一条不联网、不写文件，未提供证据的项目显示 `not-run`。输入复用安装计划的完整校验，不需要启动服务或具备 root 权限才能整理报告；Unix 私有输入须归当前身份所有且不允许其他身份读取，Windows 使用仅当前用户可读的私有位置。报告只输出绑定摘要、固定解释、时间和终端别名，不输出实际 origin、配置、口令、Cookie 或推送订阅。需要保留时，由操作者明确选择私有保存位置；仓库内真实报告留在被忽略的 `.local/`，不进入发行载荷。

第二条显式从调用电脑的 Node 运行时请求配置 origin 下固定的 `/api/cocoproxy/health`，最多等待 5 秒、读取 2 KiB，不跟随跳转，不发送认证信息，不允许忽略 TLS 校验。只有可信 TLS、HTTP 200 及预期管理 health 内容都满足才通过；服务 `active` 不能代替该检查。自签名证书即使 SAN 和密钥匹配，也可能不被调用端 Node 信任。此处的 `scope: "invoking-node"` 只描述该调用进程，不代表手机或其他浏览器的信任。

报告固定分列以下项目，每项保留自己的 `status`、`code`、`reason`、`action`、`scope`、`subject`、`source`、`observedAt` 和 `binding`：

| 项目 ID | 通过所表示的准确范围 |
| --- | --- |
| `https-reachable` | 调用端 Node 的实际 TLS/health 探测通过，或操作者记录指定终端确实打开 HTTPS 页面；来源和主体分别标明 |
| `login` | 操作者记录指定终端完成登录、匿名 API 拒绝访问及退出 |
| `terminal-certificate-trust` | 操作者记录指定终端没有证书警告且没有使用证书例外；服务器证书检查不能替代该项 |
| `browser-notification-capability` | 操作者记录指定浏览器具备安全上下文、Notification、Service Worker、PushManager、通知权限及适用的主屏幕条件 |
| `test-notification-displayed` | 操作者记录本次测试已在指定终端的操作系统实际显示；推送服务 `accepted` 不等于显示 |

`pass` 表示该来源的限定观察满足要求；`fail` 表示明确观察到不满足；`unknown` 表示已有记录仍不足判断或绑定已变化；`not-run` 表示未执行/未提供该项证据。只有操作者明确未选择通知功能时，尚未执行的两项通知检查才能为 `not-applicable`。浏览器不支持、权限未开或测试未收到都不能记成“不适用”。报告不汇总为“全部可用”，也不改变[生命周期启用](setup-lifecycle.md)的既有约束。

## 记录指定终端的观察

实际完成操作后，可以把限定观察放在私有 JSON，通过 `--evidence` 交给报告：

```sh
./cocoproxy management-report --input /absolute/private/deployment.json \
  --evidence /absolute/private/terminal-observations.json
```

以下是合成结构，摘要必须替换为当前第一条报告中的 `binding`；时间为 Unix 毫秒，必须替换为实际观察/记录时间，不能填未来时间。`terminalId` 使用短别名，不需要设备真名、主机名、IP、浏览器指纹或访问身份。没有做的观察字段直接省略，不能补猜测值。

```json
{
  "schemaVersion": 1,
  "binding": {
    "originSha256": "<当前报告的 originSha256>",
    "configurationSha256": "<当前报告的 configurationSha256>"
  },
  "terminalId": "terminalA",
  "recordedAt": 1700000005000,
  "notifications": "selected",
  "https": { "observedAt": 1700000000000, "pageLoaded": true },
  "login": {
    "observedAt": 1700000001000,
    "authenticated": true, "logoutCompleted": true, "anonymousApiDenied": true
  },
  "certificate": { "observedAt": 1700000000000, "warningShown": false, "exceptionUsed": false },
  "browser": {
    "observedAt": 1700000002000,
    "secureContext": true, "notificationApi": true, "serviceWorker": true, "pushManager": true,
    "permission": "granted", "requiresInstalledApp": false, "installedApp": false
  },
  "notification": {
    "observedAt": 1700000004000, "testRequestedAt": 1700000003000,
    "providerAccepted": true, "displayedAt": 1700000003500, "notDisplayed": false
  }
}
```

`notifications` 可为 `selected`、`declined` 或 `undecided`。选择 `declined` 时不提供 `notification`，报告说明未选择该可选能力；它不能掩盖失败测试。若仍提供 `browser` 能力观察，报告保留该观察的真实判断，不强制覆盖成“不适用”。未观察推送服务是否接受时 `providerAccepted` 为 `null`；未确认操作系统显示时 `displayedAt` 为 `null`，尚不能判断时保持 `notDisplayed: false`，这会得到 `unknown`。实际测试并确认没有显示后设 `notDisplayed: true`，结果为 `fail`。不能同时声明已显示与未显示，显示时间也不能早于请求时间。

人工证据的 `source` 固定为 `operator-record`，状态由限定观察推导，文件不接受任填 `status: "pass"`、服务 active、SAN/密钥匹配、秘密或自由文本字段。**这仍是操作者自报记录，不是密码学证明；填写 JSON 本身不等于完成实体终端验收。** 浏览器能力可通过实际设置/能力检查和[通知操作](notifications.md)核对，实际显示仍须在该终端观察。多台终端分别记录，不能用一台的证据覆盖其他终端。

如果同时提供终端 HTTPS 观察和 `--probe-https`，`https-reachable` 主结果明确属于 `invoking-node`，指定终端的观察保留在 `additionalObservations`。两者结果不一致时不会相互覆盖，也不据 Node 失败否认浏览器的人工信任记录。没有机器观察的其他项目仍如实为未验或人工记录。

配置或 origin 的摘要不一致会将相关人工记录降为 `unknown`，保留原记录的绑定与时间，并提示重验。格式错误、未来时间、额外字段、矛盾记录会返回固定错误码，不回显私有原始内容。即使摘要相同，报告也只说明记录时的观察；证书轮换、终端信任/权限、浏览器或系统变化后需要重新验证。它不替代[完整部署验收](getting-started.md#9-部署验收与交给使用者)，也不自动发送测试通知、修改信任库或启用持久运行。
