# 配置与资源契约

本文仅适用于[保留框架](README.md)。当前原生网关使用另一套[profile 与 host plan](../gateway/README.md)，不能混用表号、规则、unit 或凭据。

## 网络计划输入

`renderNetworkPlan(input): NetworkPlan` 是确定的纯函数，失败固定 `NETWORK_PLAN_INVALID`。schemaVersion为1，除可选management外字段必填；合成结构如下：

```ts
const input = {
  schemaVersion: 1,
  generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
  management: { serviceUid: 12346 },
  ingressInterface: 'lan-test',
  gatewayIPv4: '192.0.2.2', prefixLength: 24,
  routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01',
  clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 },
  marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 },
  priorities: { capture: 10003, egress: 10002, return: 10001 },
};
```

| 字段 | 约束 |
| --- | --- |
| generation、binarySha256、unitSha256 | 64位小写十六进制；代次与路由器revision不同 |
| 服务UID | 非root整数1..4294967294；生产强制显式且不同的管理UID |
| ingressInterface | 1–15位，字母开头，其余字母／数字／下划线／连字符；拒绝lo、all、default及TUN同名 |
| IPv4与前缀 | 标准无前导零IPv4，同一 /8–/29 子网三个不同主机地址，非网络／广播；拒绝0/8、127/8、169.254/16、组播及高位保留地址 |
| routerMAC | 小写冒号形式非零单播MAC |
| dnsPort／TUN | 1024–65535；固定coproxy-tun，MTU1280–9000 |
| marks | 非零无符号32位；三个值互异且完全在mask内，保留位外不变 |
| tables／priorities | 各三个互异10000–19999整数；return < egress < capture，早于main |

输入只接受普通／空原型JSON数据，无数组字段；拒绝未知字段、Proxy、getter、Symbol、非枚举属性、循环、原型污染及非JSON值。预算128值、8层、每对象32属性、键与字符串合计16 KiB。

输出SHA-256覆盖除sha256自身外按固定顺序JSON.stringify的全部字段，不含时间；修改输出会使摘要失效。摘要标识内容，不证明部署授权，也不承诺未来schema摘要兼容。

## 路由域与保护范围

归属固定 `coproxy-network-v1`，inet表 `coproxy_guard` 和 `coproxy_data`，固定链／TUN，路由protocol186。三张专用表始终保留metric32760黑洞默认：

| 路由域 | 允许路径 |
| --- | --- |
| capture | 激活时增加低metric TUN默认，无物理出口默认 |
| egress | 明确路由器下一跳；上游socket首包前已有egress mark及本代核心来源 |
| return | TUN入口、终端/32和return mark，终端路由必须via路由器，不直接ARP终端 |

入口只选择明确接口、路由器MAC、原终端IPv4的TCP/UDP，排除路由器／网关本身。清除并重分类保留mark位，公式 `(old & ~mask) | value`；不从CT全局恢复包mark，不增加SNAT。其他接口流量和非保留位不改。

核心与管理cgroup固定 `/system.slice/coproxy-mihomo.service`、`/system.slice/coproxy-management.service`，nft使用socket cgroupv2 level2；实际身份、唯一成员、不可委派和逐socket来源须独立核验。共享UID兼容只用于旧计划解析／fixture／阻断恢复，不许可生产apply。

DNS仅允许精确入口、路由器MAC、终端或路由器/32访问精确网关IPv4与端口；bootstrap独立，真实地址解析。三个阶段均允许源127.0.0.1、lo到该DNS的本地探针。到达网关的路由器来源IPv6转发阻断，终端其他IPv6出口由路由器阻断。

## 候选编译与校验

`compileGatewayPreview({schemaVersion:1,base,network})` 的base沿用配置编译器，network为不含generation的计划输入。dnsPort必须一致；bootstrap是独立IPv4，不能为网关或终端。编译固定审核ARM64 Mihomo v1.19.33，其他版本／架构不自动兼容。

核心TUN固定mips、coproxy-tun、部署MTU，关闭auto-route、auto-redirect、auto-detect-interface、GSO、DNS hijack和ICMP原样转发；loopback混合代理／controller保留。DNS精确监听，出站绑定入口和egress mark。固定fake-ip-range为198.18.0.1/30以派生TUN地址，不能与入口子网重叠。依据：[固定核心TUN解析](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/config/config.go)。

完整网络部署写入保留 `x-coproxy-network` 并参与候选摘要，随后以该摘要生成plan，避免循环。输出candidate、networkPlan、expectedTun及sensitive，activation为unsupported-by-current-runtime。当前runtime拒绝此旧profile；与automaticGateway无关。

`validateGatewayCandidate(candidate,expected)` 先校验canonical字节和hash，再从metadata重编译完整配置与plan，比对可信expected。expected由部署所有者提供，不能取自候选／HTTP自报。返回candidate、networkPlan、controller。`loadGatewayCandidate(settings,generation,expected)` 再匹配UID、binary/unit摘要，私有读取并复核，另返回path。错误固定 `GATEWAY_CANDIDATE_UNTRUSTED`；返回含secret，只供内部使用。

## 固定规则阶段

`renderNetworkRules(input,{mode})` 每次重渲染plan，返回两个nft表create/replace批次与固定ip argv。首次create仅在不存在时使用；replace保留表／链归属，清空三个固定链。实际提交方法见[执行文档](execution.md#提交与回读)。

| mode | 放行范围 |
| --- | --- |
| blocked | 无终端／TUN／LAN DNS和核心、管理UID非loopback输出例外 |
| core-only | 已核验核心的精确出口、独立管理cgroup正常输出；终端、LAN DNS与捕获分类仍阻断 |
| active | 额外放行精确终端capture到TUN及return回程、LAN DNS |

核心非loopback输出需原始socket cgroup、UID、已存在egress mark、网关IPv4源、TCP/UDP和物理出口全匹配，规则不补SO_MARK。管理例外要求管理cgroup/UID、保留位为零、TCP/UDP、非DNS源端口；沿正常本机路由，不额外限制地址族／目的／出口。两个UID后续均有非loopback drop，lo在保护范围外。

DNS入口还检查核心监听cgroup。Linux6.1 request_sock使TCP SYNACK不能使用普通nft socket cgroup证明，因此仅active对精确LAN DNS初始SYN验证监听后写CT egress保留位；每次新SYN重验。替代输出仅允许核心UID、已有SO_MARK、CT egress、reply、精确源／目的／DNS端口／出口及严格SYNACK。其他输出仍要求socket cgroup，blocked/core-only不建立此CT例外。来源：[nft_socket.c](https://github.com/torvalds/linux/blob/v6.1/net/netfilter/nft_socket.c)。

fixtureCgroups仅供隔离测试，两个路径不能相同或互为祖先；management:null可去掉管理例外但保留UID drop，输出强制fixture。生产配置不接受此参数。

ip输出分blackholes、rules、prepareRoutes、activateCapture、withdrawCapture，直接传固定ip，不经shell。ip多操作不原子：先guard回读，再黑洞和出口／回程，证据通过后加capture并原子切active；失败保持黑洞和阻断。

## 旧框架核心unit

`renderGatewayRuntimePlan(input)` 必填schemaVersion、stateDirectory、binaryPath、binarySha256、systemctlPath、unitPath、serviceUid、coreHome。root state和非root coreHome互不嵌套，系统文件不在其中，拒绝home隐藏路径；systemctl仅固定系统路径，摘要固定审核核心。

输出unit、settings、coreHome、selectedPath、credentialPath和filesystem。root state/candidates为0700、selected为0600；coreHome为服务UID0700。核心通过LoadCredential读取root selected快照，直接执行 `-d coreHome -f %d/core-config`，不使用当前Node launcher。配置canonical UTF-8限制1,000,000字节，不能沿用4 MiB上限；systemd255的累计credential限制见[官方文档](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#Credentials)。

unit Requires/After/BindsTo依赖coproxy-network.service和管理服务，Restart=no、无Install段；停止事务按逆序先停核心。仅NET_ADMIN/NET_RAW，NoNewPrivileges、私有临时目录、只读系统、保护cgroup及内核；ReadWritePaths仅coreHome，启停各10秒、KillMode=control-group、UMask0077，journal限速30秒200条。

unit不含generation以避免循环摘要；真实credential、进程和服务失效绑定仍须独立观察。它与当前原生网关unit的启动器、自动重启和网络单元名不同，不能替换安装。
