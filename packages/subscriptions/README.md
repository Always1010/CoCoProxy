# 订阅与快照

`SubscriptionStore(root, client?, decoder?)` 在私有绝对目录保存来源和已接受的编译输入，不生成候选或应用配置。写入与配置事务共用根锁；下载／解码在锁外，提交复核来源 revision。无 client 时 refresh 返回 `SOURCE_CLIENT_REQUIRED`，不联网或推进版本。

## 输入格式

| decoder | 接受的内容 |
| --- | --- |
| 默认 JSON.parse | 严格 `{proxies: [...], nodeDnsPolicy?: {...}}`，其他根字段拒绝 |
| `decodeNodeSnapshot` | JSON 或单份 Clash YAML 1.2，提取 proxies 及匹配节点的安全 DNS 策略 |
| `decodeSubscriptionProfile` | 管理服务使用；保留内联节点、策略组、rules、sub-rules 和允许的策略数据，可接受仅有规则／组的配置 |

完整 decoder 剥离运行模式、监听、controller、DNS、TUN、地理数据下载等部署根字段，通过 `unsupportedFields` 仅披露字段名。上游 `mode`（包括常见的 `Rule`）不会覆盖方案控制的规则模式；编译结果固定为 `rule`。保留内容须通过[编译器安全边界](../config/README.md)，拒绝脚本、文件读取、出口覆盖等；不是完整 Mihomo schema 校验，实际应用前仍执行核心 `-t`。

管理服务刷新当前本地方案已使用的 `kind:nodes` 来源时，继续使用节点 decoder，只更新节点和专用 DNS，不将旧节点来源自动升级为订阅分流方案。Store 的受信调用者可通过 `refresh(id, revision, {nodesOnly:true})` 明确选择此行为；完整来源仍使用完整 decoder，既有 GEOIP 等外部地理数据规则的拒绝边界不变。

DNS 仅额外保留实际导入节点服务器域名使用的解析器，存入私有 `nodeDnsPolicy`。从 `dns.nameserver-policy` 和 `dns.proxy-server-nameserver-policy` 提取精确域名或至少含两级标签的 `+.` 后缀，并投影为精确节点主机键；专用 proxy-server 策略优先，同类策略中精确匹配优先，其次选择最长后缀。未知匹配语法、不匹配节点的条目忽略；任何匹配节点的非法解析器都会拒绝本次快照，即使另有优先级更高的有效条目。不会导入监听、fake-ip、hosts 或其他 DNS 和路由副作用。

解析器字符串统一保存为数组，只接受公共 IP 字面量和 HTTPS DoH URL。DoH 可包含合法自定义端口和私有路径，拒绝 URL 身份、查询参数、fragment、反斜杠和核心扩展语法。每个主机最多16个解析器、每个端点最多2048字符，策略最多256个精确主机且序列化后不超过64 KiB。端点可能包含私有凭据，不能进入 metadata、日志或错误消息；异常仅返回固定错误码。显式 `nodeDnsPolicy` 输入及存储记录还必须使用规范精确主机键、数组形式并对应快照内节点。

拒绝 URI/base64、重复键、多文档、自定义标签和循环。有限普通锚点复制为独立 JSON；输入 ≤1 MiB、深度48、值预算100,000、别名50、展开字节4 MiB。Store 仅显式使用完整 decoder 时接受完整策略，其他 decoder 保持严格节点结构。纯内联节点沿用旧表示和摘要。

## Provider 展开

同步 decoder 遇到 provider 拒绝；完整模式 Store 使用 `resolveSubscriptionProfile(text, fetch)` 在刷新时展开成离线策略，返回 `{value,materializedProviders}`。

| 类型 | 支持与转换 |
| --- | --- |
| proxy-providers | http 或 inline，远端正文 `{proxies:[...],dns?:{...}}`，内联 payload；组 use 转为 proxies，按顺序保留并去重 |
| 自动成员 | include-all、include-all-proxies、include-all-providers，包含／排除过滤、exclude-type；仅对使用自动成员或 use 的组展开 |
| 节点 override | 安全节点字段及名称前后缀，覆盖后仍校验 |
| rule-providers | domain、ipcidr、classical；YAML payload、text 逐行或 inline |
| RULE-SET | 在 rules/sub-rules 的原位置展开，保留顺序、目标与 IP no-resolve |

域名允许精确与 `+.` 后缀，CIDR 支持两种地址族，classical 支持单条件规则及 IP no-resolve。MRS、域名通配表达式、classical 复合、嵌套 RULE-SET、未知引用、GEOIP/GEOSITE/IP-ASN 和脚本规则拒绝。

HTTP path 仅作被移除的缓存提示，不读写文件。拒绝 file、仅 path、嵌套 provider、自定义请求头和下载代理。每次下载经过相同来源许可，最多16个 provider，父配置与所有下载合计4 MiB，单个默认1 MiB，展开结果另有4 MiB和结构预算。

过滤表达式最多256字符，仅允许普通字符、字符类、锚点、交替及每分支至多一个 `.*`；不支持分组、反向引用和其他量词。定期刷新／provider 健康检查由本次静态展开替代，组自身检查设置保留，节点变化需显式刷新来源。

Provider 请求不带 ETag，无缓存的304拒绝。含 provider 的后续刷新重新获取父文档和全部 provider，不发送父 ETag；任何失败保留上次完整快照，不能接受部分结果。

远端节点 provider 的 DNS 也只提取经过过滤和 override 后仍保留节点的策略；父配置 DNS 在全部节点展开后匹配，并覆盖 provider 同主机策略。不同 provider 为同一主机声明不同解析器时拒绝，避免依赖展开顺序。provider 的其他根字段仍拒绝。

## 下载许可

`HttpsSnapshotClient(options)` 只下载文本。默认精确 `allowedOrigins` 许可 HTTPS，HTTP 需另外的 `allowedHttpOrigins`；仅 HTTP 源可使前者为空。origin 包括协议、主机、端口，不支持通配、userinfo 或 fragment，URL 查询凭据保持私有。网页不能修改部署许可。

HTTP 与 HTTPS 请求均发送 `User-Agent: clash.meta CoCoProxy/0.1`，标明支持 Mihomo 订阅格式及实际下载客户端身份，不宣称特定核心版本。部分订阅服务按客户端格式标识返回不同内容；该标识用于获取含节点专用 DNS 等 Mihomo 配置的正文，后续仍经过相同的安全提取和校验。

| 边界 | 行为 |
| --- | --- |
| 重定向 | 仅原 origin，逐跳检查地址，不降级；默认3次，可设0–5 |
| DNS 与 TLS | 解析后检查地址并直连该 IP，保留原 Host/SNI 和证书身份校验；不二次解析或跨请求池复用；可给私有 CA，不可关闭校验 |
| 地址 | 默认拒绝私网、回环、链路本地及特殊地址；显式 allowPrivateAddresses 可许可内网，未指定／组播等无效地址始终拒绝 |
| 期限与正文 | 默认总15秒，覆盖 DNS 至正文与重定向；默认1 MiB、最高4 MiB，UTF-8、identity 编码，不隐式解压 |
| ETag | ≤512可打印 ASCII；非法响应标签丢弃，重定向不转发旧资源标签 |
| 用量 | subscription-userinfo ≤512字符，无重复字段；upload/download/total 为字节、expire 为 Unix 秒，均为非负安全整数，非法头整体忽略 |

DNS 超时后晚到结果不连接，但系统 DNS 查询不能取消。200/304 可更新用量，无新头保留旧值。策略文件仅接受 allowedOrigins、allowedHttpOrigins、allowPrivateAddresses、timeoutMs、maxBytes、maxRedirects、ca，见[合成样本](../../examples/subscription-policy.json)。

## Store API

| 方法 | 契约 |
| --- | --- |
| `list()` | 按ID排序 metadata，无目录返回空；不含 URL，不是跨来源原子快照 |
| `configure({id,url?,name?},expectedRevision)` | 新增从0开始且 URL必填；更新省略／空 URL保留原值。名称非空、≤128字符。成功 revision+1 |
| `remove(id,expectedRevision)` | 锁内校验后删除，不删除已有候选；迟到刷新不能恢复已删来源或覆盖同ID重建记录 |
| `refresh(id,expectedRevision)` | 读取与提交均核对 revision；成功、304和已提交的下载／解码／校验失败均 revision+1 |
| `status(id)` | metadata 或 null |
| `snapshot(id,expectedRevision?)` | 私有 `{id,proxies,policy?,nodeDnsPolicy?,unsupportedFields?,sha256,sourceRevision}`；可选版本匹配当前来源 revision |

来源ID匹配 `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，最多100来源；URL≤8192字符。configure 在异步前复制并冻结输入，拒绝访问器与继承属性。来源URL改变清除 ETag/usage，旧快照变为非当前；地址未变的刷新失败仍可使用旧快照。304只接受当前已有快照且发出条件请求的情况，不修改快照 sourceRevision。

metadata 包含 revision、snapshotDigest、snapshotRevision、snapshotCurrent、lastAttempt、lastError、host，可选 name、kind、nodeCount、usage、unsupportedFields；无完整URL、ETag、节点凭据和上游错误。完整 policy 自含 proxies，组装时不要再重复加入节点。

## 存储与错误

每来源一个私有 `subscriptions/<id>.json`，≤4 MiB；SHA-256 覆盖规范 `{proxies,policy?,nodeDnsPolicy?,unsupportedFields?,materializedProviders?}`，缺失可选字段不参与，旧节点摘要保持不变。materializedProviders 仅记已展开状态，不保存 provider URL/path。记录版本为1，新增字段可选。

读取校验结构和摘要，损坏拒绝且不通过刷新覆盖。摘要是完整性检查，不认证私有存储写入者。POSIX目录／文件为当前身份0700/0600，无符号链接；Windows需私有祖先ACL。只读不初始化，锁争用为 STORE_LOCKED。

主要错误：SOURCE_CONFLICT、SOURCE_PENDING、SOURCE_NOT_FOUND、SOURCE_CORRUPT、SOURCE_LIMIT、SOURCE_FETCH_FAILED、SNAPSHOT_DECODE_FAILED、SNAPSHOT_UNSUPPORTED、SNAPSHOT_INVALID、SNAPSHOT_LIMIT、SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT；输入错误见实现。异常只暴露固定 code。

运行 `test:subscriptions` 和 `test:subscription-yaml` 检查存储、TLS、解码与展开；TLS子项使用已有 OpenSSL 和临时合成证书，不证明真实平台或节点连通。
