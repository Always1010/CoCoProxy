# IPv4 单终端 TUN 网络计划

`renderNetworkPlan(input: unknown): NetworkPlan` 生成确定的、可审阅的结构化资源与阶段计划。它只处理内存数据，不读取主机状态，不执行命令，不生成 nftables 规则文本或 CLI，不安装软件，不改动本机网络，也不授予浏览器调用特权网络操作的能力。所有失败均抛出固定的 `NetworkPlanError`，其 `code` 与 `message` 都是 `NETWORK_PLAN_INVALID`，不附带输入值、路径或底层异常。

已有[受保护的网关候选预览](config.md)把完整网络部署绑定到核心内容代次，[固定规则渲染器](rules.md)生成受限 nft 批次和 ip 参数，真实四角色隔离路径已验证。[cgroup 只读身份观察](identity.md)补充固定核心与管理服务的独立来源核验，[DNS/TUN 实际探针](probe.md)检查核心 FD、精确监听和两种传输的真实 DNS 查询，[持久事务协调器](transaction.md)实现启用意图、操作 fence、证据门槛与启动恢复阻断。协调器仍需真实 native driver，尚未接入 systemd 运行适配或管理入口，也没有已安装的特权 executor。现有显式代理候选不能直接满足本计划的 TUN、专用 DNS 与出口 mark 要求。本模块不构成网关实现完成或设备验收通过。

[内核资源回读校验](readback.md)严格比较固定 nft 表／链／规则的 AST 与 handle，并检查 RPDB 和专用路由的合法存在状态。它只验证输入结构与受信基准一致，不把同名或同配置当作所有权证明；外部 nft／RPDB／自定义表冲突保持拒绝。

[原生资源会话](native.md)已把固定批次、真实提交 echo、逐步 ip 操作和独立内核回读连起来，并接入四角色隔离测试。持久模式通过私有资源凭据、命令启动屏障、跨进程锁与 revision CAS，在核验归属后恢复 blocked；完整主机预检、迁移和生产 driver 仍待完成。

[私有网关候选](candidate.md)在不可变内容摘要之外重编译完整配置及网络计划，并独立核对可信部署；显式代理 loader 保持拒绝网关 profile。[网关核心 unit 计划](runtime-plan.md)和[持久核心监管入口](runtime.md)补充 root 选择状态、systemd credential、固定单元操作及未知 job 的明确停止恢复。它们还未接入完整协调器或安装服务，不能由选中代次和 unit running 推导网络 ready。

## 输入契约

这是独立于应用配置的部署输入，`schemaVersion` 必须为 `1`。所有字段均必填，根对象和嵌套对象均拒绝未知字段。下面只有合成地址与身份：

```ts
import { renderNetworkPlan } from './plan.ts';

const plan = renderNetworkPlan({
  schemaVersion: 1,
  generation: 'a'.repeat(64),
  core: {
    serviceUid: 12345,
    binarySha256: 'b'.repeat(64),
    unitSha256: 'c'.repeat(64),
  },
  ingressInterface: 'lan-test',
  gatewayIPv4: '192.0.2.2',
  prefixLength: 24,
  routerIPv4: '192.0.2.1',
  routerMAC: '02:00:00:00:00:01',
  clientIPv4: '192.0.2.3',
  dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 },
  marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 },
  priorities: { capture: 10003, egress: 10002, return: 10001 },
});
```

输入只接受普通对象或空原型对象及 JSON 标量；此版本没有数组字段，因此拒绝数组。函数检查属性描述符，不调用 getter、`toJSON` 或原型方法；拒绝 Proxy（包括已撤销的 Proxy）、accessor、Symbol 属性、非枚举属性、自定义原型、循环以及 `__proto__`／`constructor`／`prototype` 属性。拒绝 `undefined`、函数、BigInt、非有限数和负零。最多遍历 128 个值、8 层、每个对象 32 个属性，键与字符串的 UTF-8 总大小最多 16 KiB。这些限制只约束传入数据；巨大对象自身的创建成本不属于本函数。

字段约束如下：

| 字段 | 约束 |
| --- | --- |
| `generation`、两个核心摘要 | 64 位小写十六进制；generation 对应待运行候选，不能用路由器 revision 替代 |
| `core.serviceUid` | `1..4294967294` 的整数；必须另行核验实际进程、二进制与 unit，UID 相同本身不构成授权 |
| `ingressInterface` | 1–15 位 ASCII，字母开头，余下为字母、数字、`_`、`-`；拒绝 `lo`、`all`、`default`，不能等于 TUN |
| `tun.interface` | 固定为本模块拥有的 `coproxy-tun`；已有同名设备必须通过归属预检 |
| `tun.mtu` | `1280..9000` 的整数 |
| IPv4 与前缀 | 标准十进制 IPv4，不接受前导零、CIDR 字符串、空白或 IPv6；网关、路由器、终端互异且在同一 `/8..29` 子网，不能是该子网网络地址或广播地址；拒绝 `0/8`、`127/8`、`169.254/16`、组播与高位保留地址 |
| `routerMAC` | 精确小写冒号格式的非零单播 MAC；用于验证路由器交付的二层来源 |
| `dnsPort` | `1024..65535` 的整数；实际监听冲突仍须预检 |
| `marks` | mask 与三个 mark 为非零无符号 32 位整数；三个 mark 互异且完全包含于 mask。替换公式为 `(old & ~mask) \| value`，所有非保留位保留；conntrack 也只能使用同一 mask |
| `tables` | 三个互异整数，范围 `10000..19999`，避开系统默认表；实际占用仍须预检 |
| `priorities` | 三个互异整数，范围 `10000..19999`，严格 `return < egress < capture`，在主路由规则前执行；现有规则仍须完整审阅 |

该版本有意只接受同一 IPv4 子网的单终端，便于明确约束同接口回程。不自动推断入口、下一跳、MAC、接口或现有网络；不同子网、多终端、额外目的 CIDR 例外及双栈须扩展契约后再实现。

## 资源与流量边界

归属固定为 `coproxy-network-v1`。拥有的 inet nftables 表名是 `coproxy_guard` 和 `coproxy_data`，链名也由输出固定；TUN 名固定，路由协议固定为 `186`。表号、规则优先级和 mark 位来自经审阅的输入，但不能据此接管已有外部资源。未来 helper 必须在唯一写入锁内核对所有资源与保留空间；拒绝外部冲突，只处理本模块确切拥有的资源，不能清空整张外部路由表或防火墙。

三个路由域始终保留高 metric 黑洞默认：

- capture 只在激活时增加低 metric 的 TUN 默认路由，没有物理出口默认路由。
- egress 的低 metric 默认路由经明确路由器，路由器 `/32` 链路路由只用于解析下一跳。新核心上游 socket 必须在首包前带 egress mark，并绑定本代核心的 PID、启动时间、UID、二进制、unit 和精确 cgroup v2 socket 来源。
- return 只接受来自 TUN、目的为终端 `/32` 的 return mark 规则。终端 `/32` 路由强制 `via routerIPv4`，不能直接 ARP 终端。TUN 回程与核心新出站相互分离。DNS 回复使用 egress 域经路由器返回，也不能直接解析终端邻居。

不增加 SNAT。入口只分类明确接口、路由器 MAC、原终端 IPv4 的 TCP/UDP，并排除网关和路由器自身地址。入口保留 mark 必须清除后按本代重新分类，不能信任外部送入的 mark。持久 guard 拒绝错误接口／MAC 的终端源地址、原样入口到物理出口转发、未获本代许可的转发与核心上游出站；本地网关管理不属于转发捕获范围。[固定规则](rules.md)及隔离内核测试覆盖这些转发语义；生产 helper 仍须实现资源归属、外部绕行预检、持久事务和运行证据核验。

核心单元固定为 `coproxy-mihomo.service`，其 systemd `ControlGroup` 必须精确为 `/system.slice/coproxy-mihomo.service`，运行在 cgroup v2 中。未来 helper 必须将 boot ID、PID 启动时间、该单元的精确 ControlGroup 路径及当前 cgroup 内核身份一起绑定并回读，确认成员仅为受绑定核心进程、目录由 root 控制且未委派，共享服务 UID 无法迁移进程或加入外部成员。核心重启或 cgroup 重建后，旧内核身份不能继续授权。

管理与核心当前可能共享服务 UID，nftables 无法直接按 PID 匹配包；仅检查 PID、UID、二进制再按 UID 放行不能满足此契约。helper 必须证明 `nft socket-cgroup-v2` 或等效的逐 socket 来源机制可用，并验证每个获例外的 socket 确实来自该精确绑定的核心 cgroup，在首包前应用受限 mark。`coproxy-management.service` 即使 UID 相同，其 socket 也不得获得核心上游或 DNS 回复例外。等效机制必须提供同样的逐 socket 来源证据，不支持或无法证明时保持阻断，禁止降级成 UID 匹配。规则已实现 cgroup 表达式，只读 observer 已实现固定路径、成员、权限与内核身份回读；实际部署及完整逐 socket 隔离仍待验证。

LAN DNS 仅允许明确入口接口、路由器 MAC，源为终端 `/32` 或路由器 `/32`，目的精确为网关 IPv4 与专用端口的 UDP/TCP。其他源访问该监听应丢弃，其他目的不能借 DNS 例外通过。监听不得 wildcard bind，须由同一核心 PID 拥有；通过本代证据前保持 LAN 阻断。独立允许显式绑定 `127.0.0.1`、从 `lo` 访问该精确监听的本地 UDP/TCP 探针，用于激活前验证，不构成客户端放行。bootstrap 独立，采用真实地址解析。路由器仍负责只交付选中终端的公网解析并保留本地域／无点名称；该计划不拦截任意目的 DNS，不宣称验证了 DoH／DoT。

DNS TCP 的初始 SYN 必须由精确入口和核心监听 cgroup 共同证明，才能在专用 CT mark 保留位记录授权；新 SYN 必须重新证明监听归属。仅精确 DNS reply 方向、已有出口 socket mark、UID、目的、端口、出口接口和 SYNACK flags 的握手包可以使用这一替代证明。其余核心出站仍须 socket cgroup 匹配；不从 CT mark 恢复任意 packet mark，不引入通用按 UID 放行。该路径解决 Linux 6.1 `request_sock` 不能由 nft socket cgroupv2 直接识别的问题，详见[规则说明](rules.md)。

IPv6 只声明阻断到达本机指定接口、来自路由器 MAC 的 IPv6 转发。链路本地控制不属于转发捕获范围；无法从 IPv4 终端地址推导任意 IPv6 终端身份。路由器必须在外部阻断受管终端公网 IPv6，不能把本机规则当作覆盖路由器直出路径的证据。

## 阶段、证据与失败

输出没有可直接执行的任意命令。`phases` 是未来固定 helper 的操作白名单契约；渲染成功只证明输入契约有效，各阶段均尚未执行：

1. 在任何写入前完成只读预检。核对平台、权限、网络既有状态、所有权、保留 mark／表／优先级、转发与反向路径过滤等条件。首次预检失败保持原状态，不能以计划自动修复 sysctl。
2. 首先持久保存启用意图并安装 guard，回读确认后才能继续；核心退出、重启和部分应用都不能移除该保护。
3. 安装三张表的黑洞默认，再安装规则与经路由器的 egress／return 路由，分类保持未激活，capture 仍只能黑洞。
4. 先核验同代核心 PID、二进制、unit、启动时间与 root 控制的 cgroup；只为该核心开放精确出口及本地 DNS 探针，客户端转发和 LAN DNS 仍阻断。
5. 再验证实际 UDP/TCP DNS 查询、精确监听、同 PID 持有且名称／地址／MTU 正确的 TUN、路由器邻居、出口 mark 及既有资源回读证据。
6. 在唯一写入锁内再次核验证据，增加 capture 的 TUN 路由，再启用受限分类／guard 例外／LAN DNS，最后回读并重新核验；任一步异常进入阻断状态。
7. 仅报告本地 ready。`terminalPath` 始终为 `unverified`，实际终端、路由器与出口／回程验收仍须独立完成。

每条运行证据必须匹配 generation、整个计划的 SHA-256、boot ID、核心 PID、PID 启动时间、精确单元 ControlGroup 及其 cgroup v2 内核身份，最长 30 秒；还须证明逐 socket 来源隔离与共享 UID 管理服务的排除。任一缺失、过期或不匹配均保持阻断。执行者还须保证单一写入者与当前代次 CAS，不能把旧的 ready 状态用于新代次。

`faultPolicy` 要求核心、DNS、TUN、链路、邻居、代次、证据、部分应用或资源不一致时保留启用意图，先重申 guard，保留全部黑洞默认并禁用分类例外；capture 路由撤回或继续被 guard 保护。不存在自动直连 fallback。恢复要求重新预检、取得新鲜绑定证据后显式重新激活。手动关闭是另一个经授权的生命周期，此模块不生成卸载／恢复直连计划，也不操作路由器。

禁止的变更包括 sysctl、主机地址、主路由表／默认路由、路由器配置、外部资源和软件安装。已有环境不满足要求时应报告，不能由本计划扩张修改权限。

## 摘要和验证

`sha256` 是规范化输出中除 `sha256` 本身外全部字段按固定顺序 `JSON.stringify` 后的 UTF-8 SHA-256。对象输入键顺序不会影响结果；部署输入、代次、约束或操作语义变更都会改变摘要。不加入时间戳，不承诺跨未来 schema／实现修订保持摘要。输出是普通内存对象；调用方修改对象后原摘要不再有效。未来 helper 应从已验证输入重新渲染并比对完整摘要，不能信任浏览器提交的任意操作对象。

输入与输出含部署身份、地址和拓扑，`sensitive: true`；真实计划应保存在被忽略的本地私有资料中，不公开打印或放入发行包。摘要只提供确定内容标识，不提供签名或执行授权。

针对性测试：

```text
node --experimental-strip-types --test tests/network-plan.test.ts
```

测试覆盖确定摘要、输入隔离、三表与失败保护、严格字段及地址／接口／端口边界、精确 DNS、IPv6 声明边界、mark 高位与保留位、恶意属性和 Proxy。它们只验证纯计划契约。

`tests/network-kernel-live.test.ts` 另使用固定官方核心和 VLESS 节点，在全新 user/network namespace 子树中验证 client/router/gateway/origin 四角色。初始规则／路由阶段由原生资源会话执行，并调用实际 DNS/TUN 探针；另验证同配置外部路由不被认领、额外 nft 规则污染被拒绝。业务覆盖透明 HTTP/UDP、实际 DNS UDP/TCP、原源地址与经路由器回程、错误 MAC、无 mark 的同 UID socket、核心退出后的既有／新会话、独立删除 TUN 和唯一节点退出后的阻断。正向业务实际使用客户端 DNS 回答中的地址，并核对节点侧域名解析；域名 REJECT 先证明同一目的 IP 的原始访问可达，再验证域名关联后的拒绝，避免节点限制造成假通过。隔离 fixture 使用实际现有 cgroup、禁用管理例外，不证明生产两个服务 cgroup 隔离，也不修改主机网络或代替真实设备验收。缺少显式二进制路径或 Linux 前提时跳过；提供路径后能力缺失或路径失败会真实报错。

后续固定执行者可使用[有界命令传输](command.md)，仍须自行核验授权、资源归属、事务和内核事实。
