# 本地分流模板

`buildLocalPolicy({ proxies, selections, rules, mode })` 返回可交给配置编译器的 Mihomo 策略。无运行时下载或外部规则文件；部署、监听和 DNS 仍归编译器管理。逻辑全局和直连模式分别只生成 `MATCH,Proxy`、`MATCH,DIRECT`，核心使用规则模式执行，因此不会应用业务或国内补漏。

本地模板启用 TCP 多地址并发建连，并关闭网关无须使用的本机进程匹配；可信部署可显式覆盖这些性能选项。规则模式使用 `domestic-v2` 标记和固定规则引用，编译器在外部输入校验后插入随包提供的 `inline` 域名/IP 集合，保留三个正则及用户、业务规则的优先关系；工作区显示集合引用。集合不包含 URL 或文件路径，外部策略依然不能提供 provider。运行重编译严格核对集合与固定资源并比较完整候选代次。此前保存的 `domestic-v1` 候选仍按旧资产校验；新的工作区请求显式应用后才升级规则和 DNS。

`serviceCatalog` 定义内置业务分类的服务 id、显示名、说明、默认标记及精确／后缀匹配字段，随 CoCoProxy 一同提供。默认创建十个组；`selections` 出现可选服务的 id 时启用该组，出现其他合法名称时创建自定义组，供手工规则引用。`localGroupChoices(proxies, groupId)` 返回 UI 可选目标。Proxy 初始选择第一个节点，无节点时选择 REJECT；其他业务及 Other 跟随 Proxy，Domestic 初始 DIRECT。显式 DIRECT／REJECT 可用于每个组，亦接受旧模型的 direct／block 别名。引用只允许业务或自定义组跟随 Proxy；拒绝其他组间引用、未知目标、组与节点名称冲突及重复节点，避免选择器选项形成循环。

手工规则先于业务规则。YouTube 的精确主机先于 Google 后缀；明确业务先于 Proxy 境外聚合，再依次匹配国内顶级域、完整国内域名、国内目的 IPv4，最终 MATCH 到 Other。Domestic 选择 DIRECT 时，编译器将国内域名集合及 `.cn` 交给部署的直连解析器（未单独配置时使用引导解析器），避免国内 CDN 使用境外解析结果；显式域名 DNS 策略保留。Domestic 选择代理时不添加这条国内 DNS 策略。IP 规则不自动添加 `no-resolve`，让 Mihomo 对域名目标解析后匹配地址；IPv6 接管不在当前范围内。

手工规则支持 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、DOMAIN-REGEX、IP-CIDR、IP-CIDR6、SRC-IP-CIDR、SRC-IP-CIDR6、DST-PORT、SRC-PORT、NETWORK；IP 类型可显式带 no-resolve。规则保留顺序和匹配语义，目标必须是已启用组、节点、DIRECT 或 REJECT。嵌套逻辑规则、规则集下载、含逗号的表达式和提前 MATCH 不属于此模板输入；最终完整语法仍须经 Mihomo 配置检查。

国内资源由 `sources.lock.json` 固定的 MetaCubeX/meta-rules-dat 上游 `geo/geosite/geolocation-cn.json`、`geo/geosite/cn.json` 和 `geo/geoip/cn.json` 输入派生。`geolocation-cn` 的 5390 条规则覆盖地理分类，无法单独覆盖常用国内网站和静态资源；上游说明 `cn` 使用 ChinaMax_Domain 完整聚合，此固定版本包含 110446 条后缀规则。两者仅去除完全相同的规则后得到 111813 条域名规则，保留原地理分类的 44 条精确域名和三个正则，不将精确域名扩大为后缀，也不因已有父后缀而删改来源规则。此处使用完整 `geo` 资产；上游注明可能不全的 `geo-lite` 国内集合不作为替代。国内 IP 保持原来的 6525 条 IPv4，与当前部署范围一致。

完整域名块的展开 JSON 约 4.21 MB，编译器 `inline` 域名集合的 payload 约 1.86 MB；域名条数和来源摘要均固定，更新时必须重新评估编译输入、输出体积及值数量预算。源版本、SHA-256、来源及合并后的计数和许可证地址见 `sources.lock.json`；第三方许可证为 `LICENSE.domestic`。维护时显式运行 `node packages/routing/generate-assets.mjs`，在内存下载并校验固定输入，生成原生规则数组，并将原有 5390 条域名规则保存在 `legacy-domestic-data.ts`，供旧候选的兼容校验使用。生成过程不保存第三方原始 JSON、二进制 SRS 或缓存。运行使用随包生成的离线资源，不依赖远端规则下载。新增字段、前导点后缀、哈希或数量变化均拒绝生成，需单独审阅转换语义。
