# 部署与维护

首次部署按[从零部署指南](getting-started.md)完成系统准备、HTTPS、路由器接入和终端验收；环境字段及逐步命令见[配置参考](setup.md)，证书/nginx 配方见[HTTPS 配置](management-https.md)，设备范围见[支持矩阵](support-matrix.md)。本文集中本机／SSH 部署、已有安装维护和中断处理。

## Ubuntu 源码本机部署入口

公共操作分为构建和部署：构建选范围，部署读取成功结果中的同一范围，不必重复选择。默认全量；前端局部更新的构建用法见[按组件构建](development.md#按组件构建)。

前端产物只适用于与其基线 manifest 完全匹配的已有安装；首次安装或基线不符时拒绝。协调器预检后仅停止管理服务及其 HTTPS 依赖，安装新管理载荷并恢复原启用/运行状态；不暂停核心生命周期、不调用路由器维护适配器、不停止核心或网络单元。管理页面会短暂不可用。最终核对核心 PID、启动时间、服务启用状态、网络收据与业务状态读取；这些检查不替代真实网页和终端访问验收。

安装收据的 `release` 指向管理载荷，前端更新另用 `runtimeManifestSha256` 保留核心/网络原发行目录。检查安装时同时核验两份不可变载荷；不要清理仍被引用的旧发行目录。后续全量升级会重新统一路径。中断仍保留失败日志和安装锁，需按既有 inspect/recover 流程审阅，不自动回退旧包或继续全量部署。

在目标 Ubuntu/systemd 的 ARM64 或 x86-64 主机克隆源码后，可使用仓库内的本机入口，不需要预先存在 `.local/` 或手写部署 JSON。Node.js ≥22.18 必须事先位于 root 控制、服务可访问的系统路径；入口不会下载或替换 Node，也不修改网口地址。先按照[开发说明](development.md)准备构建条件，再以普通用户构建、以 root 部署：

```sh
bash scripts/build-release.sh --prepare
sudo bash scripts/deploy-local.sh
```

构建使用仓库外同级 `<源码目录名>-build` 工作区；自定义位置时，两步都传相同的 `--workspace /absolute/build-directory`。部署入口在整个输入、准备及安装期间持有与构建相同的工作区锁，核对成功构建回执、当前干净 Git HEAD、完整 manifest 及载荷字节。Git 更新、脏工作区、上次构建失败、缺失或损坏回执均拒绝部署；不会选用目录里残留的旧版本。交互结束后还会再次核验构建与源码。这里更新当前源码对应的载荷；它不会自行拉取 Git。

首次安装须在交互终端运行。向导要求部署者输入实际网口、稳定 IPv4、路由器 LAN IPv4、交付接口 MAC、规范 LAN CIDR、HTTPS origin、独立引导 DNS，以及订阅和探测 HTTPS 来源许可；不会根据默认路由或邻居缓存猜测网络。账户默认 `cocoproxy`，自动分配空闲系统 UID；既有账户必须是唯一非 root 非登录身份，冲突时停止。HTTPS 可以引用满足安装权限要求的既有证书和私钥，或显式选择为已填写的管理主机生成 365 天自签名证书；自签名证书仍须在浏览器所在终端单独核验和信任。管理员密码输入两次且不回显，不进入命令行参数或普通日志。

向导先列出完整变更范围，再要求输入 `INSTALL` 确认。确认范围包括：缺少时用固定 Ubuntu 包列表安装 Python、iproute2、nftables、polkitd、nginx、OpenSSL、账户及 sysctl 工具；创建专用非登录账户和缺失的安装父目录；缺少时新建固定 sysctl 文件持久设置 `net.ipv4.ip_forward=1`；选定时生成证书。自动系统包准备以 Ubuntu 24.04 及更新版本的包名为基线，Ubuntu 包维护脚本可能启动其发行版系统服务。入口不清空防火墙、改网口地址或设置路由器。需要 TUN、稳定接口地址和原有独立 DNS 等内核与网络前提；最终公开安装器仍执行完整检查，发现冲突不会自动删除资源。既有文件和目录权限不通过时不会递归修正。

环境及管理员输入只在 `/run` 下本次新建的 root:0700 临时目录内生成，文件 root:0600，调用公开 `deploy --local --environment --admin-input` 协调器后清理。协调器经公开 configure 生成正式部署输入，保存为 `/etc/cocoproxy-install/deployment.json`，初始化管理员并启动管理和受管 HTTPS 服务。随后应完成浏览器信任、首次配置及终端验收，再显式启用持久运行与路由器交付。系统准备和安装发生失败时不自动回滚已经完成的步骤；准备新建的账户、sysctl 和证书可能已存在，应先核验失败阶段，不能将部分安装当作新安装覆盖。

后续 Git 更新和构建完成后，再运行相同的 `sudo bash scripts/deploy-local.sh`，入口直接使用保存的部署输入并交给既有协调器维护更新，不再询问管理员或重新初始化。自动网关更新即使尚未开启交付，也必须具备可核验的路由器维护适配器；首次向导未提供适配器时，第一次实际升级会交互引导选择已有私有 SSH 配置、填写已核验的 AlwayRoute SSH 参数或指定可信 hook。SSH 模式只引用目标网关上现存的密钥和已核验 `known_hosts`，不生成密钥或接受未知指纹；填写的新配置仅临时 root:0600 保存，协调器成功后持久保存并复用。没有终端时须显式传 `--router-config` 或 `--router-hook`，否则返回 `LOCAL_ROUTER_ADAPTER_REQUIRED`，不会绕过维护检查。检测到不完整收据、遗留业务文件、输入缺失或中断日志时返回 `LOCAL_INSTALL_STATE_REQUIRES_REVIEW`，先按下文 inspect/recover 流程审阅；旧安装首次纳管使用下节公开入口及原输入，不能靠首次向导接管。

```sh
bash scripts/deploy-local.sh --check
sudo bash scripts/deploy-local.sh --preview
# 非交互首次安装：系统、账户、目录、网络及证书须已准备，输入文件须私有。
sudo bash scripts/deploy-local.sh \
  --environment /absolute/private/environment.json \
  --admin-input /absolute/private/administrator.json
```

`--check` 只盘点基础本机条件，不要求已有构建。首次交互 `--preview` 收集并显示准备范围后结束，不执行系统准备或安装；显式输入及既有安装 `--preview` 使用公开协调器预检，私有暂存/锁语义见本文末尾。无终端且没有显式输入时拒绝提示密码。需要路由器维护适配器或独立网页服务时，可继续传入 `--router-config`、`--router-hook`、`--web-unit`；其安全及更新约束与下文一致。首次向导不会自动配置这些凭据或开启交付。

## 本机与 SSH 部署

从可信发行来源核对 SHA256SUMS 和独立 manifest 摘要，解压匹配目标架构的发行包。入口部署当前解压版本，不下载最新版本、不构建源码、不安装依赖或创建账户。目标须已具备指南要求的软件、服务身份、网络及证书；SSH 调用电脑还需 Node.js ≥22.18、OpenSSH 和 tar。

在目标 Linux 本地执行：

```sh
./cocoproxy deploy --local --check
sudo ./cocoproxy deploy --local --preview
sudo ./cocoproxy deploy --local
```

`--local` 直接调用本机协调器，不需要 IP 或本机 SSH。`--check` 无需 root，仅盘点基础条件；实际部署及预览需要 root，缺少权限返回 `LOCAL_DEPLOY_ROOT_REQUIRED`。从源码调用须另给已装配的 `--payload /absolute/staging/release --manifest-sha256 <可信摘要>`。无 IP 且未指定 `--local` 时只显示帮助。

从另一台电脑执行：

```sh
./cocoproxy deploy 192.0.2.2 --check
./cocoproxy deploy 192.0.2.2 --preview
./cocoproxy deploy 192.0.2.2
# Windows 可直接使用发行包的 Node 入口：
node source/scripts/deploy-ssh.mjs 192.0.2.2
```

地址为合成示例。SSH 用户、端口、密钥沿用已有配置，或指定 `--user`、`--port`、`--identity`、`--known-hosts`；同一已核验主机的不同接口可指定 `--host-key-alias`。首次先用原生 SSH 核验身份，工具不修改 SSH 配置、不接受未知指纹或忽略变化。非 root 目标用户须有 sudo 权限；交互终端可提示密码，无终端自动化须已有 `sudo -n` 权限。

首次安装另给 `--environment /absolute/private/environment.json --admin-input /absolute/private/administrator.json`，本地模式参数相同。环境按[配置参考](setup.md)准备；管理员文件只含 `username`、`password`，真实值不放命令行、仓库或发行包。Unix 输入须为当前身份所有的 0600 普通单链接文件；Windows 放在仅当前用户可读的私有目录。

入口安装后初始化唯一管理员并启动管理服务，受管 HTTPS 同时启动网页服务；不自动 enable、不导入订阅、不为路由器开启交付。继续按首次部署指南应用配置和验收。

## 后续更新

核验新发行包后，对既有安装运行相同的 `deploy --local` 或 `deploy <IP>`。目标以 root:0600 的 `/etc/cocoproxy-install/deployment.json` 为部署输入主本，父目录 root:0700。正常更新只更换 release、核心摘要和服务入口，保留网络、内部身份、凭据路径及业务状态。

此前通过底层安装器部署时，首次增加 `--input /absolute/private/previous-deployment.json`；输入必须与收据及实际配置相符，不凭 IP 猜测或接管手工安装。外部网页服务需随维护暂停时增加 `--web-unit cocoproxy-web.service`，受管网页自动纳入。

### 路由器适配器

自动网关更新须先关闭路由器交付。首次可传入 `--router-config /absolute/private/router-ssh.json`，以后复用目标上的 root:0600 配置：

```json
{
  "host": "192.0.2.1",
  "user": "root",
  "port": 22,
  "identityFile": "/absolute/private/router-key",
  "knownHostsFile": "/absolute/private/router-known-hosts"
}
```

路径引用目标网关上既有密钥和主机指纹，不复制密钥。内置 AlwayRoute 适配器通过公开 ubus 查询、关闭、等待并恢复原开启意图，不安装路由器软件。固件能力、版本及配置审阅见[路由器契约](router-contract.md#alwayroute-参数映射)。任务总时限120秒（含 RPC，每次最多30秒），协调器含前后核验的操作上限300秒，超时失败不表示远端任务已取消。

其他实现可提供 `--router-hook /absolute/root-owned/executable`，程序及全部祖先须 root 控制、不可由其他身份写入：

| 动作 | 结果要求 |
| --- | --- |
| `check-adapter` | 只读检查查询、独立关闭、恢复接口及兼容配置，至少返回 `{"schemaVersion":1,"compatible":true}`；失败/未知须拒绝，不能固定返回 true |
| `status` | 只返回 `{"enabled":true}` 或 `{"enabled":false}` |
| `disable` / `enable` | 等待动作完成并读回确认 |

协调器先检查适配器，再独立查询状态。缺动作、不兼容、未知或格式不符，以 `REMOTE_ROUTER_ADAPTER_PREFLIGHT_FAILED` 在暂停/停服前拒绝。内置检查只覆盖能力及可读 schema/revision，`endToEnd:unverified` 不证明配置或转发恢复；enabled:false/degraded 本身也不代替后续维护状态判定。旧 hook 须补齐真实检查后重新预览。

### 更新顺序与状态保留

协调器先在运行期间 prepare，通过后暂停并排空事务、关闭路由器交付、停服、用旧 helper 退役网络，再调用公开升级。已启用但处于维护暂停的安装拒绝自动更新；停用且核心已停的安装可更新并保持停用。暂停标记与运行核心同时存在时须人工审阅。

prepare 拒绝先输出 `phase:"prepare"` 的脱敏摘要和原因码，再返回 `REMOTE_UPGRADE_NOT_READY_OR_CONFIGURATION_CHANGED`，此时未暂停或停服。网络回执只有完整拥有状态才调用旧 helper；从未启用或已经退役不重复删除，回执不完整或中途变化均停止。

保留核验分三个时点：

1. 暂停、关闭交付及停服后读旧安装基线；合法维护前编辑纳入基线。完整 reader 失败、active/selection 不一致或事务待恢复时先处理原事务；从未应用且均无记录不算故障。
2. 新文件和收据核验后、尚未恢复服务时，比较凭据、规范状态文件、全部候选存在集合及字节摘要、状态目录及规范子目录的目录项。停服窗口任何新增/缺失/修改都阻止恢复。
3. 凭本次指纹约束令牌恢复原 runtime 标记及服务 enable/active 意图，核验必要核心就绪后，比较稳定身份、用户偏好及完整可读性，通过后才恢复路由器原意图。原标记缺失或未启用时保持原 flags，不借维护启用恢复。

| `preservation` 范围 | 保留及允许正常推进的内容 |
| --- | --- |
| `contentChecks` | 实际 reader 验证完整字段、候选摘要及重编译；可读不单独证明业务可用 |
| 工作区、站点、草稿、订阅 | 用户策略、手动/自动选择、站点设置、草稿及订阅定义保留；修订/刷新时间、尝试/失败及动态快照可变化 |
| 可信设备 | 有效设备身份、令牌摘要、信任范围/标签保留；允许合法续期与自然过期清理 |
| 运行绑定/选择 | 已提交 active、selection 与重编译候选一致、reader 可读；动态目标、时间、PID 不要求相同 |
| `authentication` | 默认 `not-run`，实际登录和 Cookie 另验 |

快照仅在协调进程内保留脱敏摘要，不复制凭据、数据库或订阅，不创建备份。读取复核目录项和同代数据；已知原子写入临时文件不按业务解析，仍参与目录项比较；未知文件、损坏/缺失记录拒绝继续。首次安装为 `not-applicable`，同版本未升级为 `not-run`。

`REMOTE_PRESERVATION_INSTALL_WINDOW_CHANGED` 保持原意图/服务未恢复及路由器关闭；`REMOTE_PRESERVATION_READBACK_REQUIRES_REVIEW` 表示恢复后稳定字段或读回待审阅，不能直接归因安装破坏；`REMOTE_PRESERVATION_RUNTIME_RECOVERY_REQUIRED` 要求先恢复原事务。明确变更 origin/管理员会使旧设备绑定合法失效，以 `REMOTE_PRESERVATION_REAUTH_REQUIRED` 提示重新授权，不强保留旧身份或把失效当损坏。远程入口仍只更换发行引用，配置迁移另按下述手工审阅。

## 机器状态与生命周期

在目标 Linux 使用原私有输入：

```sh
./cocoproxy status --input /absolute/private/deployment.json
./cocoproxy management-report --input /absolute/private/deployment.json --probe-https
```

status 分列安装、管理员、管理服务、配置、核心、持久运行，`currentWait`、`next` 提示后续动作。入口复核完整收据、发布、文件及身份，以服务 UID 调用只读状态；核心仅观察本机回环 Controller 和版本。结束前复核安装/身份/配置，变化项改 unknown。它不写状态、启停服务或探测路由器/管理 origin。

可选 HTTPS 探测由调用端 Node 请求固定 `/api/cocoproxy/health`，最多5秒、2 KiB，不跳转、不带认证、不忽略 TLS；可信 TLS、HTTP 200 及预期内容同时满足才通过。省略探测不联网、不创建文件；完整私有输入校验仍适用，无需 root。`scope:"invoking-node"` 不能证明浏览器证书信任或登录成功，实际验收按[总指南第9节](getting-started.md#9-部署验收与交给使用者)。

生命周期动作默认预览，须附 `--apply --reviewed-plan-sha256 <本次摘要>` 才执行：

```sh
./cocoproxy lifecycle --action start-management --input /absolute/private/deployment.json
./cocoproxy lifecycle --action start-management --input /absolute/private/deployment.json \
  --apply --reviewed-plan-sha256 <本次预览摘要>
```

| 动作 | 条件与作用 |
| --- | --- |
| `initialize` | 另给私有 `--admin-input`；只独占创建缺失凭据，已有合法凭据保留，损坏/归属错误须修复 |
| `start-management` | 凭据已初始化，自动生命周期关闭或暂停；启动管理及收据内 HTTPS |
| `enable-persistence` | `--terminal-path-verified` 确认实际终端验收；启动早期 guard、启用管理/HTTPS 并以服务身份 runtime-enable |
| `pause-maintenance` | 持久暂停并等待事务排空，不操作路由器，也不代表现有核心已停 |
| `stop-maintenance` | 自动网关须 `--router-disabled` 确认交付已关；暂停、停用服务、核验 PID/Job，再用旧 helper 退役网络 |
| `resume-persistence` | 此前已启用，`--terminal-path-verified` 确认路径；恢复持久运行和管理/HTTPS 开机启动 |

摘要绑定输入、完成收据、动作、人工确认、生命周期、凭据和步骤。执行共用 install.lock，每步先写 root 私有 lifecycle.json 意图再记完成，管理员明文只读取原输入、不复制到记录。原进程已退出且锁/记录证明同一动作、输入及收据时，可重新预览后用新摘要继续；完成标记不代替当前 PID/Job 核验。初始化须现有凭据与记录摘要相符；未完成网络回执不自动再删。未知/旧格式锁、记录不匹配或文件漂移先 inspect，不能清锁重试。

## 关闭升级与卸载

用户恢复普通直连须从路由器撤销交付并恢复 DNS；网页直连模式仍经外设，停核心仍保留 guard。维护先成功 pause，再关闭路由器，最后停服退役，不能与自动恢复竞争。

优先用生命周期入口组织暂停和停止。手工维护使用已安装旧发布及原输入的精确路径，以下角色变量须替换：

```sh
NODE=/usr/bin/node
RELEASE='/opt/cocoproxy/releases/<旧manifest摘要>'
SERVICE_USER=cocoproxy
STATE_DIR=/var/lib/cocoproxy
RUNTIME_SETTINGS=/etc/cocoproxy/runtime.json
CLI="$RELEASE/source/apps/cli/main.ts"
runuser -u "$SERVICE_USER" -- "$NODE" --experimental-strip-types "$CLI" \
  runtime-pause --state-dir "$STATE_DIR" --runtime-settings "$RUNTIME_SETTINGS"
# 成功后，从路由器关闭交付并确认，再停止服务：
systemctl disable --now cocoproxy-management.service
systemctl disable --now cocoproxy-mihomo.service
systemctl stop cocoproxy-gateway-network.service
systemctl disable --now cocoproxy-gateway-guard.service
# 核验核心 PID/Job、TUN 和上游资源；完整拥有回执匹配时退役：
/usr/bin/python3 -I "$RELEASE/source/apps/gateway/network.py" remove \
  --settings /etc/cocoproxy/gateway-network.json
```

受管/独立网页也须停止禁用。helper 严格核对完整回执、设置及实时资源，guard 最后移除；拒绝未知资源、不完整回执或跨 boot 不匹配，不清理上游残留。从未 prepare 且无资源/回执时无需 remove。安装器只核验已清空和回执 removed/不存在，不代为退役。

准备新载荷和私有输入，release 的 source/binary/server 路径及核心摘要采用新 manifest，其余身份、secret、状态和网络保持原值；可用[configure --existing-input](setup.md#5-升级输入与维护)生成。载荷及祖先须 root 控制、不可由其他身份写入、精确文件集/摘要匹配，无链接/特殊文件；release 末级为 manifest 全摘要且尚不存在。只传送载荷，排除 .local，不整体复制工作区。

```sh
PAYLOAD=/srv/cocoproxy-staging/new-release
MANIFEST_SHA='<可信的新manifest摘要>'
INPUT=/etc/cocoproxy-install/deployment-next.json
"$PAYLOAD/cocoproxy" upgrade --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"
"$PAYLOAD/cocoproxy" upgrade --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
# 卸载同样先预览，确认后另加 --apply：
"$PAYLOAD/cocoproxy" uninstall --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"
```

升级只接受 complete 收据、旧自有文件字节/权限/身份及旧 release 完整匹配。旧七文件网关仅允许受控追加原不存在的固定 guard unit，不能借此改其他文件。配置变化默认拒绝；迁移先 prepare 审阅，实施附 `--reviewed-configuration-sha256 <review.digest>`。摘要绑定新旧 manifest、新输入原字节及旧敏感配置，重新排版或输入/载荷变化须重审；服务身份、状态及凭据路径、文件集合、停服和无冲突约束仍适用。

升级保留管理员、订阅、草稿、事务、生命周期及旧 release，不复制秘密、不自动回滚。完成后更新 RELEASE/CLI，核对保留配置与新部署，恢复原服务意图；已启用时以服务身份 runtime-resume（首次才 runtime-enable），恢复早期 guard、管理及网页，最后恢复路由器交付并验收。卸载只删除仍匹配收据的自有文件，保留私有设置、状态、凭据与 release；独立 HTTPS 和路由器另行处理。

### 安装预检拒绝

首次安装、升级、卸载均要求相关 unit 停止且未 enable，无 drop-in、运行时替代或待 reload；已启用恢复必须先 pause。完整前提见[设备条件](support-matrix.md#外接设备条件)。

| 原因码 | 下一步 |
| --- | --- |
| `INSTALL_*_REQUIRED` | 核验对应 Linux/root、软件、唯一非登录服务 UID、可信目录、TUN、转发及接口地址，环境另行准备 |
| `INSTALL_CORE_ARCH_UNSUPPORTED` | 使用审核且匹配目标架构的载荷 |
| `INSTALL_SERVICES_MUST_BE_STOPPED` / `INSTALL_UNITS_MUST_BE_DISABLED` | 按顺序停服、禁用并核对覆盖定义 |
| `INSTALL_LIFECYCLE_MUST_BE_PAUSED` / `INSTALL_LIFECYCLE_INVALID` | 完成持久 pause，损坏标记先调查 |
| `INSTALL_*_CONFLICT` / `INSTALL_NETWORK_REMOVE_REQUIRED` | 确认归属，显式退役旧自有网络，不删除未知资源 |
| `INSTALL_OWNED_FILE_CHANGED` / `INSTALL_ROOT_OWNERSHIP_REQUIRED` | 核对文件、路径和权限，不递归改权限或覆盖漂移过检 |
| `INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE` / `INSTALL_PREVIOUS_APPLY_INCOMPLETE` | 停止普通部署，按下一节检查 |

## 升级准备与中断恢复

### 运行期间准备

```sh
./cocoproxy prepare --payload /absolute/staging/new-release \
  --manifest-sha256 <可信摘要> --input /absolute/private/deployment-next.json
```

prepare 只读验证新旧发布、收据、文件、身份、工具和输入，允许服务运行，不停服或删除网络。输出配置变化及 review.digest，不是实施授权；正式升级会在维护窗口重查。

compatibilityAssessment 分列 state、configuration、historyCandidates、network、identity 的状态、原因和条件。状态/候选复用完整 reader，目标 manifest 的 stateSchemas、contentReaders、configurationReader、candidateReader 须与源码契约吻合，不仅凭同版本号推导兼容。坏内容为 unsupported，缺少/未知 reader 或无法可信读取为 unknown；候选核验规范字节、摘要、引用及目标设置重编译，不运行目标核心；网络只比静态绑定与回执状态，不证明实时资源归属；身份变化的合法失效与损坏分开报告。

原 stateCompatibility 和 `readiness:"prepared-not-applied"` 保留兼容语义，只表示必需静态格式可继续准备，仍须看 readinessScope 和完整五维结论，不表示动态网络可用或可立即安装。坏内容、reader 缺少/未知及观察失败分别用 `DEPLOYMENT_STATE_CONTENT_INVALID` / `DEPLOYMENT_STATE_JSON_INVALID`、`DEPLOYMENT_STATE_CONTENT_READER_NOT_DECLARED` / `DEPLOYMENT_STATE_CONTENT_READER_UNKNOWN`、`DEPLOYMENT_STATE_OBSERVATION_UNAVAILABLE` 表达。远程入口只接受原有配置未变化路径。

### 检查与收尾

```sh
./cocoproxy inspect
./cocoproxy recover
# 审阅动作及 reviewedRecoverySha256 后才实施：
./cocoproxy recover --apply --reviewed-recovery-sha256 <本次摘要>
```

inspect 列收据、受管文件/权限/摘要、发布完整性、锁进程和临时文件，不删除锁/文件、重装、改收据或启停服务。缺失/损坏收据不能可靠证明归属。

recover 只给同一已写齐安装/升级事务收尾：收据与含事务 ID、启动标识、进程开始时间的锁匹配，原进程已退出，全部预期字节/权限正确，生命周期暂停，服务停止禁用且无覆盖。它仅 daemon-reload、标记收据完成并移除同事务安装锁，不补写文件、恢复历史状态、退役网络或重启服务。摘要绑定凭据存在及内容，取得恢复锁后重查，变化须重预览。

已知首装可尚无管理员，返回 `credential:"initialization-required"`、`administratorInitializationRequired:true`，收尾后再 initialize；缺凭据不表示可登录。升级缺原凭据返回 `INSTALL_RECOVERY_CREDENTIAL_REQUIRED`，不能借恢复重置身份。已有凭据复核可信父路径、服务 UID、0600 及普通单链接条件。

旧 PID 锁、缺事务标识的 pending、部分写入、文件漂移、卸载中断、遗留恢复锁均人工审阅。失败不自动重复变更；协调记录 `/etc/cocoproxy-install/remote-last.json` 保存阶段、摘要、原意图及维护令牌，root:0600。安装收据/锁仍是文件权威证据；令牌只接受未被后续动作改变的暂停标记，不能清锁/删收据或只依 SSH 返回值重试。

`--preview` 会创建私有协调目录/锁、传送暂存载荷、生成临时输入，首次还验证管理员生成，但不停服/安装、不写管理员凭据。缓存发布前和既有缓存执行前均精确核验文件集/字节，不删除未知目录重试；普通复制失败清理本次暂存，中断遗留按归属审阅。两种模式沿用 REMOTE_* 原因码。

默认输出仅固定阶段、提交、摘要和结果，不输出配置、口令、原始系统错误、节点或订阅。仅 manifest 文件传输，拒绝 .local、.git 和目录链接；SSH 临时上传及管理员输入收尾清理。旧 release 不是业务备份，也不证明旧程序能读当前状态，故无通用程序降级/回滚命令。
