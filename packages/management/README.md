# 管理认证与事务接口

本模块提供可挂载的 Fetch 请求处理器，复用工作区、草稿、订阅、不可变候选和应用事务。适配后的 MetaCubeXD Server 已挂载登录及控制器 HTTP/WebSocket 代理；加载本模块不会监听或启动核心。当前发行的部署和验收范围见[发行说明](../../docs/release-notes.md)。

## 身份、会话与请求边界

管理员凭据采用带 16 字节随机盐的 scrypt，固定 `N=16384,r=8,p=5,maxmem=64MiB`，哈希 64 字节。该参数选择 OWASP 列出的低内存档位；成本由代码固定，浏览器和凭据文件不能降低它。[OWASP 密码存储说明](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)

用户名为 1–64 位 ASCII 字母、数字及点/下划线/连字符，首位为字母或数字。密码为 10–1024 个 UTF-8 字节，拒绝 NUL 与无效 Unicode。未知用户名仍执行同样的密码派生和固定长度比较。初始化输入是私有 JSON `{ "username": "<admin-name>", "password": "<private-password>" }`；口令不进入命令行参数。密码不写在源码或发行载荷中，由部署时生成的私有凭据决定；替换凭据后须重启管理服务，旧内存会话随之失效。

```sh
node --experimental-strip-types apps/cli/main.ts admin-init --input /absolute/private/login.json --output /absolute/private/admin.json
```

输入须为当前身份所有的私有普通文件；输出权限为 600，只保存盐和哈希，不覆盖已有文件。创建真实账户属于实际部署步骤；测试只创建临时合成凭据。原始输入仍由操作者按自己的凭据保管规则处理，程序不额外复制或备份它。

短期会话令牌为 32 字节随机数，仅在 HttpOnly cookie 中返回；内存中只保留 SHA-256 摘要。临时登录绝对有效期 8 小时、最多 256 个，不因请求续期，进程重启后失效。登录可选 `trust: "none" | "90days" | "until-revoked"`，省略保持临时登录，网页默认长期信任；可选 `deviceLabel` 标记设备。受信任设备另持有独立 HttpOnly cookie，在短期会话过期或服务重启后自动建立会话。90 天授权按使用续期，每日至多持久更新一次；长期授权服务端不设到期日，浏览器 cookie 最长 400 天并在每日使用时刷新，浏览器清理、限制存储或重装仍可能要求重新登录。

设备授权最多 128 项，持久保存在私有状态目录的 `auth/trusted-devices.json`，仅保存令牌 SHA-256 摘要、随机设备 ID、备注和时间，不保存原始令牌、密码或浏览器指纹。授权绑定管理员凭据和管理 origin；更换凭据或 origin 并重启服务后，旧授权失效。读取缺失文件不创建状态，损坏／不安全文件拒绝服务构造；同一进程内授权写入串行并原子持久提交后生效。当前管理进程仍须单实例运行，不支持多 worker 共享授权或撤销状态。单实例每分钟最多接受 8 次密码登录，最多并行 2 次密码派生；多进程或反向代理的额外限制尚未实现。

设置页可列出和撤销设备，不返回令牌摘要。主动退出、撤销当前设备或切换为临时登录会撤销该设备授权及关联的现有短期会话；撤销其他设备也会使其现有 HTTP／WebSocket 授权失效。注销为同源、可重复的操作，即使短期会话已过期仍清除设备授权；关闭页面不注销。所有写操作继续要求同源 Origin，不按内网地址免除认证。

HTTPS 使用 `__Host-cocoproxy_session` 和受信任设备的 `__Host-cocoproxy_device`，固定 `Secure; HttpOnly; SameSite=Strict; Path=/`。仅精确 loopback origin 可以使用 HTTP 测试 cookie；其他部署 origin 必须为 HTTPS。写操作要求精确匹配 Origin，跨站 Fetch、URL 查询令牌、Bearer 兼容入口与重复同名认证 cookie 均拒绝。所有 JSON 响应禁止缓存，错误只含固定码。JSON 请求有限量、严格 UTF-8 和读取时限；读取完成后才分派业务操作，不通过超时竞赛打断正在应用的事务。

## 通知事件与 Web Push

通知复用已确认的自动选择事件和自动选择状态，不新增健康探测。切换事件在准备绑定时持久记录为待确认；事务成功后写入确认日志，进程中断后仅在候选、活跃代次和核心实际选择一致时补记，未生效的提议不通知。

通知状态独立保存在私有目录 `notifications/state.json`，绑定管理员凭据与管理 origin，包含首次订阅时生成的 VAPID 密钥、最近 200 条事件、最多 128 个设备订阅和 256 项待发任务。订阅绑定服务端已认证的可信设备 ID，浏览器不能指定接收者。临时会话可读事件，但不能开启后台通知；短期会话自然到期不撤销可信设备订阅，主动退出、设备撤销或授权到期后停止新发送。

同设备同策略组的待发消息等待 10 秒并合并为最新状态；事件历史保留每次变化。发送最多两个并行，每项有效期 5 分钟，网络／服务限流失败按退避重试；404/410 标为失效，认证或配置错误明确显示。发送在配置事务锁之外进行；故障不阻塞切换。2xx 只记为推送服务已接受，不表示终端已显示。已被推送服务接受的通知无法保证撤回。

生产发送使用锁定版本 `web-push` 负责 RFC 8291 加密和 VAPID 签名；自有 HTTPS 传输限定已知推送服务域名、验证并固定公网 DNS 地址、拒绝重定向，单次总预算 5 秒并限制响应大小。管理 API 不返回订阅端点、auth secret 或 VAPID 私钥。默认锁屏文案隐藏节点名称，各设备可独立配置事件类别和关注组。

以下路径位于 `/api/cocoproxy/notifications`，继承同源认证、CSRF、请求限量和禁止缓存边界：

| 方法与后缀 | 请求或结果 |
| --- | --- |
| GET `/status` | 能力、可信设备状态、公钥、偏好与发送状态 |
| GET `/events` | 最近 100 条事件，按新到旧返回 |
| POST `/initialize` | `{}`；可信设备主动开启时生成／读取公钥 |
| POST `/subscription` | `{subscription:{endpoint,keys:{p256dh,auth}}}`；绑定当前可信设备 |
| PUT `/preferences` | `{groups:null或组名数组,switches,recovery,outage,showNodes}` |
| POST `/unsubscribe` | `{}`；取消本设备通知，保留管理登录 |
| POST `/test` | `{}`；本设备每分钟至多一条测试通知；等待首次有界发送尝试并返回 `{queued,delivery,pending}` |

通知存储缺失时，普通读取不创建密钥或订阅；损坏时单独禁用通知，不阻止代理管理。仍只支持单实例服务。网页与设备使用方式见[通知说明](../../docs/notifications.md)。

## 工作区与来源接口

日常界面使用 `/api/cocoproxy/workspace`：GET 返回当前方案、来源摘要、策略组与规则来源；PUT 接收 `{expectedRevision, settings}` 保存独立的本地／订阅方案设置，POST `/workspace/apply` 接收 `{expectedRevision, expectedActive}`，统一编译、校验并应用。POST `/workspace/select` 接收相同版本条件及 `{group, name}`，持久保存手动组选择并应用；存在未应用设置时要求先应用，避免节点操作顺带发布其他编辑。自动组保留原算法。设置使用私有原子文件和运行事务共用锁；旧草稿在明确切换前沿用，不自动替换现有运行配置。

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
| GET `/api/session/devices` | 已信任设备的 ID、备注、有效期与当前设备标记，不返回令牌摘要 |
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

明确启用 `lifecycle.json` 后，既有管理进程每 5 秒串行协调：优先恢复 pending，再在共同锁内重读启用/暂停标记及 committed active，核验并修复网关前置资源、保留健康核心或请求 systemd 恢复 active。不会捕获新草稿、应用 desired 或新提交代次，也不创建第二个核心进程监管器。暂时网络不可用、活锁竞争及启动失败持续稍后重试；配置损坏、资源冲突保留固定失败状态。持久维护暂停阻止自动 pending 恢复和 active 协调，核心启动器也拒绝 paused 状态，跨 boot 仍有效。退出时 `closeLifecycle()` 清定时器并等待在途协调完成。`tests/management-startup.test.ts` 验证草稿隔离、暂停、锁竞争、持续重试与关闭排空，启动器测试验证暂停和损坏标记拒绝 exec；真实 Server 检查另验证从 `/` 工作目录启动，所有配置和入口必须为绝对路径。

Server overlay 替换了上游原控制 router、自动启动、刷新调度和 token 注入；桌面 endpoint/sync 插件也已禁用。客户端固定同源 `/api/clash`，不会获取核心密钥或选择任意控制器。部署必须使用专用可信 origin，后端只绑定 loopback；HTTPS 终止代理须覆盖 Host/转发协议头并拒绝不可信转发头。管理与核心的私有状态要求相容的服务身份和权限，systemctl 授权只针对审阅的核心单元及原生模式的固定网络 unit start/reload，具体安装另行实施。

## 核心代理

POST `/api/cocoproxy/rules/test` 接收 `{target, network?, destinationPort?, sourceIP?, sourcePort?}`，在管理会话与 Origin 校验后分析当前生效规则。读取经运行核验的不可变候选、核心规则禁用状态及当前组选择；按原始顺序执行域名、CIDR、端口、协议及内置 inline 集合匹配，遇到条件不足或不支持的复杂表达式时停止并报告，不能跳过后宣称兜底命中。需要地址匹配时通过内部 controller DNS 查询，不开放浏览器任意 controller 路由。最多并行 4 次，DNS 查询有 5 秒时限；前后核验 active 代次，冲突返回 409。不写工作区或核心配置，不访问目标网站，结果是所给条件下的规则分析，不是完整连接实测。正则只执行有界兼容子集及内置表达式，其他 regexp2 表达式明确报告无法分析。

`/api/clash/*` 与上述接口共用 Cookie。仅允许有限 GET：version/configs/proxies/group/rules/providers/connections；按名称选择节点的 PUT，以及关闭连接／清除选择的 DELETE 要求 `If-Match` 等于已观察 generation，且在配置应用共用锁内重新核验目标。PATCH/PUT configs、重启、更新、provider 下载与脚本入口均拒绝。GET 返回 `X-CoCoProxy-Generation`；候选切换由事务接口完成，不借助热写配置。

目标固定为当前 active、selection 和真实运行证据一致的 loopback controller，密钥仅在服务端 Authorization 头中使用。不接受客户端 Bearer、Cookie 转发、目标地址或 token 查询。延迟探测接受 `controllerPolicy.allowedProbeOrigins` 中精确的 HTTPS origin，或服务端站点目录中获准的完整 URL，timeout 不超过 10 秒；目录许可不会开放同一 origin 的其他路径。省略 `controllerPolicy` 时基准仍使用 `https://www.gstatic.com`，站点目录提供内置目标及经管理操作登记的自定义目标；显式列表限制目录目标的来源，空数组关闭全部探测。自动选点仍只使用原 origin 许可，不借站点目录扩大范围。

GET `/api/cocoproxy/workspace/sites` 返回 `{revision, workspaceRevision, scope, targets, selections, groups}`；目标包含稳定 id、名称、URL、分类、内置标记和 `permitted`。PUT 接收 `{expectedRevision, expectedWorkspaceRevision, scope, group?, selected?, add?:{name,url}, remove?}`，共用配置锁校验 revision 和当前方案，原子保存到私有 `site-probes.json`，不应用或重启核心。目录最多 32 个自定义目标，每组最多选 16 项；只接受无凭据、查询、片段和自定义端口的公开 HTTPS 域名目标，重复 URL 拒绝，已引用的自定义目标不能删除。组选择以工作区模式和来源集合／订阅身份隔离；删除或变更方案不会把同名组选择混用。前端结果只在当前会话中保留，并绑定节点内容、目标、方案和运行代次，变化后失效，不写入推荐评分。

HTTP 响应最多 2 MiB、5 秒，拒绝重定向，严格解析 UTF-8 JSON；递归脱敏秘密字段及实际 controller secret，限制深度和数量。WS 只允许 traffic/connections/memory/logs 与有界 interval/level 参数，单帧 1 MiB、队列 32 帧／2 MiB，并复核客户端发送缓存。每秒重查会话／设备授权和代次；注销、设备撤销、认证过期、事务开始或代次改变会关闭连接。受信任设备的有效授权可在短期会话过期后继续认证。Node Server 另限制最多 128 条流、客户端帧 4096 字节且拒绝任何客户端消息；全局 upgrade hook 同时封住没有 WS 路由的匿名升级入口。流状态不代表代理节点或网关健康。

```sh
npm run test:management
```

测试使用真实 scrypt、私有文件和 Fetch 请求；运行事务使用显式测试替身。它们验证认证、Origin、限额、服务端部署边界、CAS、失败恢复和脱敏，不证明真实 systemd 部署、网页、协议节点或网关就绪。

## 分组自动选择

工作区的 `RoutingOverrides.automatic[group]` 可选保存 `{preferred, fallback, returnToPreferred}`，顶层 `autoProbes` 可选保存 `{primary, secondary, timeoutMs, slowMs}`；地址条目是 `{url, expectedStatus}`。旧格式保持兼容。自动组仅接受原手动组内的具体代理，拒绝内建出口、组引用、重复、越界和原生自动组。部署许可在保存与运行探测前分别校验，默认 Cloudflare 复核地址须显式获准。

GET `/api/cocoproxy/automatic/probes` 返回缺省检测配置及许可来源；POST `/api/cocoproxy/automatic/test` 接收 `{expectedRevision, expectedActive, probes}`，经实际当前节点验证两个地址，不保存配置；GET `/api/cocoproxy/automatic/status` 返回阶段及确认后的切换记录。接口使用现有会话、Origin 和工作区冲突检查。浏览器 controller 路由不增加 `expected` 参数；内部探测额外核对核心每 URL 的 alive 标志，避免正数延迟掩盖状态码不匹配，并与手工探测互斥证据读回窗口。控制器 429 按 Retry-After 退避。

私有 `automatic-selections.json` 保存按方案和候选指纹约束的运行出口以及最多 50 条事件，不改用户手动选择或工作区 revision。自动写入复用共同锁和配置事务，失败按绑定内容 CAS 恢复；崩溃后只允许根据已提交 active 和核心实际选择修复自动组的选择差异，不能把用户待应用的规则或其他组修改顺便生效。每秒驱动轻量调度，完整计划和核心观察最多缓存 30 秒；实际切换始终重新构建并核验。后台生命周期关闭会等待在途任务，暂停标记在写入及事务入口复核。

`npm run test:automatic` 使用假时钟验证故障、劣化、回切、全断退避、共享限流和关闭；`npm run test:workspace` 包含自动绑定恢复、权限和手动接管验证。默认时间及使用方法见使用说明。这些验证不代替真实 Linux 核心与浏览器验收。
