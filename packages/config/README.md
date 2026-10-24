# 配置编译

`index.ts` 导出 `compileConfig(input: unknown): Candidate`、`ConfigError`、`canonicalJson(value: JsonValue): string` 与 JSON 类型。无第三方运行时依赖；模块使用 Node 原生类型剥离支持的 TypeScript 语法。

输入结构见 `examples/explicit-proxy.json`。`schemaVersion` 仅支持 `1`；`deployment` 的三个端口必须是 1–65535 的不同整数，控制凭据不能为空，bootstrap DNS 必须是 IP 字面量。示例使用文档专用地址，必须替换后才能实际连接。

`policy` 保留没有触及安全边界的未知 JSON 字段。`sources` 只接受 `{id, proxies}` 的已取得节点快照，与 `policy.proxies` 合并。来源 ID、节点名和策略组名不得各自重复；节点与策略组也不得同名或使用内置策略保留名。来源快照获取失败时，由上层决定是否继续使用先前快照；编译器没有下载、缓存、自动回退和网络访问能力，缺失快照直接失败。

候选的 `config` 是可作为 YAML 输入的 JSON。编译器固定 loopback 显式代理和控制器监听，禁用 LAN、TUN 与 IPv6，使用 `redir-host` 真实地址 DNS；DNS 上游仅来自部署参数。输入和输出没有共享可变对象。`id` 与 `sha256` 相同，均为 `canonicalJson(config)` UTF-8 字节的 SHA-256；对象键排序，数组顺序保留，配置内容相同则标识稳定。候选本身可包含凭据，调用方必须保护其存储与日志；错误只返回固定消息和 `code`，不回显输入内容。

保护字段一律拒绝，即使输入值为 `false`。部署监听、认证、DNS、TUN、外部 UI、profile 持久化、provider、脚本、文件证书和出口接口／路由标记等配置不开放。递归检查会拒绝嵌套 provider、插件执行、文件字段和出口覆盖；因此部分原本合法的 Mihomo 高级协议选项也暂不受支持。`RULE-SET`、`GEOIP`、`SRC-GEOIP`、`GEOSITE`、`IP-ASN`、`SRC-IP-ASN` 与 `SCRIPT` 规则暂不支持，复合规则与子规则同样拒绝，以免隐式依赖外部文件或下载。策略模式仅允许 `rule`。

这不是完整的 Mihomo schema 校验器。节点协议字段、规则语法与组引用的完整合法性仍须在应用前通过目标版本的 `mihomo -t` 检查。未知字段保留不代表核心接受或执行它们；本轮不提供网关接管、物理出口保证、故障时防直连或完整网络隔离，调用方仍可明确配置 DIRECT 规则。显式代理仅约束生成配置中的入口，不能代替操作系统网络边界。

编译输入最多约 4 MiB（UTF-8 字符和键的预算）、100000 个 JSON 值、48 层深度、5000 个节点、100 个来源、1000 个策略组；JSON 数据必须是无访问器的普通对象／数组，不接受循环、非有限数字、非 JSON 对象及原型污染键。错误码为 `INVALID_INPUT`、`LIMIT_EXCEEDED`、`PROTECTED_FIELD`、`NAME_CONFLICT`。这些边界用于有界离线编译，不代替上游完整校验。
