# 部署与维护

第一次搭建请先阅读[从零部署与使用总指南](getting-started.md)，按接线、参数准备、软件与 HTTPS 安装、后台配置和路由器验收的顺序操作。本文提供安装器及维护步骤的详细约束。

局域网网页的完整 nginx、证书与独立服务配方见[HTTPS 网页部署](management-https.md)。

安装器部署独立的 CoCoProxy Linux 服务。透明代理还需协同路由器提供流量交付、DNS 和独立关闭，设备条件及两端参数见[路由器协作](cooperating-router-requirements.md)。

`apps/deployment/main.ts` 是离线、单目标的安装入口。它复用[发行载荷](release-staging.md)及 `renderDeploymentPlan`；自动网关默认安装八个文件及目录，显式代理模式为五个文件，可选受管 HTTPS 为原生网关追加两个文件并引用既有证书。默认只读核验并输出不含文件内容的预览，只有 `--apply` 写入目标。工具不通过 SSH 控制另一台设备，不探测或推断地址，不安装依赖、账户、nginx 软件或证书，不改默认路由、系统 DNS、sysctl，不启动或启用服务。完整部署还包括下面明确列出的准备、配置、启动和终端验收。

## 支持边界与前置审阅

[统一部署入口](setup.md)提供环境汇总检查、配置生成和相同安装器的调用方式，可减少手工搬运核心摘要、release 路径及重复端口。[生命周期入口](setup-lifecycle.md)组织初始化、启动、持久运行和停机退役；运行期间的升级准备与安装中断检查见[维护恢复](maintenance-recovery.md)。底层入口及本页的明确参数方式继续保留。

安装支持 Linux/systemd、固定审核的 ARM64 或 x86-64 ELF64 little-endian 核心，入口核对实际架构；其他系统与架构拒绝。目标须独立验收，当前已验证范围统一见[发行说明](release-notes.md)。

目标主机需预置 Node.js ≥22.18、systemd、支持 JavaScript `.rules` 的 polkit、唯一的非 root 专用服务账号、root 控制的系统可执行文件及安装父目录。专用账号须使用 `nologin` 或 `false` shell；账号名和固定 UID 来自私有输入，不能复用交互登录账号。工具通过现有 `getent` 验证身份，不创建账户或修改组。应另行审阅该账号既有 sudo/polkit 权限和规则顺序，确保没有更早规则授予任意单元、manage-unit-files 或 root shell；安装工具不能证明所有既有授权都安全。

自动网关还要求 Python ≥3.9、`/usr/sbin/ip`、`/usr/sbin/nft`、可用的 `/dev/net/tun`、内核 TUN/nftables/策略路由能力、已显式配置的 `net.ipv4.ip_forward=1`，以及输入指定接口已 UP 且配置了指定 IPv4/前缀。ip/nft 必须支持现有 helper 使用的 JSON 参数与规则。工具只读检查上述条件，不通过创建 TUN、`nft prepare` 或修改 sysctl 来“试验”能力；具体内核能力还需在独立网络启动与验收中证明。发行版对 sandbox、SELinux/AppArmor、挂载和 capability 的限制也须现场审阅。

首次安装、升级和卸载都要求核心、管理、网关网络及早期保护 unit 已停止且未 enable，没有 drop-in、运行时替代 unit 或待 reload 的定义。已启用自动恢复时还必须先持久 pause，等待共同事务锁排空，再停服务；安装器拒绝 `enabled:true, paused:false` 的生命周期标记。已有自有网络资源必须先通过既有 helper 安全退役，工具不会在只读预检中调用 `prepare`。它核对 guard、部署出口表/规则、客户端回程与上游保留资源均无冲突；存在网络回执时只接受 `removed`。因此升级需要一个明确的维护窗口。

涉及本机环境或设备的变更前，按各自管理约定取得相应许可并明确目标和影响。准备账户、软件、内核模块、IPv4 转发、网口地址、HTTPS 反向代理、证书及路由器交付均属于显式的前置运维步骤，不能从一次只读预检推导其变更授权。

## 1. 装配、传送与私有输入

在构建环境按[发行装配说明](release-staging.md)生成干净载荷，保存成功回执给出的 `manifestSha256`。通过操作者选择的传输方式将**该载荷目录**复制到目标 Linux；不要复制整个仓库、载荷父目录、`.local/` 或跟随本地目录链接。安装工具不下载组件，也不执行 npm。目标上的载荷及全部文件、目录和祖先必须由 root 控制且不可由组/其他用户写入，没有符号链接、硬链接或特殊文件。

以下命令均在**已获准的目标 Linux root shell**执行；路径是合成角色示例。`MANIFEST_SHA` 应填入构建端单独记录并核验的 64 位 SHA-256，不能仅对未知来源的 manifest 自算摘要就视为可信。运行载荷里的入口本身已在执行代码，须在执行前核验载荷来源和清单，不把运行入口当成对任意未知代码的安全沙箱。

```sh
PAYLOAD=/srv/cocoproxy-staging/release
MANIFEST_SHA='<构建端记录的64位manifest摘要>'
INPUT=/etc/cocoproxy-install/deployment.json
NODE=/usr/bin/node
RELEASE="/opt/cocoproxy/releases/$MANIFEST_SHA"
DEPLOY="$PAYLOAD/source/apps/deployment/main.ts"
sha256sum "$PAYLOAD/manifest.json"
```

操作者先准备 root 控制的载荷目录、输入父目录和 release 父目录，例如 `/srv/cocoproxy-staging`、`/etc/cocoproxy-install`、`/opt/cocoproxy/releases`。入口使用规范绝对路径，不接受空白或 `.local` 路径段；这些位置不能通过链接或服务账号可写目录到达。服务使用的 root 目录还须允许其遍历；入口保守要求相应祖先对其他用户有执行位，不依赖额外组授权。工具不会递归创建或修改未知祖先，不对共享目录递归 chmod/chown。目标 release 目录必须不存在，其最后一级固定为 manifest 全摘要，避免同一源码提交的不同架构或构建载荷混淆；父路径可由输入显式选择，不依赖示例路径。

将[自动网关合成输入](../examples/automatic-gateway-deployment.json)复制到目标的私有输入，按实地核验结果替换全部角色参数、UID、origin、端口、bootstrap、核心摘要和私有 controller secret。输入必须是 root 所有、0600 的普通单链接文件，输入及生成计划不得放进载荷或提交。release 三个路径必须按同一目标设置：

```text
runtime.sourceDirectory = RELEASE/source
runtime.binaryPath = RELEASE/bin/mihomo
management.serverEntry = RELEASE/server/.output/server/index.mjs
runtime.binarySha256 = manifest.components.mihomo.binarySha256
```

这里 `RELEASE` 表示上面的实际变量值，JSON 中写替换后的绝对字符串，不写字面变量。接口、IPv4、前缀、MAC、受管来源、mark、表与优先级必须是操作者显式核验的输入。样本的文档地址、接口和 secret 均不可直接使用。管理后端固定 loopback；远程 origin 必须有按该 origin 配置并校验证书、Host/协议头和 WebSocket 的专用 HTTPS 反向代理。安装入口不配置代理、不开放端口，不能只填一个 HTTPS origin 就宣称远程管理可用。

## 2. 只读预检与计划审阅

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"

"$NODE" --experimental-strip-types "$PAYLOAD/source/apps/cli/main.ts" \
  deployment-plan --input "$INPUT" --output /etc/cocoproxy-install/plan.json
```

第一条命令没有 `--apply`，不创建目录、锁、临时文件或收据，不执行服务变更或网络 helper。它验证清单摘要、每个文件大小和摘要、完整文件集合、禁止的本地数据和链接、ELF 架构、计划约束、服务身份、root 信任边界、精确归属、停止/禁用条件及网络冲突。预览只列目标、权限、动作和保留路径；不打印 controller secret、订阅或 credential。第二条生成包含秘密的 0600 私有八文件计划，供操作者审阅原始定义；安装入口重新调用同一 renderer，不接受任意待写文件清单。生成计划是明确的私有文件写入，独立于只读预检。

典型拒绝原因与后续动作：

| 错误码 | 操作者需要处理的条件 |
| --- | --- |
| `INSTALL_LINUX_ROOT_REQUIRED` / `INSTALL_SYSTEMD_REQUIRED` | 在受支持的目标 Linux root 环境运行；不能在开发机或普通容器假装完成安装 |
| `INSTALL_REQUIRED_SYSTEM_TOOL_MISSING` / `INSTALL_NODE_22_18_REQUIRED` / `INSTALL_PYTHON_3_9_REQUIRED` | 在另行获准的软件准备步骤中提供所需工具或版本，再重试；入口不安装软件 |
| `INSTALL_DEDICATED_ACCOUNT_REQUIRED` | 预置输入明确指定的唯一 UID 和非登录专用账号，复核已有授权 |
| `INSTALL_TUN_REQUIRED` / `INSTALL_IPV4_FORWARDING_REQUIRED` / `INSTALL_INGRESS_ADDRESS_REQUIRED` | 审阅内核设备、转发和输入接口地址；由操作者另行配置，工具不推断替代值 |
| `INSTALL_CORE_ARCH_UNSUPPORTED` | 使用已审阅且与目标主机相符的核心载荷；不使用任意替代二进制绕过清单 |
| `INSTALL_SERVICES_MUST_BE_STOPPED` / `INSTALL_UNITS_MUST_BE_DISABLED` | 先按维护流程停止并禁用自有 unit，核对 drop-in 和 daemon-reload 状态 |
| `INSTALL_LIFECYCLE_MUST_BE_PAUSED` / `INSTALL_LIFECYCLE_INVALID` | 以服务身份成功执行 runtime-pause；损坏标记须核查，不能删文件绕过维护保护 |
| `INSTALL_*_CONFLICT` / `INSTALL_NETWORK_REMOVE_REQUIRED` | 查明资源归属；先显式安全退役自有网络，不删除未知规则或上游资源 |
| `INSTALL_ROOT_OWNERSHIP_REQUIRED` / `INSTALL_OWNED_FILE_CHANGED` | 检查指定目录和已安装文件；不通过递归改权限或覆盖他人修改绕过拒绝 |
| `INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE` / `INSTALL_PREVIOUS_APPLY_INCOMPLETE` | 停止普通安装流程，检查 root 私有 receipt 与实际文件；不删除收据后假装首次安装 |

详细系统查询失败只返回固定错误码，避免把含秘密的输入或子进程输出混入默认日志。应在目标私有运维记录中调查具体系统条件。

## 3. 显式安装与服务准备

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
```

工具仅创建计划的缺失专用目录、root 控制的完整 release、计划中的八个文件，以及独立的 root:0700 `/var/lib/cocoproxy-deployment` 收据目录；文件按计划的 root/服务 UID 与 0644/0600 安装，release 目录为 root:0755、普通文件 0644、可执行文件 0755。完成后执行 `systemctl daemon-reload`，保持所有服务停止且未 enable，不生成管理员密码或修改任何订阅和状态。

receipt 只记录自有目标、权限和摘要，不保存文件内容或凭据副本。它在写目标前持久记录 `pending`，全部完成后变为 `complete`；进程失败或断电可能留下部分安装及持久锁。工具拒绝自动覆盖或恢复这类状态。操作者须在维护窗口逐项审阅 receipt、目标字节和 systemd 状态后进行精确恢复；没有无条件重试、递归删除或凭据备份。安装期间由单一可信操作者控制输入、载荷与目录，普通文件 API 不能防御并发恶意 root 更换路径。

初次安装且不存在 credential 时，使用现有 `admin-init`。先在目标的私有 0600 文件中提供 `{"username":"<admin-name>","password":"<private-password>"}`，将占位符替换为选定的 ASCII 用户名及私有强口令；字段约束见[管理模块](../packages/management/README.md)。不要把密码放在命令参数、仓库、载荷或示例文件中。以下命令只创建唯一 credential，已有文件时不得执行覆盖：

```sh
ADMIN_INPUT=/etc/cocoproxy-install/admin-login.json
"$NODE" --experimental-strip-types "$RELEASE/source/apps/cli/main.ts" \
  admin-init --input "$ADMIN_INPUT" --output /etc/cocoproxy/admin.json
chown cocoproxy:root /etc/cocoproxy/admin.json
chmod 0600 /etc/cocoproxy/admin.json
```

示例中的 `cocoproxy` 和 credential 路径必须与私有输入相同。已有 credential 直接保留，升级不重新初始化。明文登录输入的后续保留/清理由操作者在原私有位置管理，安装工具不复制或备份。root 可按审阅计划核验 `systemd-analyze verify` 的 unit 定义及 polkit 权限：专用身份只可 start/stop 固定核心，原生网关另可 start/reload 固定网络单元；其他 unit、restart、enable 和通用提权均应拒绝。

确认 HTTPS 代理和 credential 就绪后显式启动管理服务：

```sh
systemctl start cocoproxy-management.service
```

管理登录后，按[使用说明](usage.md)导入订阅、选择方案并应用；候选捕获和运行 CAS 由工作区流程内部完成，不绕过事务直接裸启动 Mihomo。自动网关核心启动会依赖 root 网络 oneshot，它执行固定 `prepare` 并创建 guard、出口及回程规则，属于已审阅的显式网络激活，不能把这一步称为安装预检。管理健康响应只证明管理服务响应，不能作为网关就绪依据。

## 4. 接入与终端验收

通过协同路由器的管理界面或受支持的命令入口填写网关角色参数。**LAN 模式要求双方配置相同的精确接入子网，覆盖其中普通 IPv4 客户端并阻断受管公网 IPv6；兼容单终端模式仍可显式选用。** 至少验证两个客户端和新加入地址，不能从单终端通过推导整个 LAN 已验收。路由器端保持自身管理和独立关闭入口可达，首次接入时核验核心、接管、DNS、来源保留、出口和回程。已验收组合的日常应用可使用有界的新鲜网关 DNS 预检；该检查只证明局部可达，完整路径状态仍须如实标记，见[协作说明](cooperating-router-requirements.md)。CoCoProxy 安装工具不替路由器修改配置。服务开机启用由操作者在验收后另行决定，例如 `systemctl enable cocoproxy-management.service`；后续维护先禁用，不能把 enable 与首次安装合并。

验收至少包含 IPv4 TCP/UDP、路由器转交的 DNS、局域网管理、本机原有出口不被接管、未支持 IPv6 在受管范围阻断、核心停止时受管外网阻断，以及核心仍停止时从路由器独立关闭后终端恢复普通直连。业务站点成功、systemd active、Mihomo `-t` 与 HTTP health 各自只覆盖局部条件。具体测量、真实角色参数和恢复笔记保持私有；正式结论只记录组件版本、双方提交及脱敏范围。

## 关闭、升级与卸载

用户关闭由路由器撤销交付并恢复其 DNS 完成；停止核心保留 guard，不能代替用户关闭。持久运行的启用、sysctl 与地址准备见[总指南第 8 节](getting-started.md#8-启用持久运行与自动恢复)。升级/卸载先以服务身份执行 pause，成功后完成路由器侧关闭，再停服务。变量必须与实际部署一致：

```sh
SERVICE_USER=cocoproxy
STATE_DIR=/var/lib/cocoproxy
RUNTIME_SETTINGS=/etc/cocoproxy/runtime.json
CLI="$RELEASE/source/apps/cli/main.ts"
runuser -u "$SERVICE_USER" -- "$NODE" --experimental-strip-types "$CLI" \
  runtime-pause --state-dir "$STATE_DIR" --runtime-settings "$RUNTIME_SETTINGS"
```

pause 成功表示已排空管理协调；仍须停止服务并核验 MainPID/Job 清零。维护标记跨重启保留并阻止核心启动器执行。不要只 pause 就认为现有核心已停止。

```sh
systemctl disable --now cocoproxy-management.service
systemctl disable --now cocoproxy-mihomo.service
systemctl stop cocoproxy-gateway-network.service
systemctl disable --now cocoproxy-gateway-guard.service
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall
```

最后一条仍是只读预览，有网络资源时预期拒绝。需先确认核心已停、TUN 和上游资源已消失，且自有网络回执完整、资源与设置全部相符，再执行既有 helper：

```sh
/usr/bin/python3 -I "$RELEASE/source/apps/gateway/network.py" remove \
  --settings /etc/cocoproxy/gateway-network.json
```

网络设置路径应采用当前已安装计划的确切值。helper 对完整回执和资源严格核验，guard 最后移除；它拒绝不完整收据、未知资源和跨 boot 不匹配，不清理上游残留。若网络服务从未 prepare 且不存在网络资源或回执，无须调用 remove。安装入口只读检查“无冲突且回执已 removed/不存在”，不会调用 remove，也不根据停止状态臆测资源已经安全移除。

升级时装配并传送新载荷，保存新 manifest 摘要；准备新私有输入，将 source/binary/server 路径改为新摘要目录，核心摘要改为新载荷摘要，其余管理、secret、网络和身份配置保持一致。将 `PAYLOAD`、`MANIFEST_SHA`、`INPUT`、`DEPLOY` 指向**新**载荷和输入，先预览再应用：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation upgrade
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation upgrade --apply
```

升级只接受当前 complete receipt、所有旧自有文件字节/权限/身份与旧 release 清单一致的新版本。旧七文件自动网关允许唯一的受控扩展：新增固定 root 所有的 `cocoproxy-gateway-guard.service`，且目标原先必须不存在；不允许借此增删其他文件。默认发现人工修改、secret/网络/管理配置变化或未知安装一律拒绝；配置迁移须单独审阅并使用下述显式摘要入口。它保留管理员 credential、订阅、草稿、事务及生命周期状态，更新新的 runtime release 引用和 unit；旧 release 也保留以便审阅，工具不自动回滚活跃事务或复制秘密。升级后更新 RELEASE/CLI，恢复管理及网页，检查保留配置与当前部署匹配，再以服务身份 runtime-resume、重新启用早期保护/管理/网页，恢复路由器交付并验收。此前从未启用生命周期时使用 runtime-enable。

需要迁移网络范围或管理许可时，先审阅新私有输入及 `renderDeploymentPlan` 输出。显式 `--reviewed-configuration-sha256` 仅对 upgrade 生效；它绑定旧/新 manifest、新输入**原始字节**摘要和全部旧敏感受管文件的路径/摘要。旧收据、文件归属、服务身份、状态/凭据路径、受管文件路径集合、完整 schema 及停止/网络无冲突检查仍必须通过。输入重新排版、旧配置或载荷变化后原审阅摘要失效；不修改 `/etc` 或 receipt 来绕过核验。

经审阅后，可以用以下只读计算取得 `CONFIG_REVIEW_SHA`（仅输出摘要，无设置内容）：

```sh
"$NODE" --experimental-strip-types --input-type=module - \
  "$PAYLOAD/source/packages/deployment/install.ts" "$INPUT" "$MANIFEST_SHA" <<'JS'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { configurationReviewDigest } = await import(pathToFileURL(process.argv[2]).href);
const previous = JSON.parse(await readFile('/var/lib/cocoproxy-deployment/receipt.json', 'utf8'));
console.log(configurationReviewDigest({ previousManifestSha256: previous.manifestSha256,
  manifestSha256: process.argv[4], inputSha256: createHash('sha256').update(await readFile(process.argv[3])).digest('hex'),
  previousConfiguration: previous.files.filter(file => file.sensitive).map(({ path, sha256 }) => ({ path, sha256 })) }));
JS

"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" \
  --operation upgrade --reviewed-configuration-sha256 "$CONFIG_REVIEW_SHA"
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" \
  --operation upgrade --reviewed-configuration-sha256 "$CONFIG_REVIEW_SHA" --apply
```

该入口只安装新定义，不启动服务或迁移活跃候选。扩大网关范围时须在旧 helper 和旧设置仍有效时先退役旧网络，升级后先启动管理，经工作区重新应用生成与新范围匹配的候选，再开启路由器交付。新候选失败后旧候选可能无法在新范围设置下回滚，应保持路由器关闭并恢复匹配的设置，再显式恢复事务。审阅摘要错误返回 `INSTALL_CONFIGURATION_REVIEW_MISMATCH`；默认缺少明确审阅时返回 `INSTALL_CONFIGURATION_CHANGE_REQUIRES_REVIEW`。

卸载使用**当前已安装**摘要及原输入，在安全移除网络后运行：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall --apply
```

卸载只删除收据匹配的 unit 和 polkit 文件并 daemon-reload。默认保留全部私有设置、管理员 credential、业务状态、网络退役收据、安装收据和所有 release，不递归删除目录，不卸载系统软件/账户，不清理 HTTPS 代理、路由器或未知网络资源。收据标记 `uninstalled` 后普通 install/upgrade 拒绝冒认已有私有状态；重新启用或彻底销毁资料属于独立的精确审阅步骤。本入口不提供清空数据选项。

既有手工安装没有本工具的 complete receipt，不能直接升级，也不能补写摘要冒认自有文件。迁移时先按旧部署计划关闭交付、停服务并安全 remove 网络，再逐个审阅旧七文件的内容和归属、撤下确认属于旧安装的文件，保留状态和 credential；之后按首次安装流程进入新 release。原 settings 中的真实 secret 与网络参数从原私有主本核对，不放进发行包或生成多份凭据备份。
