# HTTPS 节点快照下载器

`HttpsSnapshotClient(options)` 实现 `SnapshotClient`。本模块只下载文本；解码、来源 revision、快照保存和应用仍分别由订阅存储、配置编译和运行事务负责。

部署必须提供 `allowedOrigins`，精确列出允许的 HTTPS origin；不支持通配符、URL 内嵌用户名口令或 fragment。URL 中的查询凭据只作为私有输入，不进入公共输出。重定向只能保留初始 origin，每一跳重新检查地址，不能降级到 HTTP。最多三次重定向，可在 0–5 之间收紧或调整。

DNS 结果先按地址策略检查，再直接连接已检查的 IP，使用原 URL 主机名进行 SNI 和证书身份检查，保持 Host 头。连接不再查询一次 DNS，也不复用跨请求连接池。TLS 始终验证信任链和身份；可显式提供私有 CA，但不能关闭证书校验。[Node.js TLS 身份检查](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscheckserveridentityhostname-cert)

默认保守拒绝私网、回环、链路本地、文档、转换和其他特殊地址；IPv6 仅接受策略覆盖的普通全局单播。地址策略参考 [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) 与 [IPv6 特殊地址登记](https://www.iana.org/assignments/iana-ipv6-special-registry/)，不是对所有未来公网分配的自动兼容保证。部署确需内网源时须显式设置 `allowPrivateAddresses: true`，仍受精确来源许可与 TLS 校验限制。未指定、组播等无效目标始终拒绝。

默认总期限为 15 秒，覆盖 DNS、连接、正文和所有重定向；响应上限 1 MiB，可显式限制到不超过 4 MiB。只接受 UTF-8 未压缩正文，请求声明 identity 编码；不执行隐式解压。ETag 仅接受不超过 512 字符的可打印 ASCII，重定向后不把上一个资源的条件标签传给新资源。DNS 超时会停止等待，晚到结果不发起请求，但不能取消系统已经启动的底层 DNS 查询。

命令行通过显式 JSON 策略文件接入，允许字段仅为 allowedOrigins、allowPrivateAddresses、timeoutMs、maxBytes、maxRedirects、ca；不暴露测试用 resolver 注入。示例见 examples/subscription-policy.json。策略文件和真实来源定义放在私有区域；不把查询令牌写进命令行参数。

测试使用回环 HTTPS 服务及运行时生成的一次性证书，依赖开发主机已有 openssl，不在测试中安装工具，不将私钥入库。测试覆盖真实握手、错误主机名、不受信证书、DNS 连接固定、跨源和循环重定向、大小/编码/UTF-8/总期限，以及 CLI 到私有节点快照再到候选配置的完整路径。它们不证明真实订阅平台、YAML 解析或代理核心可用。
