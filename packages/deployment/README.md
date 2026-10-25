# 管理与核心的部署计划

`renderDeploymentPlan(input: unknown)` 是纯函数，组合 `renderRuntimePlan`，返回文件清单、目录、部署前提和操作步骤。它不读取凭据、不访问网络、不写系统目录或控制服务。默认生成回环显式代理计划；`runtime.automaticGateway` 显式启用原生网关时，另生成独立网络单元和 root 设置。终端路径须在实际部署后验收。

输入只接受有界的普通 JSON 数据。根字段固定为 `schemaVersion: 1`、`runtime`、`management`；未知字段、访问器、函数、非数据原型、循环引用和过大内容均被拒绝。无效输入统一抛出 `DeploymentPlanError`，错误码和消息均为 `DEPLOYMENT_PLAN_INVALID`，不包含路径或 secret。

```json
{
  "schemaVersion": 1,
  "runtime": {
    "schemaVersion": 1,
    "stateDirectory": "/var/lib/coproxy",
    "binaryPath": "/opt/coproxy/bin/mihomo",
    "binarySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "systemctlPath": "/usr/bin/systemctl",
    "nodePath": "/usr/bin/node",
    "sourceDirectory": "/opt/coproxy/source",
    "settingsPath": "/etc/coproxy/runtime.json",
    "unitPath": "/etc/systemd/system/coproxy-mihomo.service",
    "serviceUid": 12345
  },
  "management": {
    "origin": "https://management.example",
    "listenPort": 13000,
    "serviceUser": "coproxy",
    "serverEntry": "/opt/coproxy/server/.output/server/index.mjs",
    "settingsPath": "/etc/coproxy/management.json",
    "credentialPath": "/etc/coproxy/admin.json",
    "unitPath": "/etc/systemd/system/coproxy-management.service",
    "policyPath": "/etc/polkit-1/rules.d/50-coproxy-management.rules",
    "deployment": {
      "mixedPort": 17890,
      "controllerPort": 19090,
      "controllerSecret": "SYNTHETIC_CONTROLLER_SECRET",
      "dnsPort": 15353,
      "bootstrapResolvers": ["192.0.2.53"]
    },
    "subscriptionPolicy": {
      "allowedOrigins": ["https://feeds.example"],
      "allowPrivateAddresses": false
    },
    "controllerPolicy": {
      "allowedProbeOrigins": ["https://probe.example"]
    }
  }
}
```

上述 UID、摘要、域名、解析器和 secret 均为合成占位值，不能直接用于真实部署。`runtime` 完整沿用[运行计划输入](../runtime/plan.md)。`management` 中仅 `subscriptionPolicy` 和 `controllerPolicy` 可省略。`deployment` 采用现有编译器的固定部署字段，不接受管理员密码、管理员哈希或任意服务命令；`credentialPath` 只引用已初始化的私有管理员凭据文件，计划不会读取或复制它。

`serverEntry` 指向已构建并审阅的管理 Server 入口。Node、完整运行源码及其依赖、核心和构建输出均须先安装到 root 控制的位置。不能只复制入口文件，也不能整体同步包含个人资料的工作区；发布与部署包必须显式排除 `.local/` 且不得跟随其中的目录链接。此模块不执行构建或安装。

输出 `schemaVersion: 1`、`sensitive: true`，并包含以下字段：

| 字段 | 内容 |
| --- | --- |
| `files` | 显式模式五份、原生网关七份 `{path, mode, owner, sensitive, content}` 文件；mode 为 `0600` 或 `0644`，owner 为 `root` 或数字服务 UID |
| `directories` | `{path, mode, owner}`；私有状态目录为服务 UID 的 `0700`，配置及系统文件父目录为 root 的 `0755` |
| `requirements` | 真实目标上的所有权、祖先、链接、挂载、构建、账户映射与授权审阅条件 |
| `steps` | 仅说明独立批准后如何安装和验收，不包含可直接执行的任意 shell 或服务命令 |

基础五份文件为核心 unit、核心 runtime 设置、管理 unit、管理设置和 polkit 规则；原生模式另含 `coproxy-gateway-network.service` 与 root 所有的 `gateway-network.json`，并列出独立网络回执目录。运行和管理设置由服务 UID 所有，网络设置由 root 所有，均为 `0600` 普通文件；路径祖先由 root 控制。管理员凭据不在生成文件清单中。完整原生输入见[合成样本](../../examples/automatic-gateway-deployment.json)。

**整个输入和计划均为敏感资料**：管理设置包含固定的 controller secret。CLI 或调用方须将计划保存为显式指定的私有文件，不能向公开标准输出打印内容、提交到 Git 或纳入发行附件；公开回执只应包含成功状态。错误消息不会回显输入。管理 origin、订阅许可和探测许可只接受无凭据、无查询和无片段的精确 origin，不能在其中携带 token。

管理 unit 使用 `Type=exec`、与核心相同的非 root 数字 UID、固定的 Node 与 Server 入口、`NITRO_HOST=127.0.0.1` 和显式 `NITRO_PORT`；通过 `COPROXY_MANAGEMENT_CONFIG` 引用管理设置。监听及核心三个端口均须至少为 1024，四个端口互不相同。`origin` 必须为 HTTPS 或精确的 localhost/IPv4/IPv6 loopback HTTP；HTTP 的显式 origin 端口须匹配后端端口，IPv6 HTTP 入口需由明确配置的本地代理转到 IPv4 后端。远程 HTTPS 入口需另行安装可信反向代理，正确覆盖 Host/协议头并拒绝不可信转发头。

管理 unit 包含失败重启、`UMask=0077`、`NoNewPrivileges`、`PrivateTmp`、`PrivateDevices`、只读系统和空 capability bounding set 等限制。它没有核心依赖或预启动核心命令。Server 启动时，空状态或已完成事务保持只读；发现未完成事务或持久故障时，等待既有事务入口在同一持久锁下执行一次恢复，必要时重新启动上一确认核心，失败则保留故障供管理员检查和显式重试。此流程不捕获新草稿、不建立新 selection，也不是第二个核心监管器；首次应用仍需明确的 generation 和 `expectedActive` CAS。两个 unit 的 `[Install]` 段仅描述以后显式启用时的目标，不表示已执行 enable。

文件路径必须为规范 POSIX 绝对路径；拒绝控制字符和会被沙箱隐藏的 home、临时目录、设备及内核虚拟文件系统。状态不能与源码、可执行文件、构建入口、设置、凭据、unit 或规则重叠，文件目标之间也不得相同或互为祖先。systemd 文本分别处理参数、环境、引号、反斜杠、百分号与命令美元扩展，不经 shell。实际符号链接、ACL、挂载可见性与账户权限只能在安装目标上核验，纯生成结果不构成安装成功证明。[systemd 执行与沙箱说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

polkit 规则只对指定用户名向固定 `coproxy-mihomo.service` 的 `manage-units` action 严格 `start`/`stop` 返回 YES；对该账户的其他单元/verb 及 `manage-unit-files` 返回 NO。没有 restart/reload、enable 或通用提权入口；只读 show 不需要额外授权。规则不要求交互登录会话，也不缓存授权结果。polkit 的 JS Subject 使用用户名，因此 `serviceUser` 必须在目标唯一解析为 `runtime.serviceUid`，此映射及既有更早规则须独立审阅，不能假定一份新增规则可以撤销其他已有授权。[polkit Action 与 Subject 接口](https://polkit.pages.freedesktop.org/polkit/polkit.8.html)

安装位置固定为 `/etc/systemd/system/coproxy-mihomo.service`、`/etc/systemd/system/coproxy-management.service` 与 `/etc/polkit-1/rules.d/50-coproxy-management.rules`。服务和授权文件须 root 所有、不可由服务或其他非可信身份写入；核心 unit 摘要仍覆盖既有生成器返回的完整 LF 文本。安装后需要检查没有 drop-in、没有待 daemon-reload 修改，并实测允许和拒绝的权限矩阵。实际复制、账户/权限变更、daemon-reload、enable/start、反向代理及网络变更都属于独立的安装操作。

`tests/deployment-plan.test.ts` 离线验证私有权限、核心完整摘要、同一服务身份、systemd 转义、路径隔离、精确 origin、输入安全及无自动核心依赖，并在隔离 JS 上下文执行生成的 polkit 规则，核对用户／unit／verb 矩阵。显式提供 `COPROXY_TEST_SYSTEMD_ANALYZE=/absolute/path/to/systemd-analyze` 时，另用真实解析器执行临时 unit 的 `verify --man=no`；未提供时该项跳过。测试不安装真实系统服务，也不证明目标的 systemd、polkit 或网关已验收。
