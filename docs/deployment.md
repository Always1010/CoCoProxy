# 可重复的 Linux 外接网关部署

Coproxy 的部署单位是两个角色：接入路由器保留终端接入、网关和 DNS 入口、受管来源选择、交付开关及独立的关闭恢复；外接 Linux 主机运行固定 Mihomo、MetaCubeXD 管理服务和小型网络前置单元。角色不绑定路由器或主机型号。接入路由器必须具备经过适配的策略交付、来源保留、DNS 转交、受管 IPv6 阻断及独立关闭能力；封闭固件能否满足这些条件要逐项核验，不能因为能联网就视为可以安装网关。

`apps/deployment/main.ts` 是离线、单目标的安装入口。它复用[发行载荷](release-staging.md)及 `renderDeploymentPlan`；自动网关模式安装现有计划的七个文件及目录，显式代理模式为五个文件。默认只读核验并输出不含文件内容的预览，只有 `--apply` 写入目标。工具不通过 SSH 控制另一台设备，不探测或推断地址，不安装依赖、账户、HTTPS 代理或证书，不改默认路由、系统 DNS、sysctl，不启动或启用服务。完整部署还包括下面明确列出的准备、配置、启动和终端验收。

## 支持边界与前置审阅

| 项目 | 安装能力 | 验证含义 |
| --- | --- | --- |
| Linux ARM64 | 仅接受已审阅 manifest 中的 ELF64 little-endian AArch64 核心，并核对目标架构 | 已有 ARM64 Linux/systemd 的核心、管理与终端链路验收；新安装入口的验证独立记录，不能由既有手工安装推导 |
| Linux AMD64 | 提供固定审核核心载荷与自动网关参数的安装支持，入口核对 ELF64 x86-64、目标架构和固定摘要 | 尚未在 x86 真机执行核心或系统服务；官方资产摘要与 ELF 文件校验不代表内核或终端链路已验收，须在目标机完整验收 |
| 其他架构、Windows、macOS、无 systemd Linux | 当前入口拒绝 | 不是支持承诺；不能把开发机上的离线测试当成目标安装验证 |
| 接入路由器 | 通过[协作语义](router-cooperation.md)适配角色能力 | 不提供任意型号或任意固件的安装承诺；支持组合须记录双方版本和实际验收范围 |

新安装入口已通过 Linux root/mount/network namespace 隔离验证：只读预检、七文件权限/摘要、人工改动拒绝升级及卸载、第二载荷升级、私有状态/管理员凭据保留、卸载保留 release 与收据状态均符合预期；命名空间与宿主网络前后不变。该验证使用受控的 systemctl 替身，只核对查询和 daemon-reload 调用，复制既有审核 ARM64 核心字节而不执行核心，不能代替真实 systemd/polkit 启动或终端链路验收。离线清单、路径和链接风险由 `tests/deployment-install.test.ts` 覆盖，严格 TypeScript 检查已通过。

目标主机需预置 Node.js ≥22.18、systemd、支持 JavaScript `.rules` 的 polkit、唯一的非 root 专用服务账号、root 控制的系统可执行文件及安装父目录。专用账号须使用 `nologin` 或 `false` shell；账号名和固定 UID 来自私有输入，不能复用交互登录账号。工具通过现有 `getent` 验证身份，不创建账户或修改组。应另行审阅该账号既有 sudo/polkit 权限和规则顺序，确保没有更早规则授予任意单元、manage-unit-files 或 root shell；安装工具不能证明所有既有授权都安全。

自动网关还要求 Python ≥3.9、`/usr/sbin/ip`、`/usr/sbin/nft`、可用的 `/dev/net/tun`、内核 TUN/nftables/策略路由能力、已显式配置的 `net.ipv4.ip_forward=1`，以及输入指定接口已 UP 且配置了指定 IPv4/前缀。ip/nft 必须支持现有 helper 使用的 JSON 参数与规则。工具只读检查上述条件，不通过创建 TUN、`nft prepare` 或修改 sysctl 来“试验”能力；具体内核能力还需在独立网络启动与验收中证明。发行版对 sandbox、SELinux/AppArmor、挂载和 capability 的限制也须现场审阅。

首次安装、升级和卸载都要求 `coproxy-mihomo.service`、`coproxy-management.service`、`coproxy-gateway-network.service` 已停止且未 enable，没有 drop-in、运行时替代 unit 或待 reload 的定义。已有自有网络资源必须先通过既有 helper 安全退役，工具不会在只读预检中调用 `prepare`。它核对 guard、部署出口表/规则、客户端回程与上游保留资源均无冲突；存在网络回执时只接受 `removed`。因此升级需要一个明确的维护窗口。

涉及本机环境或设备的变更前，按各自管理约定取得相应许可并明确目标和影响。准备账户、软件、内核模块、IPv4 转发、网口地址、HTTPS 反向代理、证书及路由器交付均属于显式的前置运维步骤，不能从一次只读预检推导其变更授权。

## 1. 装配、传送与私有输入

在构建环境按[发行装配说明](release-staging.md)生成干净载荷，保存成功回执给出的 `manifestSha256`。通过操作者选择的传输方式将**该载荷目录**复制到目标 Linux；不要复制整个仓库、载荷父目录、`.local/` 或跟随本地目录链接。安装工具不下载组件，也不执行 npm。目标上的载荷及全部文件、目录和祖先必须由 root 控制且不可由组/其他用户写入，没有符号链接、硬链接或特殊文件。

以下命令均在**已获准的目标 Linux root shell**执行；路径是合成角色示例。`MANIFEST_SHA` 应填入构建端单独记录并核验的 64 位 SHA-256，不能仅对未知来源的 manifest 自算摘要就视为可信。运行载荷里的入口本身已在执行代码，须在执行前核验载荷来源和清单，不把运行入口当成对任意未知代码的安全沙箱。

```sh
PAYLOAD=/srv/coproxy-staging/release
MANIFEST_SHA='<构建端记录的64位manifest摘要>'
INPUT=/etc/coproxy-install/deployment.json
NODE=/usr/bin/node
RELEASE="/opt/coproxy/releases/$MANIFEST_SHA"
DEPLOY="$PAYLOAD/source/apps/deployment/main.ts"
sha256sum "$PAYLOAD/manifest.json"
```

操作者先准备 root 控制的载荷目录、输入父目录和 release 父目录，例如 `/srv/coproxy-staging`、`/etc/coproxy-install`、`/opt/coproxy/releases`。入口使用规范绝对路径，不接受空白或 `.local` 路径段；这些位置不能通过链接或服务账号可写目录到达。服务使用的 root 目录还须允许其遍历；入口保守要求相应祖先对其他用户有执行位，不依赖额外组授权。工具不会递归创建或修改未知祖先，不对共享目录递归 chmod/chown。目标 release 目录必须不存在，其最后一级固定为 manifest 全摘要，避免同一源码提交的不同架构或构建载荷混淆；父路径可由输入显式选择，不依赖示例路径。

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
  deployment-plan --input "$INPUT" --output /etc/coproxy-install/plan.json
```

第一条命令没有 `--apply`，不创建目录、锁、临时文件或收据，不执行服务变更或网络 helper。它验证清单摘要、每个文件大小和摘要、完整文件集合、禁止的本地数据和链接、ELF 架构、计划约束、服务身份、root 信任边界、精确归属、停止/禁用条件及网络冲突。预览只列目标、权限、动作和保留路径；不打印 controller secret、订阅或 credential。第二条生成包含秘密的 0600 私有七文件计划，供操作者审阅原始定义；安装入口重新调用同一 renderer，不接受任意待写文件清单。生成计划是明确的私有文件写入，独立于只读预检。

典型拒绝原因与后续动作：

| 错误码 | 操作者需要处理的条件 |
| --- | --- |
| `INSTALL_LINUX_ROOT_REQUIRED` / `INSTALL_SYSTEMD_REQUIRED` | 在受支持的目标 Linux root 环境运行；不能在开发机或普通容器假装完成安装 |
| `INSTALL_REQUIRED_SYSTEM_TOOL_MISSING` / `INSTALL_NODE_22_18_REQUIRED` / `INSTALL_PYTHON_3_9_REQUIRED` | 在另行获准的软件准备步骤中提供所需工具或版本，再重试；入口不安装软件 |
| `INSTALL_DEDICATED_ACCOUNT_REQUIRED` | 预置输入明确指定的唯一 UID 和非登录专用账号，复核已有授权 |
| `INSTALL_TUN_REQUIRED` / `INSTALL_IPV4_FORWARDING_REQUIRED` / `INSTALL_INGRESS_ADDRESS_REQUIRED` | 审阅内核设备、转发和输入接口地址；由操作者另行配置，工具不推断替代值 |
| `INSTALL_CORE_ARCH_UNSUPPORTED` | 使用已审阅且与目标主机相符的核心载荷；不使用任意替代二进制绕过清单 |
| `INSTALL_SERVICES_MUST_BE_STOPPED` / `INSTALL_UNITS_MUST_BE_DISABLED` | 先按维护流程停止并禁用自有 unit，核对 drop-in 和 daemon-reload 状态 |
| `INSTALL_*_CONFLICT` / `INSTALL_NETWORK_REMOVE_REQUIRED` | 查明资源归属；先显式安全退役自有网络，不删除未知规则或上游资源 |
| `INSTALL_ROOT_OWNERSHIP_REQUIRED` / `INSTALL_OWNED_FILE_CHANGED` | 检查指定目录和已安装文件；不通过递归改权限或覆盖他人修改绕过拒绝 |
| `INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE` / `INSTALL_PREVIOUS_APPLY_INCOMPLETE` | 停止普通安装流程，检查 root 私有 receipt 与实际文件；不删除收据后假装首次安装 |

详细系统查询失败只返回固定错误码，避免把含秘密的输入或子进程输出混入默认日志。应在目标私有运维记录中调查具体系统条件。

## 3. 显式安装与服务准备

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
```

工具仅创建计划的缺失专用目录、root 控制的完整 release、计划中的七个文件，以及独立的 root:0700 `/var/lib/coproxy-deployment` 收据目录；文件按计划的 root/服务 UID 与 0644/0600 安装，release 目录为 root:0755、普通文件 0644、可执行文件 0755。完成后执行 `systemctl daemon-reload`，保持所有服务停止且未 enable，不生成管理员密码或修改任何订阅和状态。

receipt 只记录自有目标、权限和摘要，不保存文件内容或凭据副本。它在写目标前持久记录 `pending`，全部完成后变为 `complete`；进程失败或断电可能留下部分安装及持久锁。工具拒绝自动覆盖或恢复这类状态。操作者须在维护窗口逐项审阅 receipt、目标字节和 systemd 状态后进行精确恢复；没有无条件重试、递归删除或凭据备份。安装期间由单一可信操作者控制输入、载荷与目录，普通文件 API 不能防御并发恶意 root 更换路径。

初次安装且不存在 credential 时，使用现有 `admin-init`。先在目标的私有 0600 文件中提供 `{"username":"<admin-name>","password":"<private-password>"}`，将占位符替换为选定的 ASCII 用户名及私有强口令；字段约束见[管理模块](../packages/management/README.md)。不要把密码放在命令参数、仓库、载荷或示例文件中。以下命令只创建唯一 credential，已有文件时不得执行覆盖：

```sh
ADMIN_INPUT=/etc/coproxy-install/admin-login.json
"$NODE" --experimental-strip-types "$RELEASE/source/apps/cli/main.ts" \
  admin-init --input "$ADMIN_INPUT" --output /etc/coproxy/admin.json
chown coproxy:root /etc/coproxy/admin.json
chmod 0600 /etc/coproxy/admin.json
```

示例中的 `coproxy` 和 credential 路径必须与私有输入相同。已有 credential 直接保留，升级不重新初始化。明文登录输入的后续保留/清理由操作者在原私有位置管理，安装工具不复制或备份。root 可按审阅计划核验 `systemd-analyze verify` 的 unit 定义及 polkit 权限：专用身份只可 show/start/stop 固定核心，restart/reload、其他 unit、enable 均应拒绝。

确认 HTTPS 代理和 credential 就绪后显式启动管理服务：

```sh
systemctl start coproxy-management.service
```

管理登录、草稿与订阅导入后，保存策略、捕获候选 generation，再通过已有 expectedActive CAS 应用；不要绕过既有事务直接裸启动 Mihomo。自动网关核心启动会依赖 root 网络 oneshot，它执行固定 `prepare` 并创建 guard、出口及回程规则，属于已审阅的显式网络激活，不能把这一步称为安装预检。管理健康响应只证明管理服务响应，不能作为网关就绪依据。

## 4. 接入与终端验收

按接入路由器项目的显式配置入口填写网关角色参数，先限定一台测试终端。路由器端保持自身管理和独立关闭入口可达，在核验核心、接管、DNS、来源保留、出口和回程的新鲜观察后才启用交付。Coproxy 安装工具不替路由器修改配置。服务开机启用由操作者在验收后另行决定，例如 `systemctl enable coproxy-management.service`；后续维护先禁用，不能把 enable 与首次安装合并。

验收至少包含 IPv4 TCP/UDP、路由器转交的 DNS、局域网管理、本机原有出口不被接管、未支持 IPv6 在受管范围阻断、核心停止时受管外网阻断，以及核心仍停止时从路由器独立关闭后终端恢复普通直连。业务站点成功、systemd active、Mihomo `-t` 与 HTTP health 各自只覆盖局部条件。具体测量、真实角色参数和恢复笔记保持私有；正式结论只记录组件版本、双方提交及脱敏范围。

## 5. 关闭、升级与卸载

用户关闭由路由器撤销交付并恢复其 DNS 完成；停止核心保留 guard，不能代替用户关闭。升级/卸载先完成路由器侧关闭，然后在 Linux 上显式维护：

```sh
systemctl disable --now coproxy-management.service
systemctl disable --now coproxy-mihomo.service
systemctl stop coproxy-gateway-network.service
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall
```

最后一条仍是只读预览，有网络资源时预期拒绝。需先确认核心已停、TUN 和上游资源已消失，且自有网络回执完整、资源与设置全部相符，再执行既有 helper：

```sh
/usr/bin/python3 -I "$RELEASE/source/apps/gateway/network.py" remove \
  --settings /etc/coproxy/gateway-network.json
```

网络设置路径应采用当前已安装计划的确切值。helper 对完整回执和资源严格核验，guard 最后移除；它拒绝不完整收据、未知资源和跨 boot 不匹配，不清理上游残留。若网络服务从未 prepare 且不存在网络资源或回执，无须调用 remove。安装入口只读检查“无冲突且回执已 removed/不存在”，不会调用 remove，也不根据停止状态臆测资源已经安全移除。

升级时装配并传送新载荷，保存新 manifest 摘要；准备新私有输入，将 source/binary/server 路径改为新摘要目录，核心摘要改为新载荷摘要，其余管理、secret、网络和身份配置保持一致。将 `PAYLOAD`、`MANIFEST_SHA`、`INPUT`、`DEPLOY` 指向**新**载荷和输入，先预览再应用：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation upgrade
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation upgrade --apply
```

升级只接受当前 complete receipt、所有旧自有文件字节/权限/身份与旧 release 清单一致的新版本。发现人工修改、secret/网络/管理配置变化或未知安装一律拒绝；配置迁移须单独审阅，不混入升级。它保留管理员 credential、订阅、草稿、事务状态，更新新的 runtime release 引用和 unit；旧 release 也保留以便审阅，工具不自动回滚活跃事务或复制秘密。升级后按原启动/事务流程恢复并重做终端与故障验收。

卸载使用**当前已安装**摘要及原输入，在安全移除网络后运行：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --operation uninstall --apply
```

卸载只删除收据匹配的三个 unit 和 polkit 文件并 daemon-reload。默认保留全部私有设置、管理员 credential、业务状态、网络退役收据、安装收据和所有 release，不递归删除目录，不卸载系统软件/账户，不清理 HTTPS 代理、路由器或未知网络资源。收据标记 `uninstalled` 后普通 install/upgrade 拒绝冒认已有私有状态；重新启用或彻底销毁资料属于独立的精确审阅步骤。本入口不提供清空数据选项。

既有手工安装没有本工具的 complete receipt，不能直接升级，也不能补写摘要冒认自有文件。迁移时先按旧部署计划关闭交付、停服务并安全 remove 网络，再逐个审阅旧七文件的内容和归属、撤下确认属于旧安装的文件，保留状态和 credential；之后按首次安装流程进入新 release。原 settings 中的真实 secret 与网络参数从原私有主本核对，不放进发行包或生成多份凭据备份。
