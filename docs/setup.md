# 统一部署入口

本入口将环境事实转换为原安装器接受的私有部署输入，复用载荷、字段、权限和归属校验。完整接线、证书及终端验收见[从零部署](getting-started.md)，设备边界见[支持矩阵](support-matrix.md)。

发行包解压后使用根目录 `cocoproxy`；源码目录使用 `sh scripts/cocoproxy-setup.sh` 或 `npm run setup --`。以下命令在已核验发行包及获准目标 Linux 中执行，路径是合成角色示例，须替换实际值。

需要自动组织安装或更新时，使用 `sudo ./cocoproxy deploy --local` 在本机执行，或 `./cocoproxy deploy <IP>` 从另一台电脑通过 SSH 执行。首次安装还需私有环境与管理员输入，参数、预览及更新状态保留见[本机与远程部署更新](deployment.md)。本地模式无需本机 SSH 服务；下面保留逐步配置、预检和维护入口。

## 1. 盘点环境

```sh
sh ./cocoproxy check
sh ./cocoproxy doctor
sh ./cocoproxy doctor --environment /absolute/private/environment.json
```

check 只检查基础工具，不依赖 Node。doctor 只读汇总 Linux/架构、Node、systemd、Python、ip/nft、polkit、TUN、转发、身份/路径、网络资源、端口及安装状态；不安装软件、创建账户、运行网络 helper 或修复权限。环境 JSON 格式失败不妨碍独立基础检查，私有文件读取/JSON 解析失败仍走 CLI 原错误出口。

| 报告层 | 范围及使用边界 |
| --- | --- |
| foundation/components | 系统、版本、字段格式和已有组件；名称存在不证明运行能力 |
| identity | 唯一非登录服务 UID、root 可信工具链接链、目录归属及服务遍历；最终安装重查实际计划 |
| network | TUN/转发/地址、策略优先级及 mark、路由/nft 表、TUN 名和回执；不求解完整策略路由，未知表达式拒绝推断 |
| management | 计划地址/协议端口的当次 socket 观察；受管 HTTPS 核对既有 nginx、证书有效期/SAN/密钥及权限，不证明终端信任 |
| installation | 收据、文件/发布漂移、锁/journal、维护状态和身份布局；未知安装不自动接管 |

报告兼容 schemaVersion:1，保留 checks、serviceUid、readyForInstallPreflight，以及每项 id/status/required/message；layer/code/reason/action 提供固定原因及方向，读取者应允许未知字段。layers 的 partial/not-assessed 只是覆盖范围，没有整层通过结论。pass 仅覆盖该项观察，fail 为已知不符，unknown 为权限/超时/失败或不可解析；必要项 fail/unknown 均阻止准备通过。readyForInstallPreflight 只表示可继续完整安装预检。

| 原因码 | 处理方向 |
| --- | --- |
| SETUP_REQUIREMENT_NOT_MET / SETUP_REQUIRED_COMPONENT_MISSING | 条件不符或可信 ENOENT 确认缺失，按具体 action 准备后重查 |
| SETUP_CHECK_UNAVAILABLE / SETUP_OBSERVATION_INVALID | 查询受限/失败或不可解析，先核对权限及工具，不能按空结果或依赖缺失处理 |
| SETUP_ENVIRONMENT_REQUIRED / SETUP_ENVIRONMENT_INVALID | 补正私有环境输入 |
| SETUP_EXTERNAL_VERIFICATION_REQUIRED | 路由器、反代或终端实际验收尚未完成 |
| SETUP_PORT_CONFLICT / SETUP_PORT_OWNED_REQUIRES_STOP | 新占用须查归属；确属本安装仍须按维护流程停服 |
| SETUP_PORT_OWNERSHIP_UNKNOWN / SETUP_PORT_OBSERVATION_INCOMPLETE | 绑定、归属或查询证据不足，不能终止未知进程 |
| SETUP_INSTALLATION_INCOMPLETE / BUSY / DRIFT | 分别审阅中断记录、存活操作或文件漂移，不删锁/收据过检 |
| SETUP_MAINTENANCE_REQUIRED / SETUP_INSTALLATION_IDENTITY_MISMATCH | 先暂停持久运行，或核对已有 UID/布局 |

账户使用原 SETUP_SERVICE_ACCOUNT_*，HTTPS 使用原 SETUP_HTTPS_*；可信路径/资源检查复用安装器 INSTALL_* 原因码，不另维护一份判定。工具链接逐层核对 root 归属、不可写祖先及可执行条件，允许受信发行版链接。网络保留核心优先级/mark/表及 TUN，回执只接受不存在或 removed；已占用资源不因看似自有就视为空闲。

端口使用已有可信 ss 的 IPv4/IPv6 TCP/UDP 监听及连接观察，按计划地址/协议区分；自有占用须收据、unit、无 override 的主进程、executable 和 cgroup 同时匹配。双栈/复用或查询不完整为 unknown。可选 ss -B 未支持时以非必要 SETUP_PORT_BOUND_SCOPE_UNAVAILABLE 说明缺口，发现冲突仍阻断。报告不打印实际路径、PID、地址或原始系统输出；快照通过不保证稍后绑定。

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

第一条只读。第二条才安装文件并 daemon-reload，仍不启动服务。随后按[安装与维护](deployment.md)准备管理员和[HTTPS](management-https.md)，完成首次应用、路由器交付、终端验收及[持久运行](getting-started.md#8-启用持久运行与自动恢复)。HTTPS 登录仍需在实际终端验收证书信任。

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

`prepare` 允许服务仍运行，但不表示已经可以执行升级；应用阶段会重新要求暂停、停用服务和退役网络。`inspect` 读取收据、锁和文件证据。`recover` 默认仅预览：只有新事务已写完全部预期字节、原进程已退出且当前状态满足约束时，才允许用返回的审阅摘要显式收尾。它不重试部分写入，不删除未知锁，不进行程序降级。详细步骤见[安装中断检查与恢复](deployment.md#升级准备与中断恢复)。

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

[生命周期入口](deployment.md#机器状态与生命周期)把初始化、管理启动、持久运行启用、暂停及停机退役组织为可预览步骤：

```sh
sh ./cocoproxy lifecycle --action start-management --input "$INPUT"
sh ./cocoproxy lifecycle --action start-management --input "$INPUT" \
  --apply --reviewed-plan-sha256 '<本次预览返回的摘要>'
```

入口核对当前完整安装收据、输入和文件字节，执行时与安装/恢复共用互斥条件。初始化另外指定私有 `--admin-input`；完整步骤及各动作的条件见生命周期说明。`--terminal-path-verified`、`--router-disabled` 记录操作者已完成实际验收或关闭的确认，不是工具自己观测到的网络证据。

从另一台电脑安装或更新时使用[SSH 部署入口](deployment.md)，由该入口协调目标上的安装、服务和已有路由器适配器；它不要求在本机执行 Linux 服务命令。

## 输出边界

环境、部署输入及路由器参数含真实网络或秘密，保留在目标私有位置；仓库内调试材料只放被忽略的 `.local/`，不进入发行、同步或公开附件。命令默认只打印固定结果与必要状态，不打印内部秘密或环境 JSON。

`configure` 的部署输出与可选路由器输出分别使用独占新建，并非跨文件原子事务。如果第二个输出失败，第一个私有部署输入可能已经生成；检查已有文件后选择新的输出路径，不覆盖或反复生成内部秘密。
