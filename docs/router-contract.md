# 协同路由器最小行为契约 v1

契约标识为 `cocoproxy-router-contract/v1`，适用于当前同子网 IPv4 原生自动网关。它定义路由器与 CoCoProxy 协作所需的网络行为、启停语义和验收证据，不是厂商 API 或通用自动配置协议。现有[远程部署入口](deployment.md#后续更新)提供可选的 AlwayRoute SSH 适配器，通过既有 ubus API 显式查询、关闭或启用路由器上已有的配置；升级协调按操作前的开启意图恢复交付。统一环境生成的参数另可通过下述明确入口预览、比对及保存到已兼容的 AlwayRoute。该入口不自动识别或生成任意固件的配置，也不安装、更新路由器组件或升级固件。实现仍可采用满足契约的固件原生能力或经过审阅的组件。支持结论按[支持矩阵](support-matrix.md)分级，详细设备条件及参数映射见[设备与协作要求](support-matrix.md)。

## 范围与输入

受管范围是精确接入 LAN 的 `clientCIDR`，或兼容的单终端 `clientIPv4`，两者互斥。路由器、外设及终端使用同一子网的不同有效主机地址。三方基础关系和合成配置见[架构](architecture.md)及[部署样本](../examples/automatic-gateway-deployment.json)。

适配实现至少接收并校验：契约版本、受管范围、LAN 三层入口、外设 IPv4、路由器交付 IPv4/MAC、DNS 端口、独立 bootstrap、本地解析范围及开启意图。接口名、mark、路由表号、配置存储和实现命令由两端各自管理；相同功能不要求同号。不得把真实网络参数编入通用源码或样本。

CoCoProxy 原生输入允许同一 /1–/29 子网，不允许与保留 TUN 网段冲突；`clientCIDR` 必须精确等于外设接口子网。路由器应拒绝无法表达同一范围或无法排除自身/外设的配置，不能静默缩小或扩大接管。

### AlwayRoute 参数映射

统一入口从一份 `SetupEnvironment` 生成外设部署输入与路由器参数；环境字段、MAC/接口/端口各自含义和缺项错误见[配置生成说明](setup.md#3-生成私有安装输入)。路由器事实必须明确输入，不能由外设网口或默认路由猜测。参数中的 `configTemplate` 对应 AlwayRoute 外部配置 schema1 的全 LAN 模式，包含已确认的 link、clientCIDR、DNS、本地域、enabled 及空 clients/bypass4；不输出选定终端模式或额外目的例外。`revision` 由读取目标当前配置后绑定，保存使用 expectedRevision/CAS，不能把模板当作任意当前版本的保存请求。

该实现的本地域及无点名称固定交给路由器 `127.0.0.1:53`，公网 DNS 转至外设 `ports.dns`；路由器专用监听端口单独填写。外设 bootstrap 只取 `management.bootstrapResolvers`，不会额外写入不存在的路由器 bootstrap 字段。`baseDNSIndependentConfirmed` 只记录操作者对独立解析前提的确认；DNS UDP/TCP、基础解析和实际路径仍需分项验收。

适配声明保存在随包的 [router-adapter.json](../packages/setup/router-adapter.json)，标识 `alwayroute-ubus/v1` / 适配器版本 `1.0.0`。声明列出所审阅 AlwayRoute 源码提交、配置 schema、组件包和能力接口要求；这些属于实现来源和静态兼容条件，不表示指定固件或包已部署，也不增加组合实测结论。现有组合证据仍以[支持矩阵](support-matrix.md)与发行说明为准。

### 读取、审阅与保存

在已获准的 Linux 操作端使用随包 `source/scripts/router-ssh-hook.py`，源码目录对应 `scripts/router-ssh-hook.py`。SSH 配置格式与主机指纹要求见[远程部署说明](deployment.md#后续更新)，沿用已有私有密钥，不在两端参数文件中填写凭据。以下为合成私有路径；参数文件由 `configure --router-output` 生成，SSH 配置及参数文件均要求当前身份所有、0600、单链接普通文件。

```sh
HOOK=./source/scripts/router-ssh-hook.py
SSH_CONFIG=/etc/cocoproxy-install/router-ssh.json
PARAMETERS=/etc/cocoproxy-install/router-parameters.json
python3 "$HOOK" --config "$SSH_CONFIG" --parameters "$PARAMETERS" preview-config
python3 "$HOOK" --config "$SSH_CONFIG" --parameters "$PARAMETERS" save-config \
  --apply --reviewed-plan-sha256 '<刚才预览返回的planSha256>'
python3 "$HOOK" --config "$SSH_CONFIG" --parameters "$PARAMETERS" check-config
```

预览与未加 `--apply` 的 `save-config` 只读。保存要求当前 `phase:disabled`、`desiredEnabled:false`、DNS 和转发资源已撤销，并核对 schema 与能力接口；开启或不稳定状态会拒绝，先走独立关闭再重新预览。预览包含目标、当前完整配置、真实 revision、完整候选及逐字段差异，含网络资料，按私有资料处理。摘要绑定这些内容和原参数；目标、revision、现有配置或参数变化后必须重做预览。

保存是完整替换：当前生成器固定 `bypass4:[]`、`clients:[]`，使用全 LAN 模式。已有额外目的绕过、本地域、接口、监听及候选开关的变化会出现在 `changes`，必须审阅；需要保留当前生成器不能表达的绕过时，不执行保存，继续用对应组件原入口明确维护，不能把空数组误认为保留旧值。

`configuration.enabled` / `candidateEnabled` 是下次显式 apply 所用的候选值；`persistentIntentEnabled` 是独立持久 intent 的观察，二者不是同一状态。所审阅实现分别保存 config、intent 和 lastgood：`external_save` 只递增并保存 config，不写 intent/lastgood，不应用网络；关闭 intent 下重启恢复不会以草稿取代它。适配器保存后读回完整配置和新 revision，并再确认仍 disabled、`desiredEnabled:false`，才返回 `saved:true`、`networkApplied:false`。这不证明开启或终端路径通过。

远端保存本身以 expectedRevision/CAS 串行校验配置，适配器在保存前后检查关闭状态。它不能跨多个 RPC 锁住其他管理入口；预览、保存与开启必须由单一操作者串行执行，避免其他入口并发改变 intent。并发修改、保存后读回不符或状态改变均报告失败，不宣称操作已撤销，先检查实际状态再继续。

外设已经完成配置和必要验收，且候选 `enabled:true` 时，可显式开启并比对：

```sh
python3 "$HOOK" --config "$SSH_CONFIG" --parameters "$PARAMETERS" enable
python3 "$HOOK" --config "$SSH_CONFIG" --parameters "$PARAMETERS" check-config
python3 "$HOOK" --config "$SSH_CONFIG" disable
```

`enable` 检查实际 capabilities/schema，并在提供参数时比较当前保存配置，应用后核对 appliedRevision。`check-config` 比较保存配置，同时分别报告 appliedRevision 与 `appliedConfigurationMatches`；保存草稿相同不等于实际应用相同，active 也不等于端到端通过。既有维护协调的 `status`/`disable`/`enable` 简短 JSON 接口保持兼容；未带参数的 enable 只应用既有已开启候选，不代表完成两端映射校验。关闭优先直接调用 `external_disable`，不先要求 active，不受配置能力或参数文件校验阻断，故障 degraded 时仍可关闭；仍须等待任务并确认最终撤销，失败如实返回。

开始维护前可先执行 `python3 "$HOOK" --config "$SSH_CONFIG" check-adapter`。它复用开启所需的 capabilities、配置 schema/revision 可读性校验，返回 `compatible:true`、固定 `scope:capabilities-and-readable-configuration-schema` 及 `endToEnd:unverified`。该动作不要求路由器参数或候选 enabled:true，不因 degraded 本身拒绝兼容性观察；它不检查两端配置相同、不证明可恢复成功或真实转发。当前意图与状态仍由后续独立 status 检查。远程维护协调在进入暂停或停服前及预览阶段消费该结果；未知、不兼容或缺失动作直接拒绝，不能等停机后才发现无法调用新版 enable。

缺少或不兼容的能力返回 `REMOTE_ROUTER_CAPABILITIES_INCOMPATIBLE`，schema 不兼容返回 `REMOTE_ROUTER_SCHEMA_INCOMPATIBLE`，参数不符返回 `REMOTE_ROUTER_PARAMETERS_INVALID`，保存配置与参数不同返回 `REMOTE_ROUTER_CONFIGURATION_MISMATCH`。`REMOTE_ROUTER_DISABLE_BEFORE_SAVE` 要求先关闭，`REMOTE_ROUTER_PLAN_REVIEW_REQUIRED` 要求重新预览并使用匹配摘要，`REMOTE_ROUTER_SAVE_UNCONFIRMED` 要求检查实际保存内容。通用 RPC/SSH、任务超时或最终状态失败都不表示远端任务已取消；不要反复覆盖配置。

## 必须满足的行为

| ID | 要求 | 最低验收证据 |
| --- | --- | --- |
| R1 来源及入口 | 仅把受管终端的公网 IPv4 TCP/UDP 交付外设，保留原终端源 IPv4，二层来源为已核对的路由器交付 MAC | 至少两个受管来源及新加入地址；外设观察原来源和指定路由器 MAC；单终端模式按单一范围验证 |
| R2 排除与防循环 | 保留 LAN/路由器/外设管理和基础控制；外设本机出站与终端回程不重复交付；不将全局默认路由指向外设 | 管理和本地访问保持可达；核心新建出站、DIRECT 及回程经过路由器且不循环 |
| R3 NAT 与回程 | 交付段不 SNAT/masquerade，WAN NAT 可保留；接受外设经路由器返回终端和所需同接口转发 | 分别验证 TCP/UDP、连接跟踪、同接口防火墙、MTU/必要差错、rp_filter 和重定向设置影响 |
| R4 DNS | 只把受管公网 DNS 的 UDP/TCP 查询转交外设指定端口；本地域/无点名称走基础解析；bootstrap 不形成回环 | UDP/TCP 分开查询；本地解析、节点解析及 bootstrap 可用；外设只接受指定路由器来源与本机 DNS 请求 |
| R5 IPv6 及其他协议 | 阻断受管公网 IPv6并保留必要本地控制/管理；声明其他 IP 协议和加密 DNS 的处理范围 | 公网 IPv6 无旁路；本地管理/控制可用；未验证的协议明确列出 |
| R6 故障阻断 | 开启意图下外设、核心、DNS 或链路失效时阻断受管外网，查表失败不回落普通 WAN | 对每种故障独立测试；原有连接和新连接均核对，不以 DNS 成功代替代理成功 |
| R7 独立关闭 | 外设离线时可从路由器撤销交付、专用 DNS 和相关 IPv6 限制，恢复普通直连 | 关闭不依赖外设服务响应；读取撤销状态并验证直连，明确关闭优先于后台恢复 |
| R8 生命周期 | 保存开启意图；启动/重连/正常防火墙与 DNS 重载时先保护，再取新鲜证据放行；offload 和旧连接不能绕过策略 | 两端不同启动顺序、正常 reload、链路恢复、新旧连接和加速开启条件逐项验收 |
| R9 状态与部分失败 | 可识别准备、开启待就绪、已激活、故障阻断、关闭和维护暂停等状态；应用/撤销失败可观察 | 记录配置版本、操作结果和失败项；失败保留保护，不把部分写入显示为成功 |

这些状态名称是行为说明，当前不要求路由器提供同名 JSON 字段或通用 HTTP 接口。路由器可自行实现，但适配文档必须指出每一项如何设置、读回和撤销。只有静态目的路由、全局 DNS 或端口映射不足以证明满足契约。

## 启用、恢复和维护

1. 在未交付流量时核对参数、维护入口及独立关闭；确认外设已安装、HTTPS/管理员就绪、成功配置已应用。
2. 持久保存明确开启意图，先建立失败时的阻断保护；协调 DNS 和交付，避免半套策略放行。
3. 每次重新放行前核对当次依赖就绪。日常 DNS UDP 查询可作为有界预检，但只证明该查询路径。核心、原来源、代理出口和回程须分别验证。
4. 重启/重连后只恢复上次成功提交配置，暂时依赖故障及锁忙应退避重试；不得自动应用新草稿或依赖旧的 ready/DNS 缓存。依赖就绪后 60 秒内恢复新连接是组合验收目标，尚未经所有组合证明。
5. 用户明确关闭后撤销专用策略并取消后续恢复。维护时先暂停外设自动恢复并等待事务排空，再独立关闭路由器交付，随后按[部署维护](deployment.md)停止服务和退役网络。

入口绑定实际 LAN bridge/三层接口及身份，不绑定同一逻辑 LAN 的某个物理交换端口。正常 reload 与任意全表 flush 是不同场景；后者当前没有零窗口保证。系统关机不得把“未运行”误记为用户关闭意图。

## 证据与版本兼容

适配结论至少包含契约版本、CoCoProxy 提交/载荷 manifest 摘要、核心平台、路由器固件/组件版本、受管模式、每个 R1–R9 项目的证据等级及未执行场景。路由器配置版本与 CoCoProxy 运行代次是不同标识；状态须带观察时间/有效边界，不能仅凭某次历史 active 放行。

现有 AlwayRoute SSH 适配器的 `status`、`disable`、`enable` 动作及其他适配器的 hook 约定见[远程部署说明](deployment.md#后续更新)，配置映射与保存使用本文明确入口。当前没有统一的厂商自动配置实现或认证型号名单；该适配器有上述版本化静态声明，并读取真实 capabilities 接口校验最小条件，不协商任意组件版本或自动升级组件。契约版本说明所需行为，适配器能力声明说明指定来源实现的接口，组合验证记录则说明指定环境实际验到了哪里，三者不能互相替代。现有实机和隔离证据按[发行说明](release-notes.md)限定；物理断电、实体多终端、换口和持续负载缺口继续保留。原始配置、流量、身份、恢复资料放本地；公开结论仅保留必要脱敏事实。

在 v1 内补充说明或验收方法不能降低 R1–R9 的要求。改变来源身份、DNS 信任边界、IPv6 行为、关闭语义或拓扑范围时应定义新契约版本，并给出迁移/回退及对应验证；不能借同一版本把不兼容行为静默替换。契约版本本身不会使现有配置文件新增字段，具体配置 schema 仍由各实现负责。
