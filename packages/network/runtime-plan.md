# 网关核心 unit 与私有启动快照计划

`renderGatewayRuntimePlan(input: unknown)` 只生成确定的 unit 文本、`RuntimeSettings` 与路径/权限契约，不读取文件、不创建目录、不安装 unit、不调用 systemd，也不启动核心。错误固定为 `GatewayRuntimePlanError`，code/message 均为 `GATEWAY_RUNTIME_PLAN_INVALID`，无底层异常或输入值。

输入严格包含 `schemaVersion: 1`、`stateDirectory`、`binaryPath`、`binarySha256`、`systemctlPath`、`unitPath`、`serviceUid`、`coreHome`。路径为规范绝对 POSIX 路径，拒绝根目录、控制字符及 `/home`、`/root`、`/run/user` 下路径；state 与 home 必须互不嵌套。binary、unit、systemctl 不能置于这两个目录内，也不能作为它们的祖先路径。systemctl 只接受 `/usr/bin/systemctl` 或 `/bin/systemctl`，unit 文件名固定为 `coproxy-mihomo.service`，核心摘要固定为当前受审阅的 `GATEWAY_CORE_SHA256`，UID 为非 root 合法整数。输入拒绝额外字段、getter、Proxy、自定义原型、非枚举与 Symbol 属性。

返回字段如下：

| 字段 | 含义 |
| --- | --- |
| `unit` | 固定核心 unit 的完整文本 |
| `settings` | 兼容既有 `RuntimeSettings`；`unitSha256` 为 unit UTF-8 字节 SHA-256 |
| `coreHome` | 核心唯一持久可写目录，独立于 root state |
| `selectedPath` | 固定 `<stateDirectory>/selected-core.json` |
| `credentialPath` | 固定 `/run/credentials/coproxy-mihomo.service/core-config` |
| `filesystem` | 必需目录与 selected 文件的 UID/mode 部署契约 |

部署者须创建 root-owned 0700 state 和 candidates 目录，候选与 selected 文件均 root-owned 0600。`filesystem.selectedFile` 明确 selected 权限，candidate 文件沿用私有 store 约定。`coreHome` 须由 `serviceUid` 持有且为 0700，并使用可信祖先路径；UID 须对应已部署的专用服务账户。计划不会自行修改所有者、权限、ACL 或用户。

systemd 255 对单个 unit 的全部 credential 实施累计 1 MB 限制。管理器必须在写 selected 之前按配置规范 UTF-8 字节限制候选大小，不能沿用编译器较大的 4 MiB 输入上限；超限应提前拒绝，避免到启动时才失败。若以后增加 credential，还须共同计入同一预算。

核心进程通过 `LoadCredential` 取得 root 私有 selected 文件的启动快照，直接执行固定二进制 `-d <coreHome> -f %d/core-config`；无需遍历 root state，不使用旧 Node launcher。systemd 在启动时读取 credential，并在只读、仅服务身份与 root 可访问的位置提供它；`%d` 表示 credential 目录。路径内容按 systemd 的字符串、specifier 和命令环境展开规则转义，只有固定 `%d` 保留为 specifier。这些行为依据 [systemd 255 的 credential 文档](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#Credentials)和 [specifier 文档](https://www.freedesktop.org/software/systemd/man/255/systemd.unit.html#Specifiers)。

unit 明确 Requires/After/BindsTo `coproxy-network.service coproxy-management.service`，`Restart=no`，没有自动启用的 Install 段。网关 helper 负责阻断、选择快照及核心启动/重启的唯一顺序。BindsTo 与 After 让核心只能随两个依赖单元保持 active；管理进程退出导致管理单元 inactive 或失败时，systemd 自行停止核心，不依赖管理进程再发送停核命令。管理 cgroup 和运行证据仍须由 observer/helper 独立核验；依赖绑定不证明网络 guard、核心 cgroup 来源与运行证据已经建立。这些仍由 helper 的持久事务完成，见 [systemd 255 依赖文档](https://www.freedesktop.org/software/systemd/man/255/systemd.unit.html#BindsTo=)。

启动时核心排在 helper 和管理单元之后；同一停止事务按相反顺序先停核心。此处没有给 helper 增加 `After=coproxy-management.service`，避免管理单元将来排在 helper 之后时形成排序环；管理单元的部署与启动顺序须单独校验，见 [systemd 255 排序文档](https://www.freedesktop.org/software/systemd/man/255/systemd.unit.html#Before=)。依赖变化会改变完整 unit 的 `unitSha256`，部署须重新生成 runtime settings 和候选 metadata；既有摘要不能继续代表更新后的 unit。

unit 使用非 root User，仅赋予 NET_ADMIN、NET_RAW，设置 NoNewPrivileges、PrivateTmp、ProtectSystem、ProtectHome、ProtectControlGroups、内核保护及限制 namespaces 等。ReadWritePaths 只有 coreHome；UMask 为 0077，KillMode 为 control-group，启动与停止超时各为 10 秒。stdout/stderr 送 journal，使用经过官方文档核验的 `LogRateLimitIntervalSec=30s` 和 `LogRateLimitBurst=200`；这是 journal 消息速率限制，不是日志总存储额度，见 [日志速率文档](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#LogRateLimitIntervalSec=)。

unit 不含 generation，因此可以先生成其摘要，再用 `settings.unitSha256` 编译网关 metadata，最后由 helper 校验候选并写 selected 快照，避免配置与 unit 摘要循环。selected 的内容、实际执行文件摘要、unit 的安装字节、drop-in 缺失、目录权限、credential 快照与启动进程必须在实际管理器边界独立验证。此计划不代表 network/helper/management 单元安装、生产授权或网关设备验收已经实现。

针对性测试不启动服务：

```text
node --experimental-strip-types --test tests/network-runtime-plan.test.ts
```
