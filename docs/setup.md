# 统一部署入口

本入口将环境事实转换为原安装器接受的私有部署输入，复用载荷、字段、权限和归属校验。完整接线、证书及终端验收见[从零部署](getting-started.md)，设备边界见[支持矩阵](support-matrix.md)。

发行包解压后使用根目录 `cocoproxy`；源码目录使用 `sh scripts/cocoproxy-setup.sh` 或 `npm run setup --`。以下命令在已核验发行包及获准目标 Linux 中执行，路径是合成角色示例，须替换实际值。

需要自动组织安装或更新时，使用 `sudo ./cocoproxy deploy --local` 在本机执行，或 `./cocoproxy deploy <IP>` 从另一台电脑通过 SSH 执行。首次安装还需私有环境与管理员输入，参数、预览及更新状态保留见[本机与远程部署更新](remote-deployment.md)。本地模式无需本机 SSH 服务；下面保留逐步配置、预检和维护入口。

## 1. 盘点环境

```sh
sh ./cocoproxy check
sh ./cocoproxy doctor
```

`check` 仅检查基础工具是否存在，不依赖 Node。`doctor` 汇总 Linux、架构、Node、systemd、Python、ip/nft、polkit、TUN 和 IPv4 转发结果。失败或未知的必要项使退出码为 1。结果包含固定 id、解释及处理方向，不输出原始系统错误。软件、账户、地址和 IPv4 转发仍按目标系统准备，检查不会安装依赖或改变网络。

环境输入选择受管 HTTPS 时，`doctor` 同时复用安装器的只读检查，核对 nginx、证书与私钥的路径和权限、证书有效期、SAN 及密钥匹配，并返回固定错误码和处理方向。未取得 root 权限或有效服务 UID 时该项为未知，不能算作通过。此检查不启动 nginx、不复制密钥，也不能证明实际终端信任证书。

报告保留 `schemaVersion: 1`、`checks`、`serviceUid` 和 `readyForInstallPreflight`。每个检查继续提供原有 `id`、`status`、`required`、`message`，并统一提供 `layer`、`code`、`reason`、`action`。`id` 标识检查项，`code` 区分固定原因，中文 `reason` 说明当前结论，`action` 给出下一步。字段不包含原始命令错误、账户快照或私有环境值。新增字段属于兼容扩展；读取报告时应允许未知字段。

`layers` 按以下固定顺序列出六层及其 `checkIds`。`coverage: "partial"` 只表示该层报告了部分检查；`"not-assessed"` 表示该层尚无检查结果。层目录齐全不表示六层能力已经完整实现，也没有“整层通过”的结论。

| layer | 含义与当前边界 |
| --- | --- |
| `foundation` | Linux、架构、运行时、systemd及环境字段格式 |
| `components` | 已有工具版本、polkit目录及指定Node版本；不证明全部运行能力 |
| `identity` | 账户、UID、可信工具链接链、普通部署目录归属与祖先遍历；最终安装按实际输入与载荷复核 |
| `network` | TUN、转发、指定地址，以及策略优先级/mark、路由表、nft表、TUN名称与网络回执；路由器实际行为另验 |
| `management` | 管理与受管HTTPS端口的当次socket观察、受管HTTPS静态条件及终端信任待验提示；外部反代或实际登录另验 |
| `installation` | 复用 `inspect` 的收据、文件/发行漂移、锁与journal、维护状态及身份布局；最终安装仍重新核验 |

检查状态保留 `pass`、`fail`、`unknown`：`pass` 只确认该项观察；明确条件不符或可信观察确认路径/命令不存在为 `fail`；权限不足、超时、命令失败或无法解析观察结果为 `unknown`，不能把失败命令直接解释为依赖缺失。任一必要项 `fail` 或 `unknown` 都不能继续算作预检准备通过。`readyForInstallPreflight: true` 仅表示已报告的必要项通过，可以继续完整安装预检，不证明未覆盖层、实际网络或整套部署已经就绪。

| 固定原因码 | 解释与处理 |
| --- | --- |
| `SETUP_CHECK_PASSED` | 本项只读观察通过；仍按步骤完成最终安装及独立验收 |
| `SETUP_REQUIREMENT_NOT_MET` | 已观察到条件不符；结合检查 `id`、`message` 和 `action` 处理 |
| `SETUP_REQUIRED_COMPONENT_MISSING` | 可信 `ENOENT` 观察确认所需路径或命令不存在；按对应系统准备后重查 |
| `SETUP_CHECK_UNAVAILABLE` | 查询失败或访问受限；核对权限、工具与执行条件，不据此安装或删除资源 |
| `SETUP_OBSERVATION_INVALID` | 观察输出格式无法识别；核对工具及查询结果后重查，不计为通过 |
| `SETUP_ENVIRONMENT_REQUIRED` / `SETUP_ENVIRONMENT_INVALID` | 缺少环境输入或字段不合部署格式；补正私有输入后重查 |
| `SETUP_EXTERNAL_VERIFICATION_REQUIRED` | 路由器或实际终端证据尚未取得；按对应验收流程处理 |

账户继续保留 `SETUP_SERVICE_ACCOUNT_REQUIRED`、`SETUP_SERVICE_ACCOUNT_INVALID`，受管HTTPS继续保留原 `SETUP_HTTPS_*` 原因码和处理方向。环境对象未通过格式校验时，报告该错误并继续收集不依赖它的基础结果；CLI在调用doctor之前读取私有文件或解析JSON的失败仍走原错误出口，不保证形成分层报告。本报告没有创建账户、准备依赖、修改网络或更改证书信任的执行步骤。

可信路径检查与最终安装器共享同一组只读判定。所有版本、账户和网络查询在执行前先检查工具及链接链：允许 root 所有的发行版工具链接，逐层检查链接目标，拒绝可写祖先、错误归属和非普通可执行文件。`node-path`、`systemctl-path` 还要求服务账户能遍历祖先并读取、执行工具；`release-parent` 要求发行父目录已存在。`deployment-directory-N` 按当前生成计划的目录顺序分别检查 root 或服务 UID 的归属和权限；缺失目录只在安装计划明确允许创建时接受。`receipt-directory` 检查已有收据目录的 root:0700 条件，`service-paths` 检查普通部署路径的服务遍历条件。缺少服务 UID 或文件类型等观察字段时返回 `unknown`。

这些检查保留安装器原因码：`INSTALL_TOOL_UNTRUSTED`、`INSTALL_ROOT_OWNERSHIP_REQUIRED` 表示工具或祖先的链接、归属、可写权限不符；`INSTALL_REQUIRED_SYSTEM_TOOL_MISSING`、`INSTALL_TOOL_NOT_EXECUTABLE`、`INSTALL_TOOL_LINK_LIMIT` 分别表示工具缺失、文件不可执行、链接链超限；`INSTALL_DIRECTORY_REQUIRED`、`INSTALL_DIRECTORY_OWNERSHIP_CONFLICT`、`INSTALL_SERVICE_TRAVERSE_REQUIRED` 分别要求准备对应目录、核对目录归属与权限、核对服务遍历条件。报告不打印实际路径，也不修复权限；最终安装会按实际载荷和输入重新核验全部路径。

网络资源判定也由 doctor 与最终安装器共享。`policy-rules` 拒绝所选三项策略优先级、核心保留的 9000–9010 优先级，以及与出口或核心保留 mark 有重叠的规则；`routes` 检查出口表、对应回程表及核心表；`firewall` 检查项目保护表和核心 nft 表，`tun-name` 检查核心 TUN 名称。`conflicts` 数组保留同项中全部已发现的固定原因码，不含原始规则。`network-receipt` 只接受缺失回执或可信 root:0600 单链接文件明确记录的 `removed` 状态；完整或中断回执需要通过维护流程显式退役。

`INSTALL_RULE_CONFLICT`、`INSTALL_ROUTE_CONFLICT`、`INSTALL_NFT_CONFLICT`、`INSTALL_TUN_CONFLICT` 分别表示上述资源占用；`INSTALL_NETWORK_REMOVE_REQUIRED` 表示回执尚未退役。新增 `INSTALL_RULE_MARK_CONFLICT` 采用保守检查：支持数值/十六进制 mark、独立 mask 或 `mark/mask`，并识别 iproute2 实际输出的 `"not": null`。只有可识别的纯 mark 逆规则才反转匹配；逆规则还含非平凡地址或其他选择器时返回 `unknown`，避免将整条规则的反转误当成只反转 mark。不会求解接口、源地址、goto、suppress 等完整策略路由语义，可能要求操作者审阅更窄的规则。观察形状或 mark 表达式无法可靠解析时 doctor 返回 `SETUP_OBSERVATION_INVALID` / `unknown`，安装器拒绝并保留 `INSTALL_NETWORK_OBSERVATION_INVALID`。存在同名资源时不因它看似属于本项目就当作空闲；doctor 不运行网络 helper、不删除规则，也不自动接管资源。

端口检查读取已有受信 `ss`（固定候选为 `/usr/bin/ss`、`/usr/sbin/ss`）的 IPv4/IPv6 `-a` 数字输出，覆盖工具可见的监听及已连接 TCP/UDP。本次没有发现地址、协议和端口重叠时，才报告该快照范围通过；这不是最终绑定保证，也不能排除查询后的竞争。管理、mixed 和 controller 按计划的 loopback 地址判断，DNS 与受管 HTTPS 按指定外设地址判断；不同地址或协议不一概当成冲突。IPv6 wildcard 的双栈行为、已连接 socket 的端口复用或必要查询证据不足时返回 `unknown`。查询出现错误、警告或无法识别输出时不按空列表处理。

已有监听只有在完整可信收据、对应 unit 文件、无 override 的 unit 主进程、进程 executable 和 cgroup 同时匹配时，才认定为自有占用，并以 `SETUP_PORT_OWNED_REQUIRES_STOP` 阻断，要求先走维护停服。确认的新占用使用 `SETUP_PORT_CONFLICT`；归属或绑定语义不明使用 `SETUP_PORT_OWNERSHIP_UNKNOWN`；必要的监听/已连接查询不完整使用 `SETUP_PORT_OBSERVATION_INCOMPLETE`。报告不打印 PID、进程名、地址或原始输出，也不终止进程。

较新 `ss -B` 可额外观察仅绑定未监听 TCP；该能力不是准备环境的强制依赖，工具不支持或空输出无法证明能力时，单列非必要的 `bound-sockets` / `SETUP_PORT_BOUND_SCOPE_UNAVAILABLE`，明确这个额外范围未覆盖。若该查询实际发现与计划端口重叠，仍合并到对应必要端口项并阻断。外部 HTTPS 模式单列 `external-https` 待验证提示；反代配置、实际转发、登录与终端信任按相应指南独立验收。

已有安装的五项检查为 `installation-receipt`、`installation-files`、`installation-locks`、`installation-maintenance`、`installation-identity`。它们直接消费维护检查的只读证据；没有收据目录与查询失败会得到不同结论。`SETUP_INSTALLATION_INCOMPLETE` 要求审阅 pending、卸载残留、锁、未完成journal或临时写入；`SETUP_INSTALLATION_BUSY` 表示锁主进程仍存活；`SETUP_INSTALLATION_DRIFT` 要求核对受管文件或发行内容的缺失与改动；`SETUP_MAINTENANCE_REQUIRED` 要求先暂停持久运行；`SETUP_INSTALLATION_IDENTITY_MISMATCH` 要求核对已有服务 UID 和布局。权限不足、无法读取或检查器能力不足时相应项为 `unknown`；不通过删除锁、清回执或覆盖文件使检查变绿。

## 2. 填写一次环境事实

将随包 `source/examples/setup-environment.json` 作为合成参考，在已存在的私有目录创建自己的 0600 文件。不要直接使用文档地址。

必填内容为接口、外设/路由器 IPv4、路由器交付 MAC、精确 LAN CIDR、管理 origin、纯 IP 引导 DNS 和订阅 HTTPS origin 许可。端口、网络资源编号和安装位置有默认值，可通过 `ports`、`resources`、`system` 覆盖；生成器继续调用完整部署校验。`system.serviceUser` 默认 `cocoproxy`。目标 Linux 从唯一的非登录账户读取 UID；离线生成时必须提供 `system.serviceUid`，目标安装仍重新核验。

```sh
ENVIRONMENT=/etc/cocoproxy-install/environment.json
sh ./cocoproxy doctor --environment "$ENVIRONMENT"
```

该检查只读，不创建 TUN、规则、账户或服务，不把默认路由猜成已授权交付路径。路由器条件、浏览器证书信任与终端路径须独立验收；通过只表示可以继续安装预检。

## 3. 生成私有安装输入

```sh
PAYLOAD=/srv/cocoproxy-staging/release
MANIFEST_SHA='<从可信发行清单核验的64位manifest摘要>'
INPUT=/etc/cocoproxy-install/deployment.json
sh ./cocoproxy configure --environment "$ENVIRONMENT" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --output "$INPUT" \
  --router-output /etc/cocoproxy-install/router-parameters.json
```

输出父目录须已存在、由当前身份所有且权限 0700；输出新建为 0600，拒绝覆盖。完整载荷先经过摘要和文件集核验，再派生 release 目录、核心摘要、source/binary/server 路径、前缀和重复 DNS 端口，首次生成随机内部 controller secret。摘要必须来自可信来源，不能只对未知下载自算摘要建立信任。

路由器参数文件含真实网络信息，仍是私有资料。请求 `--router-output` 时，环境还须明确填写示例中的 `router` 对象；缺失或未确认会在创建任何私有输出前拒绝。旧环境不请求此输出时仍可生成外设安装输入。`SETUP_ROUTER_CONFIRMATION_REQUIRED` 表示缺少整组路由器事实，`SETUP_ROUTER_FACTS_INVALID` 表示事实不完整或独立基础 DNS 未确认，`SETUP_ROUTER_ADAPTER_UNSUPPORTED` 表示没有对应适配器。

| 只填写一次的环境字段 | 含义与生成位置 |
| --- | --- |
| `network.ingressInterface` | 外设接收交付的接口；不据此猜路由器接口 |
| `network.routerMAC` | 路由器向外设交付时的来源 MAC，进入外设来源校验及参数 `deliveryMAC` |
| `router.lanInterface` | 路由器实际 LAN 三层入口，进入 `configTemplate.link.interface` |
| `router.gatewayMAC` | 外设接口的已核验 MAC，进入路由器 `link.gatewayMac`；不能填路由器 MAC |
| `ports.dns` | 外设受限 DNS 入口，同时生成外设配置及路由器 `dns.gatewayPort` |
| `router.dnsListenPort` | 路由器专用解析器监听端口，进入 `dns.listenPort`；不能占用基础 DNS 53，不与外设端口混推 |
| `router.localDomains` | 本地域后缀，路由器将这些名称及无点名称交给自身基础 DNS |
| `router.enabled` | 本次候选配置的明确开启意图；生成文件不会启用网络 |
| `management.bootstrapResolvers` | 外设纯 IP bootstrap；仅从这一处读取，不在路由器输入重复填写 |
| `router.baseDNSIndependentConfirmed` | 必须明确为 true，确认上述 bootstrap 与路由器基础 DNS 均不回到受管公网 DNS 转发链；这是人工前提确认，仍须实际查询验收 |

参数包含适配器标识、完整 `configTemplate`、字段来源和独立解析前提。模板使用已审阅的 AlwayRoute schema1，远端 `revision` 必须由目标当前配置读取后绑定，不用固定的 0 冒充当前版本。路由器基础 DNS 在该实现中固定为 `127.0.0.1:53`，不接受任意基础解析目标。参数不是任意固件的可导入配置；具体预览、读回和保存边界见[协作约定](router-contract.md)。生成器不会写入另一台设备，也不会把人工前提确认报告为实际路径通过。

已有兼容 AlwayRoute 时，接着按[读取、审阅与保存](router-contract.md#读取审阅与保存)使用同一参数文件运行 `preview-config`，审阅目标与完整替换差异，再显式 `save-config --apply --reviewed-plan-sha256` 并 `check-config`。保存仅允许关闭状态；候选 `enabled:true` 不会自行改写持久开启 intent，仍需在就绪后单独 enable。示例的 `enabled:false` 表示候选关闭，准备开启时在原环境明确改为 true 并重新生成到新的私有输出，避免手工修改或重复填写两端网络字段。

## 4. 安装预检与执行

```sh
sh ./cocoproxy install --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"
sh ./cocoproxy install --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
```

第一条只读。第二条才安装文件并 daemon-reload，仍不启动服务。随后按[安装与维护](deployment.md)准备管理员和[HTTPS](management-https.md)，完成首次应用、路由器交付、终端验收及[持久运行](getting-started.md#8-启用持久运行与自动恢复)。HTTPS 登录成功不代表终端信任证书或[通知](notifications.md)已可用。

## 5. 升级输入与维护

```sh
sh ./cocoproxy configure --environment "$ENVIRONMENT" \
  --payload /srv/cocoproxy-staging/new-release --manifest-sha256 '<新可信manifest摘要>' \
  --existing-input "$INPUT" --output /etc/cocoproxy-install/deployment-next.json
```

升级必须提供原输入，保留内部 secret、已支持的解析配置和下载策略。环境文件省略的端口、网络资源、探测许可、服务身份和系统路径沿用旧输入；明确填写的字段表示待审阅的新值。服务身份改变会拒绝；旧安装使用自定义状态、设置或凭据布局时继续使用底层安装器。origin 或许可变化仍需安装器显式配置审阅，不能绕过收据。

`upgrade`、`uninstall` 参数与 `install` 相同，前置及顺序见[维护流程](deployment.md#关闭升级与卸载)。旧 release 保留不等于任意状态格式都可降级；入口不自动复制凭据或创建备份。

在关闭服务之前可以准备新版本，并检查安装归属与持久状态的读取格式：

```sh
sh ./cocoproxy prepare --payload /srv/cocoproxy-staging/new-release \
  --manifest-sha256 '<新可信manifest摘要>' --input /etc/cocoproxy-install/deployment-next.json
sh ./cocoproxy inspect
sh ./cocoproxy recover
```

`prepare` 允许服务仍运行，但不表示已经可以执行升级；应用阶段会重新要求暂停、停用服务和退役网络。`inspect` 读取收据、锁和文件证据。`recover` 默认仅预览：只有新事务已写完全部预期字节、原进程已退出且当前状态满足约束时，才允许用返回的审阅摘要显式收尾。它不重试部分写入，不删除未知锁，不进行程序降级。详细步骤见[安装中断检查与恢复](maintenance-recovery.md)。

## 6. 可选的受管 HTTPS

已有反向代理可以继续按[HTTPS 配方](management-https.md)管理。若希望本项目安装收据统一管理独立 nginx 配置及 unit，在环境输入增加：

```json
{
  "https": {
    "mode": "managed",
    "certificatePath": "/etc/cocoproxy/web/server.crt",
    "privateKeyPath": "/etc/cocoproxy/web/server.key"
  }
}
```

这是环境文件的可选片段，不是完整输入。nginx 需预置，默认路径 `/usr/sbin/nginx`，可以通过 `nginxPath` 指定可信系统路径。管理 origin 必须使用 HTTPS 及非特权端口，证书覆盖该主机并与私钥匹配；证书和密钥须按配方准备好归属与权限。工具只引用既有证书/密钥，不申请、复制或删除它们，不修改终端信任。

生成后安装计划包含本项目专用 nginx 配置和网页 unit，其升级/卸载纳入同一收据。已有手工同名文件不能自动接管，必须先核对归属。`https` 省略时，升级生成保留旧输入的受管模式；首次生成沿用外部 HTTPS。明确设置 `{"mode":"external"}` 表示外部管理，受管模式的撤销不能绕过安装器的文件集合与迁移约束。

## 7. 初始化、启动与持久运行

[生命周期入口](setup-lifecycle.md)把初始化、管理启动、持久运行启用、暂停及停机退役组织为可预览步骤：

```sh
sh ./cocoproxy lifecycle --action start-management --input "$INPUT"
sh ./cocoproxy lifecycle --action start-management --input "$INPUT" \
  --apply --reviewed-plan-sha256 '<本次预览返回的摘要>'
```

入口核对当前完整安装收据、输入和文件字节，执行时与安装/恢复共用互斥条件。初始化另外指定私有 `--admin-input`；完整步骤及各动作的条件见生命周期说明。`--terminal-path-verified`、`--router-disabled` 记录操作者已完成实际验收或关闭的确认，不是工具自己观测到的网络证据。

从另一台电脑安装或更新时使用[SSH 部署入口](remote-deployment.md)，由该入口协调目标上的安装、服务和已有路由器适配器；它不要求在本机执行 Linux 服务命令。

## 输出边界

环境、部署输入及路由器参数含真实网络或秘密，保留在目标私有位置；仓库内调试材料只放被忽略的 `.local/`，不进入发行、同步或公开附件。命令默认只打印固定结果与必要状态，不打印内部秘密或环境 JSON。

`configure` 的部署输出与可选路由器输出分别使用独占新建，并非跨文件原子事务。如果第二个输出失败，第一个私有部署输入可能已经生成；检查已有文件后选择新的输出路径，不覆盖或反复生成内部秘密。
