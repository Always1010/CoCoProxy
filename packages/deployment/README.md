# 部署计划接口

`renderDeploymentPlan(input)` 是纯函数，组合核心、管理和可选网络计划，返回文件、目录、前提与步骤；不读取凭据、访问网络、安装文件或控制服务。实际操作见[部署与维护](../../docs/deployment.md)。

## 输入

根字段固定为 `schemaVersion: 1`、`runtime`、`management`。完整合成输入见[显式模式](../../examples/deployment-plan.json)和[原生网关](../../examples/automatic-gateway-deployment.json)，不要用占位 UID、摘要、secret 或地址安装。

| 对象 | 内容 |
| --- | --- |
| `runtime` | [核心运行计划](../runtime/README.md#部署计划)的完整输入，可选 `automaticGateway` |
| `management` | `origin`、`listenPort`、`serviceUser`、`serverEntry`、`settingsPath`、`credentialPath`、`unitPath`、`policyPath`、`deployment` |
| 可选管理字段 | `subscriptionPolicy`、`controllerPolicy`，见[管理接口](../management/README.md)和[订阅许可](../subscriptions/README.md#下载许可) |

服务用户名须在目标唯一映射到 runtime 的非 root UID。`serverEntry` 指向完整构建后的 Nitro 入口，不能只复制入口文件。四个监听端口互异且 ≥1024；origin 为 HTTPS 或精确 loopback HTTP，HTTP 端口须匹配后端，IPv6 loopback 须由本地代理转到 IPv4 后端。管理员凭据只引用已初始化路径，不接收密码、哈希或任意服务命令。

输入使用有界普通 JSON，拒绝额外字段、访问器、Proxy、循环及执行钩子；无效输入固定为 `DEPLOYMENT_PLAN_INVALID`，不回显秘密。

## 输出与身份

| 字段 | 契约 |
| --- | --- |
| `schemaVersion`、`sensitive` | `1`、`true`；计划包含 controller secret，必须私有保存 |
| `files` | `{path,mode,owner,sensitive,content}`，mode 为 0600/0644，owner 为 root 或数字服务 UID |
| `directories` | 需要的路径、身份和权限 |
| `requirements`、`steps` | 部署前提及操作说明，无任意可执行 shell |

显式模式五文件：核心 unit、runtime 设置、管理 unit、management 设置、polkit 规则。原生模式增加 root 网络 unit 和网络设置，共七文件，并增加独立 root:0700 回执目录。运行／管理设置为服务 UID:0600，网络设置为 root:0600。管理员凭据不在输出清单。

系统 unit 固定为 `/etc/systemd/system/coproxy-mihomo.service`、`coproxy-management.service`，原生另有 `coproxy-gateway-network.service`；polkit 固定为 `/etc/polkit-1/rules.d/50-coproxy-management.rules`。unit 摘要覆盖完整 UTF-8/LF 字节。

## 服务与权限边界

管理 unit 为单进程 `Type=exec`，与当前核心使用相同非 root UID，绑定 loopback，以环境变量引用私有配置；有失败重启、只读系统、私有临时目录和空 capability 集。它没有核心启动依赖，启动恢复通过同一事务锁执行一次，不自动捕获或应用新设置。

原生核心的网络权限、网络单元依赖和启动器见运行模块；管理进程不因此获得网络 capability。polkit 只允许指定用户名 start/stop 固定核心，拒绝该用户其他 unit/verb 和 manage-unit-files；show 无需额外授权。目标须审阅账号映射、既有更早规则和实际允许／拒绝矩阵。

路径为规范 POSIX 绝对路径，状态不得与源码、二进制、设置、凭据或系统文件重叠，拒绝沙箱隐藏目录和相互嵌套文件目标。systemd 参数与环境分别转义，不经 shell。祖先、链接目标、ACL、挂载与现场身份仍由安装预检核对。

验证使用 `npm run test:deployment`，涵盖输入、路径、模式文件清单和授权矩阵；可提供 `COPROXY_TEST_SYSTEMD_ANALYZE` 进行真实 unit 语法解析。测试不安装服务，运行范围见[发行说明](../../docs/release-notes.md)。
