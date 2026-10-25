# 管理认证与事务接口

本模块提供可挂载的 Fetch 请求处理器，复用工作区、草稿、订阅、不可变候选和应用事务。适配后的 MetaCubeXD Server 已挂载登录及控制器 HTTP/WebSocket 代理；加载本模块不会监听或启动核心。当前发行的部署和验收范围见[发行说明](../../docs/release-notes.md)。

## 身份、会话与请求边界

管理员凭据采用带 16 字节随机盐的 scrypt，固定 `N=16384,r=8,p=5,maxmem=64MiB`，哈希 64 字节。该参数选择 OWASP 列出的低内存档位；成本由代码固定，浏览器和凭据文件不能降低它。[OWASP 密码存储说明](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)

用户名为 1–64 位 ASCII 字母、数字及点/下划线/连字符，首位为字母或数字。密码为 10–1024 个 UTF-8 字节，拒绝 NUL 与无效 Unicode。未知用户名仍执行同样的密码派生和固定长度比较。初始化输入是私有 JSON `{ "username": "<admin-name>", "password": "<private-password>" }`；口令不进入命令行参数。密码不写在源码或发行载荷中，由部署时生成的私有凭据决定；替换凭据后须重启管理服务，旧内存会话随之失效。

```sh
node --experimental-strip-types apps/cli/main.ts admin-init --input /absolute/private/login.json --output /absolute/private/admin.json
```

输入须为当前身份所有的私有普通文件；输出权限为 600，只保存盐和哈希，不覆盖已有文件。创建真实账户属于实际部署步骤；测试只创建临时合成凭据。原始输入仍由操作者按自己的凭据保管规则处理，程序不额外复制或备份它。

会话令牌为 32 字节随机数，仅在 HttpOnly cookie 中返回；内存中只保留 SHA-256 摘要。会话绝对有效期 8 小时、最多 256 个，不因请求续期，注销立即撤销，进程重启后失效。当前管理进程应单实例运行，不能假定多 worker 共享会话。单实例每分钟最多接受 8 次登录，最多并行 2 次含密码派生的登录；多进程或反向代理的额外限制尚未实现。

HTTPS 使用 `__Host-coproxy_session`，固定 `Secure; HttpOnly; SameSite=Strict; Path=/`。仅精确 loopback origin 可以使用 HTTP 测试 cookie；其他部署 origin 必须为 HTTPS。写操作要求精确匹配 Origin，跨站 Fetch、URL 查询令牌、Bearer 兼容入口与重复同名会话 cookie 均拒绝。所有 JSON 响应禁止缓存，错误只含固定码。JSON 请求有限量、严格 UTF-8 和读取时限；读取完成后才分派业务操作，不通过超时竞赛打断正在应用的事务。

## 工作区与来源接口

日常界面使用 `/api/coproxy/workspace`：GET 返回当前方案、来源摘要、策略组与规则来源；PUT 接收 `{expectedRevision, settings}` 保存独立的本地／订阅方案设置，POST `/workspace/apply` 接收 `{expectedRevision, expectedActive}`，统一编译、校验并应用。POST `/workspace/select` 接收相同版本条件及 `{group, name}`，持久保存手动组选择并应用；存在未应用设置时要求先应用，避免节点操作顺带发布其他编辑。自动组保留原算法。设置使用私有原子文件和运行事务共用锁；旧草稿在明确切换前沿用，不自动替换现有运行配置。

订阅页独立管理来源，支持 PUT `{expectedRevision, name?, url?}` 重命名或替换地址、POST `/sources/:id/refresh` 更新、DELETE `{expectedRevision}` 删除。完整订阅保留策略组与规则，本地方案只使用其节点；来源更新不自动覆盖用户规则或替换当前配置。订阅自带方案只选一份基础配置，各方案分别保留用户覆盖。页面只返回节点名称与组引用，不向概览接口附加节点凭据或订阅地址。

工作区 GET 另返回 `tcpNodes`，每项仅含 `{name, fingerprint, applicable}`。POST `/api/coproxy/workspace/tcp-delay` 接收 `{expectedRevision, expectedActive, name, fingerprint}`，只探测已应用且版本匹配的工作区节点服务器，不接受浏览器提供 host、port 或 URL。结果含 `status`、`delay`（毫秒或 null）和 `checkedAt`，不返回端点或凭据。探测从管理服务所在网关进行，只建立 TCP 连接，DNS 不计入建连耗时；单次总预算 3 秒，每个管理实例最多同时处理 8 项。UDP／QUIC 专用、链式拨号或无明确 TCP 端点的条目返回 `not-applicable`。取消和配置冲突不写配置，TCP 结果不参与代理健康历史或自动选路。

日常页面使用上述工作区入口；以下还列出会话、状态及兼容草稿接口。旧草稿接口仍可供 CLI／受控集成使用，不要求网页用户手动捕获候选。

| 方法与路径 | 请求或结果 |
| --- | --- |
| POST `/api/session/login` | `{username,password}`；仅 cookie 返回令牌 |
| GET `/api/session` | 当前已认证用户名与到期时间 |
| POST `/api/session/logout` | 空对象；撤销 cookie |
| GET `/api/coproxy/health` | 无需认证，仅报告 management_only 响应，不报告核心健康 |
| GET `/api/coproxy/status` | 历史状态、草稿摘要和独立 core_only 观察；gateway 明确未实现 |
| GET `/api/coproxy/draft` | 草稿版本、代次及可编辑 policy，不返回部署参数 |
| PUT `/api/coproxy/draft` | `{expectedRevision,policy}`；只保存 |
| POST `/api/coproxy/stage` | `{expectedRevision,sources?:[{id,expectedRevision}]}`；捕获指定草稿和来源快照 |
| POST `/api/coproxy/apply` | `{generation,expectedActive}`；首次 expectedActive 为 null |
| POST `/api/coproxy/recover` | 空对象；恢复中断事务 |
| GET `/api/coproxy/sources` | 来源摘要清单，不包含 URL、ETag 或节点凭据 |
| GET/PUT `/api/coproxy/sources/:id` | 读取摘要；PUT `{expectedRevision,name?,url?}` 保存来源 |
| POST `/api/coproxy/sources/:id/refresh` | `{expectedRevision}`；按部署许可策略刷新，不自动应用 |
| DELETE `/api/coproxy/sources/:id` | `{expectedRevision}`；删除来源，页面先解除工作区引用 |

除最小 health 外均要求管理会话；上表路径不接受查询参数。未知路由和原有 `/api/control/**` 返回 404，没有兼容的直接 start、配置热写、脚本、升级、WebDAV 或 geo 下载旁路。

浏览器不能提交 deployment 或 HTTPS 获取策略。`createManagementApplication` 在可信启动参数中捕获部署参数，保存时注入；读取或暂存不匹配的历史草稿会报告冲突。应用已有候选时，用固定部署重新编译并要求完整代次一致，不能只信任内容 hash 或部分监听字段。draft/source revision、generation、expectedActive 分别承担保存、捕获和运行 CAS，互不替代。

policy 可能包含管理员编辑的节点凭据，因此仍是敏感的已认证响应；部署 controller secret 不返回浏览器。stage 回执明确列出捕获的来源 revision、snapshotRevision 和 digest；刷新或保存完成不代表该版本已应用。

## 服务构造与启动恢复

`loadManagementService(absolutePrivateSettingsPath)` 返回 Fetch 处理器；`loadManagementGateway` 额外提供共享 `authorize`、`controller` 与 `recoverStartup` 给 Server 适配层。schemaVersion 1 私有配置包含 `origin`、`credentialPath`、`runtimeSettingsPath`、`deployment`，可选 `subscriptionPolicy`、`controllerPolicy`，合成格式见 examples/management-settings.json。运行设置沿用 runtime 模块；订阅策略沿用受限 HTTPS 许可字段，不接受可执行 resolver。工厂使用真实 `SystemdMihomoRuntime`，仅加载配置不会创建状态目录、监听网络或操作服务。

Server 的异步启动插件等待 `recoverStartup()` 完成一次检查。空状态或已完成事务只读返回；未完成事务或持久故障交由既有 `TransactionManager.recover()` 在共同文件锁下恢复，可能停止未提交核心或重新启动上一确认核心。它不捕获新草稿、不提交新代次、不添加周期重试或第二个监管器。恢复失败保留事务／故障，管理端仍可检查并显式重试；日志只输出固定错误码。锁冲突不触发并行恢复。`tests/management-startup.test.ts` 验证这些分支，真实 Server 检查另验证从 `/` 工作目录启动，所有配置和入口必须为绝对路径。

Server overlay 替换了上游原控制 router、自动启动、刷新调度和 token 注入；桌面 endpoint/sync 插件也已禁用。客户端固定同源 `/api/clash`，不会获取核心密钥或选择任意控制器。部署必须使用专用可信 origin，后端只绑定 loopback；HTTPS 终止代理须覆盖 Host/转发协议头并拒绝不可信转发头。管理与核心的私有状态要求相容的服务身份和权限，systemctl 授权仅针对审阅的核心单元，具体安装另行实施。

## 核心代理

`/api/clash/*` 与上述接口共用 Cookie。仅允许有限 GET：version/configs/proxies/group/rules/providers/connections；按名称选择节点的 PUT，以及关闭连接／清除选择的 DELETE 要求 `If-Match` 等于已观察 generation，且在配置应用共用锁内重新核验目标。PATCH/PUT configs、重启、更新、provider 下载与脚本入口均拒绝。GET 返回 `X-Coproxy-Generation`；候选切换由事务接口完成，不借助热写配置。

目标固定为当前 active、selection 和真实运行证据一致的 loopback controller，密钥仅在服务端 Authorization 头中使用。不接受客户端 Bearer、Cookie 转发、目标地址或 token 查询。延迟探测只能使用 `controllerPolicy.allowedProbeOrigins` 中精确的 HTTPS origin，timeout 不超过 10 秒；省略 `controllerPolicy` 时使用仪表盘默认的 `https://www.gstatic.com`，显式空数组关闭测速。UI 的探测 URL 必须与部署许可一致。

HTTP 响应最多 2 MiB、5 秒，拒绝重定向，严格解析 UTF-8 JSON；递归脱敏秘密字段及实际 controller secret，限制深度和数量。WS 只允许 traffic/connections/memory/logs 与有界 interval/level 参数，单帧 1 MiB、队列 32 帧／2 MiB，并复核客户端发送缓存。每秒重查会话和代次；注销、过期、事务开始或代次改变会关闭连接。Node Server 另限制最多 128 条流、客户端帧 4096 字节且拒绝任何客户端消息；全局 upgrade hook 同时封住没有 WS 路由的匿名升级入口。流状态不代表代理节点或网关健康。

```sh
npm run test:management
```

测试使用真实 scrypt、私有文件和 Fetch 请求；运行事务使用显式测试替身。它们验证认证、Origin、限额、服务端部署边界、CAS、失败恢复和脱敏，不证明真实 systemd 部署、网页、协议节点或网关就绪。
