# 可信部署选项

以下字段放在管理设置的 `deployment` 中，由部署操作者提供；订阅和策略不能覆盖 DNS、嗅探或网关设备设置。示例地址均为文档用途，部署时需显式替换并通过核心配置预检。

```json
{
  "bootstrapResolvers": ["192.0.2.53"],
  "nameservers": ["https://resolver.example/dns-query"],
  "nameserverPolicy": {
    "+.example.com": ["198.51.100.53"],
    "login.example.com": ["https://direct-dns.example/dns-query"]
  },
  "nodeResolvers": ["https://node-dns.example/dns-query"],
  "directResolvers": ["198.51.100.53"]
}
```

`bootstrapResolvers` 始终保留为独立的纯 IP 引导解析器。`nameservers` 仅允许无凭据、无查询、无 fragment 的 HTTPS DNS 地址。可选 `nodeResolvers` 与 `directResolvers` 分别控制节点域名和直连域名解析，允许纯 IP 或相同受限 HTTPS 形式；未指定时，在启用规则 DNS 的配置中沿用引导解析器，避免节点 DNS 依赖代理节点本身。网关拒绝把节点及直连解析器的字面 IP 指向自身或受管客户端；HTTPS 主机名的实际解析结果仍需部署操作者确认不会回到受管 DNS 链路。

`nameserverPolicy` 仅接受精确 ASCII 域名和 `+.example.com` 这种包含根域的后缀形式，不接受正则、`rule-set:`、`geosite:` 或任意远程规则来源。最多 256 条，每条 1–16 个纯 IP 或受限 HTTPS 解析器，域名最多 253 字符。配置域名策略或 `nameservers` 时启用 Mihomo `respect-rules`，并配置独立节点和直连解析。域名及 HTTPS 服务器的引导解析和实际可达性属于部署验收范围。核心语义见 [Mihomo DNS 文档](https://wiki.metacubex.one/config/dns/)。

所有新字段均可省略；旧输入仍生成原有配置和哈希，已保存候选可按原有部署设置重编译。

## 并发连接与按需嗅探

```json
{
  "performance": { "tcpConcurrent": true, "findProcessMode": "off" },
  "sniffing": {
    "mode": "missing-only",
    "skipDomains": ["+.example.com"],
    "skipPorts": [8443, "8500-8600"]
  }
}
```

`performance` 只在明确配置时覆盖同名核心策略字段。`tcpConcurrent` 接受布尔值；新建网关部署可启用，并测量多地址目标的连接延迟及资源消耗。`findProcessMode` 仅接受 `off`、`strict`、`always`；纯转发网关可选择 `off`，含 `PROCESS-NAME`、`PROCESS-PATH` 及其正则规则的策略应使用 `strict` 或 `always`。编译器拒绝通过部署配置把原有进程规则切到 `off`，旧策略显式使用 `off` 的语义继续保留。参见 [Mihomo 全局配置](https://wiki.metacubex.one/config/general/)。

`sniffing` 保留布尔兼容：`true` 等同旧的强制模式，配置与哈希保持一致；`false`、`"off"` 均关闭。新增 `"missing-only"` 只对未获得域名的流量嗅探，关闭 `force-dns-mapping`；`"force"` 同时强制嗅探已有 DNS 映射的流量。三种字符串也可写为上述对象的 `mode`。`skipDomains` 使用同样的精确域名或 `+.` 形式，最多 256 条；`skipPorts` 最多 64 个整数或闭区间，范围为 1–65535，编译时从 HTTP/TLS/QUIC 的既有嗅探端口集合扣除。不能排除全部嗅探端口；需完全关闭时使用 `off`。本地和保留目的地址继续排除。参见 [Mihomo 嗅探文档](https://wiki.metacubex.one/config/sniff/)。
