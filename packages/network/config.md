# 受保护的网关候选预览

`compileGatewayPreview(input: unknown)` 在现有显式代理编译器上生成 TUN 网关候选与绑定到该候选的网络资源计划。它只编译内存数据，不调用核心、不访问系统或网络、不保存候选、不执行 nft 或 ip，也不向管理用户授予部署权限。当前管理入口和显式运行适配器仍拒绝这种候选；不能据此启动网关。

输入为严格的普通 JSON 对象：

```ts
{
  schemaVersion: 1,
  base: /* 现有 compileConfig 的完整 schemaVersion 1 输入 */,
  network: /* renderNetworkPlan 的完整输入，但不含 generation */
}
```

基础策略及 sources 沿用[配置模块](../config/README.md)，网络字段见[资源计划的完整合成示例](README.md)。`base.deployment.dnsPort` 必须与 `network.dnsPort` 一致；全部监听使用非特权端口。网关和客户端地址不能充当 bootstrap，bootstrap 必须是独立的单播 IPv4 字面量；路由器地址是否提供独立基础 DNS，仍需部署预检证明，不能仅因编译通过认定无循环。输入拒绝 Proxy、访问器、序列化钩子、循环、非 JSON 数据、未知外层字段及过大内容。错误统一为 `GATEWAY_CONFIG_INVALID`，不附带原始值或异常 cause。

预览固定采用已审阅的 Mihomo v1.19.33 Linux ARM64 二进制摘要，不根据 PATH 或浮动版本猜测兼容。其他版本或架构要先完成相应核心审阅，再明确扩展此契约。

## 核心配置与资源归属

基础混合代理和控制器仍绑定 loopback；DNS 改为精确的网关 IPv4 和部署端口，保持 `redir-host` 和 IPv4。新建出站绑定部署 ingress 接口并使用 egress mark；DNS 监听的回复也使用 egress mark，以便由独占路由表送回路由器。

TUN 固定为 `coproxy-tun`、部署 MTU、`stack: mips`，显式关闭 `auto-route`、`auto-redirect`、`auto-detect-interface`、GSO 和 ICMP 原样转发；DNS hijack 列表为空。终端 DNS 入口仍由路由器交给专用监听，不能通过核心自动规则接管所有终端 DNS。路由和防火墙仍归未来受限网络执行者唯一管理。

固定版本的 [TUN 栈枚举](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/constant/tun.go) 接受 `mips`，其 [RawTun 与 parseTun 实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/config/config.go) 已注释公开 `inet4-address`，而是从 DNS 的 `fake-ip-range` 派生 `/30`。因此此预览固定 `fake-ip-range: 198.18.0.1/30`，即便 DNS 为真实地址模式，仍以它明确核心 TUN 地址。编译拒绝已知 ingress 子网与该前缀重叠；执行前还必须检查其他接口、路由和策略路径冲突，不能只检查 ingress。

## 代次绑定

编译器先规范化网络部署，再把不含 generation 的完整网络部署写入保留字段 `x-coproxy-network`。Mihomo 忽略这个扩展字段；它只用于 Coproxy 内容完整性，不是核心执行指令。基础策略和来源不能在任何深度提供此保留字段。

候选 ID 仍是完整规范核心 JSON 的 SHA-256，因此接口、MAC、客户端、mark、表、优先级、核心身份或普通策略变更都会改变同一代次。网络计划随后用该候选 ID 生成，避免配置代次与网络计划之间的循环摘要依赖。输出包含 `candidate`、`networkPlan`、`expectedTun`、`sensitive: true` 与 `activation: unsupported-by-current-runtime`。

配置与计划包含部署身份和 controller secret，必须保持私有。摘要标识内容，不证明授权；未来执行者仍须从受信部署输入重新编译、验证实际核心和系统事实，在同一事务锁与 CAS 下应用。直接编辑返回对象会使原摘要失效。

## 已验证与剩余工作

`tests/network-config.test.ts` 验证代次绑定、部署一致性、来源／策略隔离、恶意对象拒绝及当前显式运行适配器对 hash 合法网关候选的拒绝。显式提供 `COPROXY_TEST_MIHOMO` 后，另核对固定二进制 SHA-256 并执行真实 `-t`；缺少路径时该项跳过，不构成核心验收。

已在独立 user＋net namespace 中，使用固定核心和合成地址验证 `mips` TUN 能够启动、地址为 `198.18.0.1/30`、MTU 为 1500，TUN FD 与精确 TCP／UDP DNS socket 均属于核心进程。后续[四角色隔离内核测试](README.md)直接使用本编译器与固定规则，已验证透明 HTTP／UDP、实际 DNS UDP／TCP、DNS 地址驱动的业务连接、域名拒绝、路由器回程和核心／TUN／节点故障阻断。测试网络与进程均在隔离子树内；原始记录只留本地。

`ipv6: false` 只约束核心行为；隔离测试观察到内核仍生成 TUN IPv6 链路本地地址。不能把该设置当成内核或路由器的 IPv6 阻断证明。生产最小 capability、两个服务 cgroup 的隔离与身份核验、受限执行者、持久网络事务、运行适配接入及真实设备联调仍需完成。隔离 fixture 复用现有 cgroup 并禁用管理例外，不能替代上述生产证明。
