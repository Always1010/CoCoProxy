# 管理认证与事务接口

本模块提供可挂载的 Fetch 请求处理器，复用工作区、草稿、订阅、不可变候选和应用事务。适配后的 MetaCubeXD Server 已挂载登录及控制器 HTTP/WebSocket 代理；加载本模块不会监听或启动核心。当前发行的部署和验收范围见[发行说明](../../docs/release-notes.md)。

## 身份、会话与请求边界

管理员凭据采用带 16 字节随机盐的 scrypt，固定 `N=16384,r=8,p=5,maxmem=64MiB`，哈希 64 字节。该参数选择 OWASP 列出的低内存档位；成本由代码固定，浏览器和凭据文件不能降低它。[OWASP 密码存储说明](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)

用户名为 1–64 位 ASCII 字母、数字及点/下划线/连字符，首位为字母或数字。密码为 10–1024 个 UTF-8 字节，拒绝 NUL 与无效 Unicode。未知用户名仍执行同样的密码派生和固定长度比较。初始化输入是私有 JSON `{ "username": "<admin-name>", "password": "<private-password>" }`；口令不进入命令行参数。密码不写在源码或发行载荷中，由部署时生成的私有凭据决定；替换凭据后须重启管理服务，旧内存会话随之失效。

```sh
node --experimental-strip-types apps/cli/main.ts admin-init --input /absolute/private/login.json --output /absolute/private/admin.json
```

输入须为当前身份所有的私有普通文件；输出权限为 600，只保存盐和哈希，不覆盖已有文件。创建真实账户属于实际部署步骤；测试只创建临时合成凭据。原始输入仍由操作者按自己的凭据保管规则处理，程序不额外复制或备份它。

短期会话令牌为 32 字节随机数，仅在 HttpOnly cookie 中返回；内存中只保留 SHA-256 摘要。临时登录绝对有效期 8 小时、最多 256 个，不因请求续期，进程重启后失效。登录可选 `trust: "none" | "90days" | "until-revoked"`，省略保持临时登录，网页默认长期信任；信任登录必须提供非空 `deviceLabel`；有效浏览器授权名称去除首尾空格、统一 Unicode 并忽略英文大小写后唯一，重复返回 409。临时登录不要求名称。受信任设备另持有独立 HttpOnly cookie，在短期会话过期或服务重启后自动建立会话。90 天授权按使用续期，每日至多持久更新一次；长期授权服务端不设到期日，浏览器 cookie 最长 400 天并在每日使用时刷新，浏览器清理、限制存储或重装仍可能要求重新登录。

设备授权最多 128 项，持久保存在私有状态目录的 `auth/trusted-devices.json`，仅保存令牌 SHA-256 摘要、随机设备 ID、名称、最近访问 IP 和时间，不保存原始令牌、密码或浏览器指纹。授权绑定管理员凭据和管理 origin；更换凭据或 origin 并重启服务后，旧授权失效。旧版授权读取时迁移为 schemaVersion 2，保持 ID、令牌摘要和期限，重名稳定补编号；已有迁移会持久写入。读取缺失文件不创建状态，损坏／不安全文件拒绝服务构造；同一进程内授权写入串行并原子持久提交后生效。当前管理进程仍须单实例运行，不支持多 worker 共享授权或撤销状态。单实例每分钟最多接受 8 次密码登录，最多并行 2 次密码派生；多进程或反向代理的额外限制尚未实现。

不同浏览器独立授权，允许相同 IP 使用不同名称；IP 变化不影响认证，也不用于流量归属。设置页可列出、重命名和撤销浏览器授权，不返回令牌摘要。主动退出、撤销当前设备或切换为临时登录会撤销该设备授权及关联的现有短期会话；撤销其他设备也会使其现有 HTTP／WebSocket 授权失效。注销为同源、可重复的操作，即使短期会话已过期仍清除设备授权；关闭页面不注销。所有写操作继续要求同源 Origin，不按内网地址免除认证。

HTTPS 使用 `__Host-cocoproxy_session` 和受信任设备的 `__Host-cocoproxy_device`，固定 `Secure; HttpOnly; SameSite=Strict; Path=/`。仅精确 loopback origin 可以使用 HTTP 测试 cookie；其他部署 origin 必须为 HTTPS。写操作要求精确匹配 Origin，跨站 Fetch、URL 查询令牌、Bearer 兼容入口与重复同名认证 cookie 均拒绝。所有 JSON 响应禁止缓存，错误只含固定码。JSON 请求有限量、严格 UTF-8 和读取时限；读取完成后才分派业务操作，不通过超时竞赛打断正在应用的事务。

## 工作区与来源接口

日常界面使用 `/api/cocoproxy/workspace`：GET 返回当前方案、来源摘要、带 `service`／`shared` 角色的策略组与规则来源；PUT 接收 `{expectedRevision, settings}` 保存独立的本地／订阅方案设置，本地覆盖可用 `sharedGroups` 保存用户共享出口名称，订阅覆盖不接受该字段。POST `/workspace/apply` 接收 `{expectedRevision, expectedActive}`，统一编译、校验并应用。POST `/workspace/select` 接收相同版本条件及 `{group, name}`，持久保存手动组选择并应用；存在未应用设置时要求先应用，避免节点操作顺带发布其他编辑。自动组保留原算法。设置使用私有原子文件和运行事务共用锁；旧草稿在明确切换前沿用，不自动替换现有运行配置。

手动切点界面直接调用 `/workspace/select`。成功响应附带 `view`：服务端在提交后回读真实组选择，并复核工作区版本、active 和事务状态；前端据此更新工作区，无需依次保存、应用、重读工作区和再次读取 controller。结果未知或回读不符时保留错误，只重新读取状态，不自动重放写入；接口报错也可能发生在已经提交之后。

管理服务将每次手动切点，以及失败或超过 1 秒的后台协调记录为 `COCOPROXY_OPERATION_TIMING` JSON 日志。仅包含固定操作名、成功/失败、总毫秒数和已执行阶段耗时：`lock`（取得或拒绝锁）、`held`（持锁）、`validate`、`activate`、`confirm`、`restore`、`commit`、`readback`、`network`、`observe`。同名阶段累计，持锁等包含其他阶段，不能将所有字段直接相加；不含节点名、目标地址、配置代次、路径、凭据或原始错误。健康且快速的后台检查不逐次输出，日志观察器失败也不影响操作结果。

订阅页独立管理来源，支持 PUT `{expectedRevision, name?, url?}` 重命名或替换地址、POST `/sources/:id/refresh` 更新、DELETE `{expectedRevision}` 删除。完整订阅保留策略组与规则，本地方案只使用其节点；来源更新不自动覆盖用户规则或替换当前配置。订阅自带方案只选一份基础配置，各方案分别保留用户覆盖。页面只返回节点名称与组引用，不向概览接口附加节点凭据或订阅地址。

工作区编译从同一份来源快照提取节点专用 DNS，仅对实际导入的节点主机生效，分别支持本地和订阅方案。专用解析策略参与快照摘要、编译缓存和应用时的版本校验；刷新后须重新应用。不同来源为同一主机指定不同解析器时返回 `NODE_DNS_POLICY_CONFLICT`，不任意选取；部署指定的同名精确主机策略优先。解析器端点可能包含私有路径，仅随私有快照与候选保存，不进入工作区概览和错误消息。

工作区 GET 另返回 `tcpNodes`，每项仅含 `{name, fingerprint, applicable}`。POST `/api/cocoproxy/workspace/tcp-delay` 接收 `{expectedRevision, expectedActive, name, fingerprint}`，只探测已应用且版本匹配的工作区节点服务器，不接受浏览器提供 host、port 或 URL。结果含 `status`、`delay`（毫秒或 null）和 `checkedAt`，不返回端点或凭据。探测从管理服务所在网关进行，只建立 TCP 连接，DNS 不计入建连耗时；单次总预算 3 秒，每个管理实例最多同时处理 8 项。UDP／QUIC 专用、链式拨号或无明确 TCP 端点的条目返回 `not-applicable`。取消和配置冲突不写配置，TCP 结果不参与代理健康历史或自动选路。

同一工作区的并行读取只合并尚未完成的来源构建；构建完成后重新读取来源。编译结果仅保留一个按完整策略内容匹配的不可变条目，来源内容变化即重新编译，不用 revision 单独替代内容身份。controller 并发只读请求共享在途完整运行核验，完成后不保留健康结果或错误；每个请求仍独立检查当前代次，写操作继续在共用锁内重新核验。每个管理实例最多同时接受 16 个 controller 测速请求，超额返回 `CONTROLLER_PROBE_BUSY`/429，普通状态读取仍可用；只读请求取消会传递给核心请求。核心组接口可能自行展开成员，网页全部组测速改为有界的去重单节点请求。

日常页面使用上述工作区入口；以下还列出会话、状态及兼容草稿接口。旧草稿接口仍可供 CLI／受控集成使用，不要求网页用户手动捕获候选。

| 方法与路径 | 请求或结果 |
| --- | --- |
| POST `/api/session/login` | `{username,password,trust?,deviceLabel?}`；仅 cookie 返回令牌 |
| GET `/api/session` | 当前已认证用户名与到期时间 |
| POST `/api/session/logout` | 空对象；撤销本机设备授权和关联会话，清除两个 cookie |
| GET `/api/session/devices` | 已信任浏览器的 ID、名称、最近访问 IP、有效期与当前设备标记，不返回令牌摘要 |
| POST `/api/session/devices/rename` | `{id,label}`；重命名浏览器授权，不改变令牌或期限 |
| POST `/api/session/devices/revoke` | `{id}`；撤销指定设备及关联会话，撤销当前设备时清除 cookie |
| GET `/api/cocoproxy/health` | 无需认证，仅报告 management_only 响应，不报告核心健康 |
| GET `/api/cocoproxy/status` | 历史状态、草稿摘要和独立 core_only 观察；gateway 明确未实现 |
| GET `/api/cocoproxy/draft` | 草稿版本、代次及可编辑 policy，不返回部署参数 |
| PUT `/api/cocoproxy/draft` | `{expectedRevision,policy}`；只保存 |
| POST `/api/cocoproxy/stage` | `{expectedRevision,sources?:[{id,expectedRevision}]}`；捕获指定草稿和来源快照 |
| POST `/api/cocoproxy/apply` | `{generation,expectedActive}`；首次 expectedActive 为 null |
| POST `/api/cocoproxy/recover` | 空对象；恢复中断事务 |
| GET `/api/cocoproxy/sources` | 来源摘要清单，不包含 URL、ETag 或节点凭据 |
| GET/PUT `/api/cocoproxy/sources/:id` | 读取摘要；PUT `{expectedRevision,name?,url?}` 保存来源 |
| GET `/api/cocoproxy/sources/:id/edit` | 登录后按需读取编辑信息，包含当前名称、完整 URL 和版本；响应禁止缓存，URL 不进入来源清单或工作区摘要 |
| POST `/api/cocoproxy/sources/:id/refresh` | `{expectedRevision}`；按部署许可策略刷新，不自动应用 |
| DELETE `/api/cocoproxy/sources/:id` | `{expectedRevision}`；删除来源，页面先解除工作区引用 |

除最小 health、密码登录和同源注销外均要求管理认证，受信任设备可自动建立短期会话；上表路径不接受查询参数。未知路由和原有 `/api/control/**` 返回 404，没有兼容的直接 start、配置热写、脚本、升级、WebDAV 或 geo 下载旁路。

浏览器不能提交 deployment 或 HTTPS 获取策略。`createManagementApplication` 在可信启动参数中捕获部署参数，保存时注入；读取或暂存不匹配的历史草稿会报告冲突。应用已有候选时，用固定部署重新编译并要求完整代次一致，不能只信任内容 hash 或部分监听字段。draft/source revision、generation、expectedActive 分别承担保存、捕获和运行 CAS，互不替代。

policy 可能包含管理员编辑的节点凭据，因此仍是敏感的已认证响应；部署 controller secret 不返回浏览器。stage 回执明确列出捕获的来源 revision、snapshotRevision 和 digest；刷新或保存完成不代表该版本已应用。

## 服务构造与启动恢复

`loadManagementService(absolutePrivateSettingsPath)` 返回 Fetch 处理器；`loadManagementGateway` 额外提供共享 `authorize`、`controller`、单次 `recoverStartup` 及 `startLifecycle`/`closeLifecycle` 给 Server 适配层。schemaVersion 1 私有配置包含 `origin`、`credentialPath`、`runtimeSettingsPath`、`deployment`，可选 `subscriptionPolicy`、`controllerPolicy`，合成格式见 examples/management-settings.json。运行设置沿用 runtime 模块；订阅策略沿用受限 HTTPS 许可字段，不接受可执行 resolver。工厂使用真实 `SystemdMihomoRuntime`，仅加载配置不会创建状态目录、监听网络或操作服务。

Server 的异步启动插件通过 `startLifecycle()` 先等待一次 pending 恢复。空状态或已完成事务只读返回；未完成事务或持久故障交由既有 `TransactionManager.recover()` 在共同文件锁下恢复，可能停止未提交核心或重新启动上一确认核心。恢复失败保留事务／故障，管理端仍可检查；日志只输出固定错误码。缺失持久运行标记时保持原有行为，已完成 active 不隐式启动。

明确启用 `lifecycle.json` 后，既有管理进程每轮结束约 5 秒后串行协调：优先恢复 pending，在锁外只读检查 committed active，健康且无到期网关核验时不占共同写锁。自动网关前置资源约每 30 秒核验一次；失败不更新核验时间，下一轮继续重试。需要修复或核验时，在共同锁内重读启用/暂停标记及 committed active，若 active 已变化则交由下一轮重新观察，再核验并修复网关前置资源、保留健康核心或请求 systemd 恢复 active。不会捕获新草稿、应用 desired 或新提交代次，也不创建第二个核心进程监管器。暂时网络不可用、活锁竞争及启动失败持续稍后重试；配置损坏、资源冲突保留固定失败状态。持久维护暂停阻止自动 pending 恢复和 active 协调，核心启动器也拒绝 paused 状态，跨 boot 仍有效。退出时 `closeLifecycle()` 清定时器并等待在途协调完成。`tests/management-startup.test.ts` 验证草稿隔离、暂停、锁竞争、持续重试与关闭排空，启动器测试验证暂停和损坏标记拒绝 exec；真实 Server 检查另验证从 `/` 工作目录启动，所有配置和入口必须为绝对路径。

Server overlay 替换了上游原控制 router、自动启动、刷新调度和 token 注入；桌面 endpoint/sync 插件也已禁用。客户端固定同源 `/api/clash`，不会获取核心密钥或选择任意控制器。部署必须使用专用可信 origin，后端只绑定 loopback；HTTPS 终止代理须覆盖 Host/转发协议头并拒绝不可信转发头。管理与核心的私有状态要求相容的服务身份和权限，systemctl 授权只针对审阅的核心单元及原生模式的固定网络 unit start/reload，具体安装另行实施。

## 核心代理

POST `/api/cocoproxy/rules/test` 接收 `{target, network?, destinationPort?, sourceIP?, sourcePort?}`，在管理会话与 Origin 校验后分析当前生效规则。读取经运行核验的不可变候选、核心规则禁用状态及当前组选择；按原始顺序执行域名、CIDR、端口、协议及内置 inline 集合匹配，遇到条件不足或不支持的复杂表达式时停止并报告，不能跳过后宣称兜底命中。需要地址匹配时通过内部 controller DNS 查询，不开放浏览器任意 controller 路由。最多并行 4 次，DNS 查询有 5 秒时限；前后核验 active 代次，冲突返回 409。不写工作区或核心配置，不访问目标网站，结果是所给条件下的规则分析，不是完整连接实测。正则只执行有界兼容子集及内置表达式，其他 regexp2 表达式明确报告无法分析。

`/api/clash/*` 与上述接口共用 Cookie。仅允许有限 GET：version/configs/proxies/group/rules/providers/connections；按名称选择节点的 PUT，以及关闭连接／清除选择的 DELETE 要求 `If-Match` 等于已观察 generation，且在配置应用共用锁内重新核验目标。PATCH/PUT configs、重启、更新、provider 下载与脚本入口均拒绝。GET 返回 `X-CoCoProxy-Generation`；候选切换由事务接口完成，不借助热写配置。

目标固定为当前 active、selection 和真实运行证据一致的 loopback controller，密钥仅在服务端 Authorization 头中使用。不接受客户端 Bearer、Cookie 转发、目标地址或 token 查询。延迟探测接受 `controllerPolicy.allowedProbeOrigins` 中精确的 HTTPS origin，或服务端站点目录登记的完整 URL，timeout 不超过 10 秒；目录许可不会开放同一 origin 的其他路径。省略 `controllerPolicy` 时基准仍使用 `https://www.gstatic.com`，站点目录提供内置目标及经管理操作登记的自定义目标；非空来源列表只限制目录之外的探测网址，不再逐站限制目录目标，空数组仍关闭全部探测。自动选点仍只使用原 origin 许可，不借站点目录扩大范围。

GET `/api/cocoproxy/workspace/sites` 返回 `{revision, workspaceRevision, scope, targets, selections, groups}`；目标包含稳定 id、名称、URL、分类、内置标记和 `permitted`。PUT 接收 `{expectedRevision, expectedWorkspaceRevision, scope, group?, selected?, add?:{name,url}, remove?}`，共用配置锁校验 revision 和当前方案，原子保存到私有 `site-probes.json`，不应用或重启核心。目录最多 32 个自定义目标，每组最多选 16 项；只接受无凭据、查询、片段和自定义端口的公开 HTTPS 域名目标，重复 URL 拒绝，已引用的自定义目标不能删除。组选择以工作区模式和来源集合／订阅身份隔离；删除或变更方案不会把同名组选择混用。前端结果只在当前会话中保留，并绑定节点内容、目标、方案和运行代次，变化后失效，不写入推荐评分。

HTTP 响应最多 2 MiB、5 秒，拒绝重定向，严格解析 UTF-8 JSON；递归脱敏秘密字段及实际 controller secret，限制深度和数量。WS 只允许 traffic/connections/memory/logs 与有界 interval/level 参数，单帧 1 MiB、队列 32 帧／2 MiB，并复核客户端发送缓存。每秒重查会话／设备授权和代次；注销、设备撤销、认证过期、事务开始或代次改变会关闭连接。受信任设备的有效授权可在短期会话过期后继续认证。Node Server 另限制最多 128 条流、客户端帧 4096 字节且拒绝任何客户端消息；全局 upgrade hook 同时封住没有 WS 路由的匿名升级入口。流状态不代表代理节点或网关健康。

```sh
npm run test:management
```

测试使用真实 scrypt、私有文件和 Fetch 请求；运行事务使用显式测试替身。它们验证认证、Origin、限额、服务端部署边界、CAS、失败恢复和脱敏，不证明真实 systemd 部署、网页、协议节点或网关就绪。

## 用量存储与采集

单实例管理生命周期运行后台用量采集，不依赖浏览器会话。约每秒读取受运行核验的核心连接快照，以 boot ID、PID 和进程启动时间区分物理核心；配置热切换不改变该身份。首次采集建立基线，不回填此前历史。按连接累计计数计算增量，并以核心总计数校对：快照间已结束的连接、无法归属的差额及非原子计数差异记为未归属，不按浏览器授权名称推测来源。核心重置或采集中断保留缺口信息，不清空历史。

私有状态目录的 `usage.sqlite` 使用 Node 内置 SQLite，WAL 与 FULL 同步模式；约每五秒把分钟汇总、每日源 IP 汇总、缺口和采集检查点在同一事务提交，正常关闭等待采集并排空。异常退出最多损失未提交窗口中已无法从核心恢复的明细。已提交检查点支持管理进程重启后按差值继续；数据库损坏、版本不支持或权限不安全时拒绝统计访问并保留文件，不自动重建。分钟明细保留 30 天，每日源 IP 汇总保留 365 天，按小时清理，备注不随用量过期。

`GET /api/cocoproxy/usage/status` 返回采集与保留范围；`POST /api/cocoproxy/usage/query` 接收 `{startTime,endTime,dimension,filters?,sort?,order?,search?,page?,pageSize?,overview?}`。所有接口仍要求管理认证，写入与 POST 查询要求同源 Origin。维度只允许 sourceIP/host/outbound/process/inboundUser，时间跨度最多 365 天，分页最多 200 项；SQL 标识符固定许可、值使用绑定参数。超过明细期限仅支持按 IP 的每日汇总，其他维度返回 `USAGE_DETAIL_EXPIRED`，不能把过期明细解释为零用量。

`PUT /api/cocoproxy/usage/alias` 接收 `{sourceIP,label}`，给规范化 IP 添加最多 40 字备注，空白备注删除。备注可重名，历史查询使用当前备注，不改变分组或历史字节，不关联登录授权、NAT 后设备或物理身份。不会导入浏览器 IndexedDB 中可能互相重叠的历史。用量与域名属于私有数据，不写入源码、通用日志或默认可提交输出。

## 单节点带宽测试

`GET /api/cocoproxy/bandwidth` 返回固定 Cloudflare 服务、时间／载荷上限和最近任务；`POST` 接收 `{node, expectedActive}`，`POST /api/cocoproxy/bandwidth/cancel` 接收 `{id}`。所有操作复用管理会话与写入 Origin 检查，浏览器以会话存储中的随机 `X-CoCoProxy-Bandwidth-Client` 标识任务，服务端再绑定认证浏览器身份；只返回 `owned`，不暴露标识或凭据。任务全局单实例互斥、后台运行，关闭请求连接不取消任务；取消及服务关闭等待清理完成才释放任务。GET 可供其他授权浏览器观察，取消仅限发起者。

测速使用已核验核心二进制和当前配置中的一个具体节点，在私有状态目录生成短时隔离配置；不修改主核心、策略组选择或网络设置，不复制其他节点与控制器密钥。DNS 策略引用的内联规则集随临时配置保留，其他路由规则集不复制；同一核心先校验临时配置，通过后才启动临时代理，校验失败返回固定错误码而不暴露配置或凭据。临时代理只监听回环并使用随机认证，外部目标固定为 `speed.cloudflare.com` 的下载／上传接口，TLS 校验开启，拒绝重定向、压缩和缓存结果。传输按实际应用载荷计数，上行结果等待远端响应；时间、流量和运行代次均受限，退出等待连接及子进程结束并删除本次临时目录。该快速测试不保证跑满线路，不替代终端路径或协议验收。

## 分组自动选择

可选 `automatic[group].bandwidth` 由 `bandwidth-policy.ts` 的单一参数表解析；缺省关闭且不补写旧配置。GET `automatic/probes` 同时返回该参数表及缺省值；UI 保存仍经过工作区 CAS、原有配置事务与权限检查。`automatic-selector.ts` 保持旧探测路径，仅开启组把普通性能／回切建议交给 `bandwidth-selector.ts` 仲裁，故障恢复优先；下载任务异步执行，轻量前置／压力探测仍进入原共享并发和每分钟额度。现有每秒用量采样通过只读观察回调提供节点增量，不增加 controller 轮询。

POST `/api/cocoproxy/automatic/bandwidth/check` 接收 `{expectedRevision, expectedActive, scope, group}`，唤醒已开启增强的组候选池；在共同锁内核验 revision、方案、代次、暂停及运行事务，不修改设置。手动发起可跳过业务怀疑，不能绕过单节点退避、预算、业务空闲、保持时间或有效样本门槛。补充轻量探测最多使用滚动分钟额度中的前18次，至少留6次供原监测／恢复。关闭增强后原延迟策略保持原有触发、故障确认、候选顺序和回切规则。

候选池每组记录全部已选节点，活动队列最多三个；单节点失败或无收益独立退避。先复用有效证据，有潜在收益才补下载，已满足条件的活动候选按保守损失、陌生风险和备选偏好成本排序；不等待全池测完。评分使用同一自动探测目标的延迟和受控下载吞吐，采用相对短板保护及严格净收益门槛，最新轻量延迟只能收紧该次收益判断。完整触发、顺序、公式和默认值见[带宽辅助策略说明](../../docs/usage.md#可选的带宽辅助决策)。

`GET /api/cocoproxy/automatic/status` 中各组的 `bandwidth` 仅在增强启用且运行快照可用时返回；界面应兼容缺省。主要字段含义如下：

| 字段 | 语义 |
| --- | --- |
| `phase`、`reason` | 组调度阶段与原因；阶段包括 `observing`、`screening`、`testing`、`confirming`、`waiting`、`holding`，需结合原因解读 |
| `candidate`、`testingNode`、`round` | 当前比较对象、实际检测对象及候选当前有效样本数；检测对象也可能是当前出口 |
| `pool` | 节点身份、优选／当前／活动标记、状态、有效样本数、最近轻量延迟、保守吞吐、最近有效样本时间和复查时间 |
| `pool[].state` | `pending`、`confirming`、`verified`、`backoff` 或 `unavailable`；`verified` 不是切换授权，仍检查实时样本数、新鲜度和收益 |
| `decision` | 最近一次完整比较的区间、改善、成本、门槛、陌生风险及短板判断；是诊断结果，不能作为独立的切换指令 |
| `nextAt`、`pool[].nextAt` | 调度或节点最早可重试时间，不承诺该时刻完成验证／切换；空值或零不能解读为失败 |
| `hourBytes/dayBytes`、`hourLimit/dayLimit` | 全实例自动检测滚动消耗及总预算，不是各组独占配额 |
| `hourReserve/dayReserve`、`urgent` | 总预算内的劣化预留及当前是否可使用；`urgent` 不代表绕过切换保持、净收益或总预算 |
| `searchBytes/searchLimit` | 本组当前连续搜索载荷及上限；让出后新一段重新计数，不重置滚动总账 |

默认连续吞吐样本低于目标80%才可用劣化预留，低于50%才可提前解除性能保持；持续延迟劣化也可触发这两条路径。两者均不代替最终收益与证据检查。无效或受干扰的下载不写入零速样本；主动验证与业务保护详见[资源限制](../../docs/usage.md#检测开销预算与业务保护)。

网络任务保持单飞。搜索让出或预算不足保留池，但样本继续老化，恢复后可能补测；事务悬挂期间作废测量证据。自身已确认切换保留退避及使用记录，外部配置／代次变化重建池。池、退避和使用证据不持久化，重启后重新积累；近期带宽性能切换记录和预算持久化。切换后前30秒增加轻量检查，前2分钟故障通过原恢复事务复核旧出口，失败节点增加退避。

下载达标验证复用隔离传输的固定目标与清理边界，独立于手动双向测速，二者共享单任务名额；不依赖浏览器持续打开。预算及近期切换保存于私有 `automatic-bandwidth.json`（version 1），共同锁内原子预扣／结算，崩溃不退还未确认流量；部署兼容、停服文件摘要及恢复后可读性检查包含此文件。区间、触发、节奏、额度与可调参数详见[使用说明](../../docs/usage.md#可选的带宽辅助决策)。

工作区的 `RoutingOverrides.automatic[group]` 可选保存 `{preferred, fallback, returnToPreferred}`，顶层 `autoProbes` 可选保存 `{primary, secondary, timeoutMs, slowMs}`；地址条目是 `{url, expectedStatus}`。旧格式保持兼容。自动组仅接受原手动组内的具体代理，拒绝内建出口、组引用、重复、越界和原生自动组。部署许可在保存与运行探测前分别校验，默认 Cloudflare 复核地址须显式获准。

GET `/api/cocoproxy/automatic/probes` 返回缺省检测配置及许可来源；POST `/api/cocoproxy/automatic/test` 接收 `{expectedRevision, expectedActive, probes}`，经实际当前节点验证两个地址，不保存配置；GET `/api/cocoproxy/automatic/status` 返回当前方案 `scope`、`workspaceRevision`、暂停状态、检测阶段及确认后的切换记录；POST `/api/cocoproxy/automatic/history/clear` 接收 `{expectedRevision, scope, group}`，仅清空匹配方案的指定手动策略组历史，不应用配置或修改自动选点状态。接口使用现有会话、Origin 和工作区冲突检查。浏览器 controller 路由不增加 `expected` 参数；内部探测额外核对核心每 URL 的 alive 标志，避免正数延迟掩盖状态码不匹配，并与手工探测互斥证据读回窗口。控制器 429 按 Retry-After 退避。

私有 `automatic-selections.json` 保存按方案和候选指纹约束的运行出口以及最多 50 条事件，不改用户手动选择或工作区 revision。自动写入复用共同锁和配置事务，失败按绑定内容 CAS 恢复；崩溃后只允许根据已提交 active 和核心实际选择修复自动组的选择差异，不能把用户待应用的规则或其他组修改顺便生效。每秒驱动轻量调度，完整计划和核心观察最多缓存 30 秒；实际切换始终重新构建并核验。后台生命周期关闭会等待在途任务，暂停标记在写入及事务入口复核。

查看历史以独立的私有 `automatic-history.json` 为准，按方案和组分别最多保留 50 条、最长 7 天，读取状态或写入时淘汰过期记录。整个归档另有 8 MiB 保护上限，极端长名称或大量方案触顶时从最旧记录淘汰。首次读取兼容导入旧运行文件中的确认事件；归档一旦存在，即使为空也不再从旧缓存补回。确认写入及崩溃恢复按事件 ID 去重，事件保留切换当时的优选／备选身份；清空同时抑制此前进程遗留的待归档事件重放，仍允许进行中的新切换完成后正常记入。历史读写与运行事务共用锁，但独立于运行绑定的 CAS 内容，清空不会重置调度器。部署兼容及保留检查包含该归档，停服安装窗口校验完整字节，运行后允许记录增长或过期。

`npm run test:automatic` 使用假时钟验证原策略故障／劣化／回切、共享限流，以及增强关闭回退、候选失败继续、相对短板、最新延迟收紧收益、样本过期、预算预留、业务中止和切换后故障恢复；`npm run test:workspace` 包含自动绑定恢复、权限、手动接管和界面参数／增强开关验证。评分与参数定义在 `bandwidth-policy.ts`，池与预算调度在 `bandwidth-selector.ts`，原策略接入与恢复在 `automatic-selector.ts`。这些验证不代替真实 Linux 核心与浏览器验收。
