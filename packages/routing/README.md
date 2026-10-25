# 本地分流模板

`buildLocalPolicy({ proxies, selections, rules, mode })` 返回可交给配置编译器的 Mihomo 策略。无运行时下载或外部规则文件；部署、监听和 DNS 仍归编译器管理。逻辑全局和直连模式分别只生成 `MATCH,Proxy`、`MATCH,DIRECT`，核心使用规则模式执行，因此不会应用业务或国内补漏。

`serviceCatalog` 保留 AlwayRoute 的服务 id、显示名、说明、默认标记及精确／后缀匹配字段。默认创建十个组；`selections` 出现可选服务的 id 时启用该组，出现其他合法名称时创建自定义组，供手工规则引用。`localGroupChoices(proxies, groupId)` 返回 UI 可选目标。Proxy 初始选择第一个节点，无节点时选择 REJECT；其他业务及 Other 跟随 Proxy，Domestic 初始 DIRECT。显式 DIRECT／REJECT 可用于每个组，亦接受旧模型的 direct／block 别名。引用只允许业务或自定义组跟随 Proxy；拒绝其他组间引用、未知目标、组与节点名称冲突及重复节点，避免选择器选项形成循环。

手工规则先于业务规则。YouTube 的精确主机先于 Google 后缀；明确业务先于 Proxy 境外聚合，再依次匹配国内顶级域、社区域名、国内目的 IPv4，最终 MATCH 到 Other。IP 规则不自动添加 `no-resolve`，让 Mihomo 对域名目标使用既有 DNS 解析后匹配地址。此模块不更改 DNS 出口或解析器，也不宣称完成 IPv6 接管。

手工规则支持 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、DOMAIN-REGEX、IP-CIDR、IP-CIDR6、SRC-IP-CIDR、SRC-IP-CIDR6、DST-PORT、SRC-PORT、NETWORK；IP 类型可显式带 no-resolve。规则保留顺序和匹配语义，目标必须是已启用组、节点、DIRECT 或 REJECT。嵌套逻辑规则、规则集下载、含逗号的表达式和提前 MATCH 不属于此模板输入；最终完整语法仍须经 Mihomo 配置检查。

国内资源由 AlwayRoute 已审阅的 `geolocation-cn` 和 `geoip/cn` 固定输入派生，精确域名不扩大为后缀，正则原样转成 DOMAIN-REGEX。国内 IP 仅包含 IPv4，与当前部署范围一致。源版本、SHA-256、计数及许可证地址见 `sources.lock.json`；第三方许可证为 `LICENSE.domestic`。维护时显式运行 `node packages/routing/generate-assets.mjs`，在内存下载并校验固定输入，生成原生规则数组，不保存第三方原始 JSON、二进制 SRS 或缓存。新增字段、前导点后缀、哈希或数量变化均拒绝生成，需单独审阅转换语义。
