# 从零部署与使用 CoCoProxy

本文面向第一次搭建的部署者，按硬件接线、环境准备、软件安装、路由器协作、后台使用和验收的顺序，完成一套可使用的局域网代理方案。日常使用者可以直接从[首次登录与基本使用](#6-首次登录与基本使用)开始。

当前版本是 **0.1.0-preview.1 体验版**，交付的是 Linux 软件。自动网关支持同一接入子网中的普通 IPv4 终端，受管公网 IPv6 会被阻断。持久运行需完成第 8 节的显式启用：设备重启、依赖晚启动和同 LAN 断线后，自动恢复上次成功提交的配置。实现、隔离验证与实机验收分别记录；ARM64、x86-64、新路由器组合及持续运行的实际证据以[发行说明](release-notes.md)为准，不能仅凭启用成功认定稳定性验收通过。

安装器可以按显式参数核验和安装软件；系统依赖、网口地址、HTTPS 和路由器协作需要部署者准备。CoCoProxy 目前没有自动探测任意网络、一键配置所有路由器的功能。完成下面的步骤后，普通终端无需逐台安装代理客户端；新增终端是否被正确覆盖仍须验收。

## 阅读路线与完成标准

可以先使用[统一部署入口](setup.md)盘点环境并生成私有输入，自动填写载荷摘要、release 路径和重复端口；本指南继续说明实际接线、系统准备、HTTPS、启用及终端验收。

安装前后都可用 `./cocoproxy status --input /absolute/private/deployment.json` 查询已完成、待办、当前等待与具体下一步。报告重新观察安装、管理员、管理服务、当前候选、核心与持久意图，继续列出尚无人工证据的路由器和终端项目。实际观察后，用 `./cocoproxy record-observations --input /absolute/private/deployment.json --facts /absolute/private/observed-facts.json --output /absolute/private/first-observations.json` 录入实际事实、终端别名、通知选择和可读事件时间；工具自动填写内部绑定及录入时间，不必手抄摘要或计算 Unix 毫秒。然后用 `status --evidence` 消费该私有文件，格式见[首次部署状态及人工记录](setup-lifecycle.md#记录当前部署范围的人工观察)。入口复用本机核心只读探针，不向管理 origin 或路由器发探测；管理 HTTPS、登录、终端信任和通知仍分别验收。通知未选择可明确记录为 `declined`，不必启用可选通知才能使用其他功能。报告齐全与第 9 节的真实完整验收分开。

| 阶段 | 在哪里操作 | 完成后应看到什么 |
| --- | --- | --- |
| 1–2：接线与参数 | 设备现场、路由器和 Linux | 各角色在同一 LAN，地址稳定，维护入口可用 |
| 3：系统准备 | Linux 外接设备 | 依赖、账户、内核和目录满足安装预检 |
| 4：安装软件 | Linux 外接设备 | 安装回执完成，服务尚未启动 |
| 5：管理入口 | Linux 与管理浏览器 | HTTPS 后台可登录 |
| 6：首次配置 | CoCoProxy 后台 | 订阅可用、配置生效、核心确认通过 |
| 7：开启交付 | 协同路由器 | 对应 LAN 的流量和公网 DNS 按约定交给外设 |
| 8：持久运行 | 外设与协同路由器 | 持久前置条件、自动恢复和独立关闭入口就绪 |
| 9：实际验收 | 至少两个终端及两端设备 | 代理、直连、本地访问、重启、断线恢复及保护符合预期 |

需要查细节时：[设备与路由器能力](cooperating-router-requirements.md)、[安装与维护](deployment.md)、[HTTPS 配方](management-https.md)、[后台使用](usage.md)。本页命令除特别说明外均在**目标 Linux 的 root shell**执行；不要直接粘贴到 Windows 开发机。

## 1. 准备硬件并接线

需要能接入上游网络的协同路由器、一台满足条件的 Linux 外接设备、管理电脑或手机，以及网线和稳定电源。路由器须满足[协作能力表](cooperating-router-requirements.md#路由器必须提供的行为)，不能仅凭有“静态路由”或“VPN”菜单判断适用。

最基本的单网口连接如下。交换机是可选的；如使用 VLAN，相关 LAN 端口和终端必须处于同一个接入子网，并允许所需转发。

```text
上游网络／光猫
      │
  路由器 WAN
┌────────────────────────────┐
│ 协同路由器                  │
│ 负责 DHCP、终端接入与交付开关 │
└──────────┬─────────────────┘
           │ LAN
       可选交换机
        ├── Linux 外接设备的 LAN 网口（运行 CoCoProxy）
        ├── 电脑／其他有线终端
        └── 同一 LAN 的无线接入点或路由器 Wi-Fi → 手机
```

1. 先让路由器通过 WAN 正常上网，确认终端经路由器能够普通直连。
2. 将 Linux 外设接到路由器 **LAN** 或同一 LAN 的交换机，为其供电。单网口即可同时承载交付、出站和回程；本方案不要求把外设串接在光猫与 WAN 之间。
3. 将管理终端接入同一 LAN。访客 Wi-Fi、客户端隔离和不同 VLAN 可能阻止访问外设，需按自己的网络设计处理。
4. 为外设准备稳定 IPv4，可采用经过核对的静态配置或 DHCP 保留，避免与地址池、其他主机冲突。路由器和外设应保留无需代理即可访问的维护方式。
5. 暂时保持路由器的 CoCoProxy 交付功能关闭。终端的默认网关和基础 DNS 仍指向路由器，不把 DHCP 网关改成外设。

属于同一逻辑 LAN、VLAN/PVID 和隔离策略一致的物理端口可以互换，无需重新绑定代理；路由器应按 LAN bridge／三层接口交付，不能把某个物理 LAN 口作为唯一入口。换口会短暂断线，启用持久运行后应自动恢复新连接。WAN、访客网络或其他 VLAN 不属于这一保证范围。

开启后的逻辑路径是：

```text
终端 → 路由器 → CoCoProxy → 同一路由器 WAN → 代理节点或直连网站
响应 → CoCoProxy → 路由器 → 终端
浏览器 → 外设的 HTTPS 入口 → CoCoProxy 管理服务
```

即使命中 DIRECT，已交付的流量也先经过 CoCoProxy。终端和外设物理上同处 LAN，不代表业务回程可以绕过路由器。

## 2. 记录自己的环境参数

以下是**文档专用的合成示例**，不是可直接使用的网络。把自己的值保存在私有部署记录中，再填写到配置；不要把真实订阅、口令、MAC 或个人拓扑提交到源码。

| 参数 | 合成示例 | 用在哪里 |
| --- | --- | --- |
| 接入 LAN | `192.0.2.0/24` | 两端受管来源范围；`automaticGateway.clientCIDR` |
| 路由器 LAN IPv4 | `192.0.2.1` | `routerIPv4`；外设出站及终端回程下一跳 |
| 路由器交付接口 MAC | `02:00:00:00:00:01` | `routerMAC`；须读取实际交付接口，不能猜成 WAN MAC |
| 外设 IPv4／前缀长度 | `192.0.2.2`／`24` | `gatewayIPv4`、`prefixLength`；路由器交付下一跳 |
| 外设真实网口名 | `lan-test` | `ingressInterface`；以目标机实际接口为准 |
| 终端地址 | `192.0.2.10`、`192.0.2.11` | 验收角色；LAN 模式无需逐台写入部署 JSON |
| 外设 DNS 端口 | `15353` | `automaticGateway.dnsPort` 与 `management.deployment.dnsPort` 及路由器 DNS 目标一致 |
| 管理地址 | `https://gateway.example:13443` | `management.origin`、证书、nginx 的 Host 和跳转目标 |
| 管理后端端口 | `13000` | `management.listenPort`、nginx `proxy_pass`；只在回环监听 |
| 独立引导 DNS | `198.51.100.53` | `bootstrapResolvers`；替换为实际可达且不会形成解析循环的纯 IP 解析器 |
| 服务账号／UID | `cocoproxy`／`12345` | 目标机非登录专用账号，`serviceUser` 与 `serviceUid` |
| 出口资源 | mark `65536`、表 `2024`、优先级 `8000` | `egressMark`、`egressTable`、`egressPriority`；先检查是否冲突 |
| 订阅与探测许可 | 自己使用的 HTTPS origin | `subscriptionPolicy.allowedOrigins`、`controllerPolicy.allowedProbeOrigins` |

LAN 模式的 `clientCIDR` 必须恰好等于外设网口所在的规范子网；路由器使用相同范围。各角色地址互异，为有效主机地址，不能覆盖保留 TUN 网段。若只使用兼容单终端模式，则用 `clientIPv4` 替代 `clientCIDR`，不能同时填写两者。

出口表和优先级是外设自己的资源，不要求路由器使用相同编号。LAN 模式还使用 `egressTable + 20000` 作为回程表；应与现有 VPN、策略路由、防火墙规则一起检查，具体约束见[网关模块](../packages/gateway/README.md)。

## 3. 准备 Linux 系统

### 3.1 系统和软件条件

在外设安装与自身硬件适配的 Linux，准备本地控制台或 SSH 维护入口，再按该发行版的方法准备下列软件。安装包已包含管理 UI、Server、运行依赖和固定 Mihomo，目标机无须重新构建网页或执行 `npm install`。

| 类别 | 当前要求 |
| --- | --- |
| 操作系统 | Linux/systemd，ARM64 或 x86-64；不支持 Windows/macOS、无 systemd 系统或普通端口映射容器 |
| 管理运行环境 | Node.js ≥22.18，支持 JavaScript `.rules` 的 polkit，`getent` 和常用系统工具 |
| 自动网关 | Python ≥3.9、iproute2、nftables，工具路径包含 `/usr/sbin/ip`、`/usr/sbin/nft` |
| HTTPS 入口 | nginx、匹配的证书与私钥；生成本地证书时需要 OpenSSL |
| 内核与接口 | 可用的 `/dev/net/tun`，TUN/nftables/策略路由能力，网口 UP 且已有指定 IPv4／前缀，IPv4 转发已准备 |

依赖版本和包名因系统而异；不要只按包名判断 Node.js 版本，也不要为绕过预检临时创建同名假工具。只读检查示例：

```sh
uname -m
node --version
python3 --version
systemctl --version
command -v node python3 nginx openssl getent
/usr/sbin/ip -brief address
/usr/sbin/ip rule show
/usr/sbin/ip route show table all
/usr/sbin/nft list ruleset
test -c /dev/net/tun && echo 'TUN device present'
sysctl net.ipv4.ip_forward
```

这些检查只用于盘点，不能单独证明内核转发、TUN 和终端路径已经可用。预先核对 rp_filter、ICMP 重定向、现有防火墙、网卡 offload、SELinux/AppArmor 和服务 sandbox；不要清空防火墙来消除冲突。

自动网关要求 `net.ipv4.ip_forward=1`。如果当前为 `0`，应由系统管理员安排该变更并按系统方式持久化，然后重新核对相关 IPv4 参数；安装器不会设置它。外设保持原有默认出口和独立基础 DNS，不把主机自身解析改为依赖尚未启动的 CoCoProxy。

### 3.2 专用账户与安装目录

为服务准备唯一、非 root、使用 `nologin` 或 `false` shell 的专用账号及固定 UID，不能复用 SSH 登录账号。使用 HTTPS 样本时还要准备其服务组。先检查：

```sh
getent passwd cocoproxy
getent passwd 12345
getent group cocoproxy
```

账号不存在时，由目标机管理员按选定的空闲 UID 创建；已存在时核对身份、shell、组和已有 sudo/polkit 授权。部署 JSON 使用实际 UID。安装器不会创建账号或赋予任意系统管理权限。

下面为首次安装新建专用目录的示例。如果目录已有内容或用于其他服务，先核对归属，不能用递归 chmod/chown 覆盖它们。

```sh
install -d -o root -g root -m 0755 /srv/cocoproxy-staging /opt/cocoproxy/releases
install -d -o root -g root -m 0700 /etc/cocoproxy-install
```

载荷、安装父目录和祖先必须由 root 控制、不可由组或其他用户写入，不经符号链接或硬链接；运行所需的 release 祖先还须允许服务账号遍历。私有安装输入为 root 所有、0600 的普通单链接文件。

## 4. 获取安装包并安装软件

### 4.1 获取与核验

从项目可信 Release 获取与目标架构对应的安装包、同名 `.manifest.json` 和 `SHA256SUMS`，并阅读该版本发行说明。`uname -m` 的 `aarch64` 对应 `linux-arm64`，`x86_64` 对应 `linux-amd64-v1`。例如本版文件名为 `cocoproxy-0.1.0-preview.1-linux-arm64.tar.gz`，x86-64 用相应平台名。

在可信下载目录核对所选附件的 SHA-256 与发布值一致；将安装包解压到目标的 root 控制专用暂存目录。解压后结构应包含 `manifest.json`、`source/`、`server/`、`bin/mihomo`。核对包内 manifest 与已核验的包外 manifest 一致，记录可信的 manifest SHA-256。只对未知来源文件自算摘要不能建立信任。

若没有可用 Release，由构建者按[开发说明](development.md)和[发行装配说明](release-staging.md)提供载荷及单独核验的 manifest 摘要；普通部署者不必重新构建。传输只选择载荷目录，显式排除 `.local/`，不要整体复制工作区、父目录或跟随本地链接。

### 4.2 填写私有部署输入

推荐先按[统一部署入口](setup.md)运行 `configure`，从环境事实自动生成本节所需输入；可选 HTTPS 与升级沿用值也由该入口处理。下面保留底层手工填写方式，便于自定义布局和核对生成结果。

以下变量使用合成路径，请把 `PAYLOAD` 改为实际解压目录。`NODE` 必须为 root 控制的真实系统 Node 路径，不使用用户目录中的版本管理器路径。摘要必须替换为上一步核验的 64 位值。

```sh
PAYLOAD=/srv/cocoproxy-staging/cocoproxy-0.1.0-preview.1-linux-arm64
MANIFEST_SHA='<已核验的64位manifest摘要>'
NODE=/usr/bin/node
INPUT=/etc/cocoproxy-install/deployment.json
RELEASE="/opt/cocoproxy/releases/$MANIFEST_SHA"
DEPLOY="$PAYLOAD/source/apps/deployment/main.ts"
sha256sum "$PAYLOAD/manifest.json"
```

首次安装，把载荷中的 `source/examples/automatic-gateway-deployment.json` 复制为私有输入：

```sh
install -o root -g root -m 0600 \
  "$PAYLOAD/source/examples/automatic-gateway-deployment.json" "$INPUT"
```

编辑这个私有文件，按第 2 节替换所有合成角色值、UID、DNS、origin、许可和 controller secret。特别核对：

| 字段 | 应填写的值 |
| --- | --- |
| `runtime.sourceDirectory` | 实际 `$RELEASE/source` |
| `runtime.binaryPath` | 实际 `$RELEASE/bin/mihomo` |
| `management.serverEntry` | 实际 `$RELEASE/server/.output/server/index.mjs` |
| `runtime.binarySha256` | 当前 manifest 的 `components.mihomo.binarySha256` |
| `runtime.nodePath` | 实际 `$NODE` 路径 |
| `management.origin` | 最终浏览器 HTTPS 地址，含非默认端口 |
| `management.deployment.controllerSecret` | 自己生成并私下保存的高强度随机秘密 |
| `management.subscriptionPolicy.allowedOrigins` | 实际订阅下载许可；地址中的令牌放在后台私有来源中 |
| `management.controllerPolicy.allowedProbeOrigins` | 实际延迟／站点检测所需的探测 origin |

JSON 中填展开后的绝对路径字符串，不填字面量 `$RELEASE`；release 目录最后一级必须是 manifest 完整摘要，并且首次安装时尚不存在。样本内的核心摘要也要从所选架构载荷重新核对。controller secret 是内部 API 的秘密，管理员网页登录使用另外设置的账号口令。

### 4.3 预检、审阅与写入

先运行默认只读预检：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"
```

成功后，生成私有部署计划以审阅文件、权限、服务和网络参数。输出不能覆盖已有文件；计划可能含秘密，保持在私有目录：

```sh
"$NODE" --experimental-strip-types "$PAYLOAD/source/apps/cli/main.ts" \
  deployment-plan --input "$INPUT" --output /etc/cocoproxy-install/plan.json
```

如预检拒绝，按[安装错误对照](deployment.md#2-只读预检与计划审阅)解决具体条件。所有相关服务须停止、未 enable，已有网络资源须先按维护流程退役；旧安装应使用升级流程。不要删除 receipt 或伪造摘要把旧安装当作首次安装。

确认计划后执行安装：

```sh
"$NODE" --experimental-strip-types "$DEPLOY" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
```

成功后安装器写入 release、八个自动网关计划文件和归属收据，执行 `daemon-reload`；**此时服务仍未启动、未设置开机启用，路由器也未改变。** 若发生断电或部分安装，停止普通重试，按[安装收据处理说明](deployment.md#3-显式安装与服务准备)核对状态。

## 5. 建立 HTTPS 管理入口

### 5.1 初始化管理员

首次安装且尚无管理员 credential 时，在 `/etc/cocoproxy-install/admin-login.json` 中私下准备以下内容，替换占位符；文件应为 root 所有、0600：

```json
{"username":"<管理员用户名>","password":"<私有强口令>"}
```

用户名使用符合约束的 ASCII 字符，密码为 10–1024 个 UTF-8 字节；完整约束见[管理模块](../packages/management/README.md)。不要把口令写入命令参数或公共示例。随后执行；先将 `SERVICE_USER` 填为部署输入的 `management.serviceUser`，`CREDENTIAL` 填为 `management.credentialPath`：

```sh
ADMIN_INPUT=/etc/cocoproxy-install/admin-login.json
SERVICE_USER='<实际专用服务账号>'
CREDENTIAL=/etc/cocoproxy/admin.json
"$NODE" --experimental-strip-types "$RELEASE/source/apps/cli/main.ts" \
  admin-init --input "$ADMIN_INPUT" --output "$CREDENTIAL"
chown "${SERVICE_USER}:root" "$CREDENTIAL"
chmod 0600 "$CREDENTIAL"
```

账号和输出路径须与部署输入一致；已有 credential 直接保留。明文初始化输入按私有资料管理，不随发行或源码同步。

### 5.2 配置网页入口并启动

按[HTTPS 完整配方](management-https.md#证书与安装)，使用载荷中的 `source/examples/nginx-management.conf` 和 `source/examples/cocoproxy-web.service` 配置独立 nginx 服务。该配方包含证书生成、目录权限、配置校验、安装与启动命令。配置前核对以下对应关系：

| 访问方式 | 必须准备的内容 |
| --- | --- |
| 域名，如 `https://gateway.example:13443` | 域名在 LAN 可独立解析到外设；证书有对应 DNS SAN |
| IP，如 `https://192.0.2.2:13443` | 证书有对应 IP SAN；nginx authority、Host 检查和 origin 统一改为该 IP 和端口 |
| 两种方式共同要求 | nginx listen 使用外设实际 LAN 地址；反代端口与后端一致；固定 Host、协议头、WebSocket 和 HTTP 跳转目标均已替换 |

主安装器不安装这个独立 HTTPS 服务，也不配置证书或防火墙开放。把目标设备的管理端口限制在计划中的管理网络；浏览器访问公网不需要把后台映射到 WAN。自签名证书首次访问应通过可信渠道核对 SHA-256 指纹。

完成配方中的校验后启动：

```sh
systemctl daemon-reload
systemctl start cocoproxy-management.service
systemctl start cocoproxy-web.service
systemctl status cocoproxy-management.service cocoproxy-web.service --no-pager
```

浏览器输入完整的 `https://<实际域名或IP>:<实际端口>`。`13443` 是样本的外部端口，`13000` 是样本的回环后端端口，均可按输入调整；它们不是统一固定的产品默认访问地址。不要把内部 controller 或 mixed 端口作为网页登录入口。

## 6. 首次登录与基本使用

桌面侧栏提供“概览、代理、规则、订阅、连接、流量、日志、设置”。概览用于查看速率、流量和连接等运行信息，设置页可查看核心状态、处理需恢复的事务以及退出登录。手机底栏提供“概览、代理、规则、订阅”，其他页面在“更多”中。

### 6.1 导入第一份订阅

1. 管理终端连入可达 LAN，打开第 5 节确定的 HTTPS 地址，用刚初始化的管理员账号登录。
2. 进入“订阅”，选择“导入订阅”，填写名称和自己的来源地址。
3. 新增后会尝试更新。分别检查“地址保存成功”和“更新成功”，确认有可用节点、更新时间且没有错误。
4. 第一份可用来源会自动成为本地模板的当前来源并尝试生效。需要更换时点击订阅卡片，在订阅页顶部选择“配置方案”；“代理”和“规则”页顶部也有同一工具栏。订阅存在可用来源时会保留一个当前来源。

支持 JSON／Clash YAML 节点或受支持的完整配置，不支持 URI/base64 自动转换。来源下载受部署许可限制；遇到拒绝时由部署者核对 `subscriptionPolicy`，不能仅在网页反复重试。订阅地址可能带访问令牌，不要公开截图或日志。

### 6.2 选择方案、模式与节点

| 后台操作 | 适用场景与结果 |
| --- | --- |
| “配置方案”→“本地规则模板” | 用订阅节点配合内置业务分类、国内补漏和自己的规则 |
| “配置方案”→“订阅配置” | 选择标为“配置”的来源，使用其策略组和规则，并保存自己的选择与覆盖 |
| “运行模式”→“规则” | 按当前方案的规则分流，首次使用通常从这里开始 |
| “运行模式”→“全局” | 业务统一交给代理出口 |
| “运行模式”→“直连” | 业务交给 DIRECT；已交付流量仍由 CoCoProxy 处理 |
| “代理”→选择手动策略组→点击节点 | 切换该组出口，查看“当前生效”；自动组由核心算法决定 |
| “规则”→“自定义规则”→“保存” | 按列表顺序匹配，保存后自动生效，作用于当前方案 |

方案、来源、运行模式和策略组修改会自动保存并生效，不需再找一个“应用”按钮；自定义规则点“保存”即可。首次应用会通过事务校验并启动核心及依赖网络服务。确认页面显示“已生效／已切换”，再继续路由器步骤。仅显示已保存、设置未生效或错误时，不视为完成。

节点数、服务 active 和核心确认成功只说明局部状态；此时终端还没有完成路由器接入和联网验收。“现有配置”是旧草稿兼容状态，不是新部署需要选择的第三种方案。

### 6.3 延迟、规则与日常管理

“代理”里的 TCP 延迟测试只测外设到节点端口的 TCP 建连；代理延迟通过节点访问测试网址，站点检测检查实际站点。TCP 成功不能证明认证或网站可用。UDP／QUIC 专用等节点可能显示 TCP 测试“不适用”。探测网址同样受部署许可约束。

工具栏“刷新”重读页面状态；订阅卡片的更新操作才下载来源。当前来源更新成功后会自动校验并生效，未选来源只更新快照。修改来源地址后必须重新成功更新；删除当前来源前需有另一份可用订阅。

核心离线时仍可登录和编辑，但运行信息可能不可用。查看设置页错误；若显示“配置切换需要恢复”，可使用该页“恢复”处理未完成事务。恢复失败时保持路由器交付关闭，由部署者按[运行模块维护说明](../packages/runtime/README.md)处理，不绕过事务直接启动 Mihomo。多页面编辑冲突时刷新并核对最新状态后重做。管理服务重启会使临时登录失效，受信任设备可自动登录；主动退出会同时撤销当前设备的自动登录授权。更多操作见[使用说明](usage.md)。

## 7. 配置协同路由器并开启交付

先确认该路由器或已选组件实现了全部[协作要求](cooperating-router-requirements.md#路由器必须提供的行为)。CoCoProxy 以网络行为对接不同路由器；本项目没有可直接套用到所有厂商的菜单路径、刷机步骤或通用配置命令。缺少下面关键能力时，应先补齐适配或更换满足条件的协作实现，不能靠普通静态路由继续部署。

保持交付关闭，按路由器自己的管理入口逐项配置：

| 路由器配置项 | 填什么／达到什么行为 |
| --- | --- |
| 外设目标 | 实际 `gatewayIPv4`，保持稳定；交付由与 `routerMAC` 相符的接口发出 |
| 受管来源 | 与 `clientCIDR` 相同的完整精确 LAN；单终端模式使用同一 `clientIPv4` |
| 流量范围 | 受管公网 IPv4 TCP/UDP；保留 LAN、路由器和外设管理、基础控制流量 |
| 排除与防循环 | 排除路由器自身、外设出站及终端回程，不能把路由器全局默认路由改成外设 |
| 来源保持 | 交付段保留原始终端 IPv4，不做 SNAT/masquerade；WAN NAT 可保留 |
| DNS 转交 | 受管公网 DNS 的 UDP 和 TCP 都送到外设实际 `dnsPort`；本地域、无点名称保留基础解析，bootstrap 不循环 |
| 回程 | 允许外设经路由器回终端及必要同接口转发；核对连接跟踪、防火墙、rp_filter、重定向和 MTU |
| IPv6 与其他协议 | 阻断受管公网 IPv6，保留必要本地控制；对其他 IP 协议与加密 DNS 单独声明并验收 |
| 故障处理 | 外设、核心、DNS 或链路失效时保持开启意图并阻断受管外网；查表失败不能落回普通 WAN |
| 独立关闭 | 外设离线时仍能撤销交付、专用 DNS 和相关 IPv6 限制，恢复普通直连 |
| 生命周期与加速 | offload、旧连接、重连和规则重载不能绕过策略；核对保存、应用、撤销与失败状态 |

先找到并记录路由器的独立关闭入口；确认关闭时终端仍能普通直连，再协调开启 DNS 与流量交付。应用若只完成半套配置，应保持阻断或撤销交付并恢复 DNS，再排查；不要留下 DNS 已切换但路径未就绪的状态。

外设 DNS 只接受配置的路由器地址／MAC及本机请求，不应让所有终端改成直接查询外设。配置了整个 LAN 也不等于所有实体设备已经验收。路由器 DNS 预检成功只证明 DNS 可达，仍需下一节的实际测试。

## 8. 启用持久运行与自动恢复

首次配置、核心及终端基本路径确认后，再启用本节。两端分别保存运行意图：系统关机不能等同用户关闭；用户明确关闭路由器交付后，重试和重启都必须保持关闭。外设核心继续在线不表示路由器会重新开启交付。

### 8.1 持久化系统前置条件

确认网口连接能够自动启动，并通过 DHCP 保留或核验过的静态配置保持第 2 节的外设地址。检查指定有线接口，而不是只看整机是否联网；Wi-Fi 在线不能代替交付接口就绪。保留主机原有默认出口与基础 DNS。

`net.ipv4.ip_forward=1` 必须在重启后仍成立。先检查系统现有配置和管理方式；没有冲突时，由管理员使用专用文件持久保存，例如 `/etc/sysctl.d/05-cocoproxy-forwarding.conf` 中的 `net.ipv4.ip_forward = 1`。不要覆盖未知文件，也不要清空其他网络设置。按发行版顺序应用并复核 rp_filter、重定向及其他 IPv4 参数；转发开关变化可能重置部分内核参数。网络 helper 只检查，不替管理员设置该全局参数。

### 8.2 启用已提交配置的恢复

下面仍在 root shell 执行。`SERVICE_USER` 沿用部署账号；状态与设置路径必须与私有部署输入一致。CLI 通过 `runuser` 以服务身份读写其私有状态，不能用 root 创建服务身份的状态文件。

```sh
STATE_DIR=/var/lib/cocoproxy
RUNTIME_SETTINGS=/etc/cocoproxy/runtime.json
CLI="$RELEASE/source/apps/cli/main.ts"
runuser -u "$SERVICE_USER" -- "$NODE" --experimental-strip-types "$CLI" \
  runtime-enable --state-dir "$STATE_DIR" --runtime-settings "$RUNTIME_SETTINGS"
systemctl enable cocoproxy-gateway-guard.service cocoproxy-management.service cocoproxy-web.service
runuser -u "$SERVICE_USER" -- "$NODE" --experimental-strip-types "$CLI" \
  runtime-lifecycle-status --state-dir "$STATE_DIR" --runtime-settings "$RUNTIME_SETTINGS"
```

`runtime-enable` 要求已有成功提交且无待恢复事务的配置，只保存恢复意图，不改路由器或 systemd 启用状态。自动网关的早期 guard unit 在本地文件系统就绪后、`network-pre.target` 前建立保护，不等待网口地址；网络服务随后等待实际接口再准备路由。必须核对目标网络管理器遵守该启动顺序。管理服务在恢复意图开启时串行核对并恢复已提交配置；systemd 仍是唯一核心进程监管者。核心不需要单独开机 enable，由协调流程在网络就绪后启动。缺少标记时默认不启用自动恢复。显式代理模式没有早期 guard unit，上面的 enable 命令应只包含管理和网页。

协同路由器也须安装支持持久意图、早期保护和自动恢复的适配版本，并启用其开机服务。AlwayRoute 的具体安装、fw4 自动 include 前提和恢复状态见该项目的外接部署文档；其他路由器按[协作要求](cooperating-router-requirements.md)提供等价行为，不能仅用开机执行一次脚本代替。

### 8.3 日常恢复与异常边界

两端以任意顺序启动，或同 LAN 网线重新接通后，应等待依赖并恢复上次成功配置；不会应用仅保存的新草稿。路由器在开启意图下等待期间保持保护，依赖就绪后自动恢复交付。验收目标为必要依赖就绪后 60 秒内恢复新连接，实际结果按第 9 节记录；旧连接可能需要应用重连。

暂时性断线、网关未启动和锁忙需要继续重试；配置损坏、未知资源或身份不符应明确报告，不能通过删收据、放宽范围或直连绕过错误。维护期间使用下一节的 pause 步骤，不能与自动恢复竞争。

## 9. 部署验收与交给使用者

按下表逐项确认，先记录版本、日期和验证结果。真实地址、原始输出和恢复说明留在自己的私有记录；本仓库内使用被忽略的 `.local/`，不纳入源码、安装包或发布附件。

| 测试 | 期望结果 |
| --- | --- |
| 管理入口 | 电脑和手机均能经 HTTPS 登录、操作并退出；未登录不能读受保护 API |
| 至少两个客户端 | 代理目标和 DIRECT 目标均可访问；分别核对实际出口，不能只看页面“已生效” |
| 新加入或 DHCP 地址变化的终端 | 在同一受管 LAN 范围内自动覆盖，并完成 TCP/UDP 测试 |
| DNS | 路由器按 UDP/TCP 转交公网解析；本地域正常，bootstrap 不循环 |
| 来源和回程 | 外设看到真实终端来源，响应经路由器回终端；外设本机保留原有出口 |
| 本地访问 | 路由器、外设后台及其他必要 LAN 管理可达 |
| IPv6 | 受管公网 IPv6 被阻断，不绕过 IPv4 交付 |
| 核心／DNS／链路分别故障 | 开启意图下受管外网被阻断，没有自动改成普通 WAN；在维护窗口控制故障并恢复 |
| 外设离线后独立关闭 | 从路由器关闭交付后，终端恢复普通直连和基础 DNS |
| 正常重启与断电 | 分别软重启两端、正常关机后上电、两端同时断电；开启／关闭意图保持正确 |
| 启动顺序 | 路由器先开、外设先开，晚启动的一端就绪后无需人工应用即可恢复 |
| 拔线和同 LAN 换口 | 分别短时及长时断线、在同 LAN 端口间换线；无需重填配置，记录恢复新连接耗时 |
| 网络与防火墙重载 | 正常 reload 后恢复资源，恢复期间保持保护；不以全表 flush 代替测试 |
| 关闭与维护优先 | 等待恢复时关闭交付不得复活；pause 后重启不得启动核心，恢复运行须显式 resume／enable |
| 持续使用 | 两台终端并发及持续负载另测，不能用几次重连代替长期验收 |

涉及停服务、断链或重载的测试会影响受管终端，应安排维护窗口。一次浏览器访问成功不能代替 UDP、故障或多终端验收。不要用清空防火墙全表的方式做普通测试。

交给日常使用者时，通过私有渠道提供：

- 实际后台 HTTPS 地址、证书指纹及管理员凭据的既有保管方式。
- 路由器交付的开启／独立关闭入口，说明直连模式与关闭交付的区别。
- 当前覆盖的 LAN 范围、已验证的设备与限制，以及故障时的维护联系人或操作入口。
- [后台使用说明](usage.md)；日常使用者无需掌握全部安装命令。

交付时同时提供持久运行是否启用、依赖就绪后的恢复耗时，以及尚未完成的测试。自动恢复不等于全生命周期无故障；不能把 `active`、一次 DNS 可达或 enable 成功当成整机启动可靠性证明。

## 10. 日常关闭、升级与排障

完全恢复普通直连时，**从协同路由器关闭交付并恢复其 DNS**。网页“直连模式”仍经过外设；仅停止核心会保留独立 guard，并继续阻断受管外网。

升级和卸载前先暂停外设自动恢复，成功后再关闭路由器交付，按[维护完整流程](deployment.md#关闭升级与卸载)停止并禁用服务、用旧版本 helper 和旧设置安全退役自有网络，然后预检并执行升级或卸载：

```sh
runuser -u "$SERVICE_USER" -- "$NODE" --experimental-strip-types "$CLI" \
  runtime-pause --state-dir "$STATE_DIR" --runtime-settings "$RUNTIME_SETTINGS"
```

pause 会与配置应用及恢复共用锁，成功返回才表示此前协调已结束；超时或失败时不要继续停服务或安装。维护标记跨重启保留，核心启动器也拒绝在暂停时启动。安装器发现已启用但未暂停的恢复标记会拒绝操作。`runtime-disable` 关闭自动恢复并保留暂停状态，不会立即停止现有核心，也不代替路由器独立关闭。

升级完成后将 `RELEASE`、`CLI` 更新为新版本，检查当前部署与保留配置匹配，再启动管理及网页，使用相同身份运行 `runtime-resume`（此前必须已 enable），或在首次启用时运行 `runtime-enable`；然后恢复路由器交付并验证。账号、订阅、选择和状态应保留，不要重建管理员或重新导入订阅。卸载默认保留私有设置及数据，独立 HTTPS 服务和路由器配置另行处理。

| 现象 | 优先检查 |
| --- | --- |
| 后台完全打不开 | LAN/VLAN/隔离、外设地址、域名解析、外部管理端口、防火墙与两个管理服务状态 |
| 证书警告或 Host/origin 拒绝 | URL、端口、SAN、nginx 固定头与 `management.origin` 是否完全对应 |
| 能登录但订阅更新失败 | 来源格式、下载许可、外设出网、独立 DNS 与源站可用性；不要公开来源 URL |
| 已保存但未生效／核心离线 | 设置页错误、候选校验、服务与网络依赖；按事务维护流程处理 |
| 后台正常但终端无法上网 | 路由器是否已交付，来源范围和 MAC、交付段 NAT、UDP/TCP DNS、IPv6、回程及防循环 |
| 停核心后终端也断网 | 开启状态下属于预期阻断；需要普通直连时从路由器独立关闭 |
| 原先能用，改地址／许可后升级被拒 | 安装器核验旧文件及配置摘要；按维护文档审阅配置迁移，不能直接覆盖 |

Linux 上可在私有维护终端查看服务状态；需要日志时不要公开原始输出：

```sh
systemctl status cocoproxy-management.service cocoproxy-web.service \
  cocoproxy-mihomo.service cocoproxy-gateway-network.service --no-pager
journalctl -u cocoproxy-management.service -u cocoproxy-mihomo.service \
  -u cocoproxy-gateway-network.service -n 100 --no-pager
```

若需要调整 DNS、TUN 或性能参数，先阅读[可信部署选项](../examples/deployment-options.md)，按维护流程审阅迁移并重新验收。普通订阅和后台规则不能覆盖这些部署边界。

可选 `automaticGateway.tunStack`、`tunGso` 在配置层与 root 网络 helper 使用相同字段约束。默认值沿用部署样本；修改这些性能参数仍需按维护流程审阅迁移，并对实际核心与网络重新验收，不能直接修改受管文件绕过收据检查。
