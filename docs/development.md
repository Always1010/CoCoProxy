# 开发与验证

当前架构见[软件架构](architecture.md)，版本支持及未验收项见[发行说明](release-notes.md)。本文保留开发入口和验证选择，模块契约从架构导航进入。

## 环境与构建

使用 Node.js ≥22.18 的原生 TypeScript 类型擦除；静态检查单独执行。根锁文件固定运行依赖和类型声明，tooling 锁文件固定 TypeScript、pnpm。经环境管理许可后准备项目依赖：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix tooling --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run cli -- help
```

管理 Server/UI 按[MetaCubeXD 构建说明](../integrations/metacubexd/README.md)准备固定源码、核验 Git 树并应用 overlay；完成后按[发行装配](release-staging.md)生成载荷。合成样本不能直接联网或安装，真实输入和输出保持私有。

## CLI 常用流程

下列命令从仓库根目录执行，输出使用绝对路径；`compile` 和计划生成不覆盖已有输出：

```sh
npm run cli -- compile --input examples/explicit-proxy.json --output "$PWD/.local/runtime/mihomo.json"
npm run cli -- stage --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store"
npm run cli -- status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-save --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- draft-stage --state-dir "$PWD/.local/runtime/store" --expected-revision 1
npm run cli -- validate --input /absolute/private/input.json --mihomo-bin /absolute/reviewed/mihomo
npm run cli -- deployment-plan --input /absolute/private/deployment.json --output /absolute/private/plan.json
```

stage 只保存不可变候选，draft-stage 捕获指定保存版本；均不应用。revision 使用操作返回或重新读取的实际值。validate 只执行 `mihomo -t`，不启动服务；指定核心须可信，包装器不是恶意二进制沙箱。运行应用和恢复见[运行模块](../packages/runtime/README.md)。

来源流程使用 `source-configure`、`source-status`、`source-refresh`、`source-stage`，完整参数见 CLI help；格式参考[来源](../examples/subscription-source.json)与[下载策略](../examples/subscription-policy.json)。URL 和查询凭据从私有文件输入。CLI 默认严格接受 JSON 节点快照，管理服务使用完整订阅 decoder；格式、provider 与刷新语义见[订阅模块](../packages/subscriptions/README.md)。

## 按改动选择检查

全部可用命令以 [package.json](../package.json) 为准，不需要每次全跑。

| 改动范围 | 主要检查 |
| --- | --- |
| 编译、草稿、来源 | `test:config`、`test:drafts`、`test:subscriptions`、`test:subscription-yaml` |
| 应用事务与运行 | `test:transaction`、`test:runtime`；校验包装器另用 `test:mihomo` |
| 工作区、规则、管理 | `test:workspace`、`test:management`；UI 适配另用 `test:overlay` 和独立 UI 类型检查 |
| 原生网关与部署 | `test:gateway`、`test:deployment`（含状态兼容检查） |
| 载荷与源码装配 | `test:release-stage`（含离线文档与发行元数据）、`test:git-tree` |
| 时延与网络诊断工具 | `test:diagnostics`；仅检查时延基线时用 `test:latency-baseline` |
| CLI | `test:cli` |

单元层覆盖输入约束、冲突、权限、锁、持久提交和恢复；显式替身不构成真实服务或网络验收。Linux 文件权限、进程与内核行为须在 Linux 验证。

## 真实组件与隔离检查

测试使用显式指定、已安装的工具和固定审核二进制，不自行下载或安装。缺少前提时的跳过不计为通过；提供路径后摘要或实际路径失败应报错。

| 入口 | 需要的输入与观察范围 |
| --- | --- |
| `test:core-live` | `COCOPROXY_TEST_MIHOMO`：核心语法、身份、回环 HTTP 与 UDP/TCP DNS |
| `test:protocol-live`、`test:protocol-reality-live` | 再提供 `COCOPROXY_TEST_SING_BOX`：真实协议回环，范围见[协议夹具](../integrations/protocol-fixture/README.md) |
| `test:management-live` | `COCOPROXY_TEST_SERVER` 指向构建后 Server；浏览器子项另需 `COCOPROXY_TEST_PLAYWRIGHT` 与 `COCOPROXY_TEST_BROWSER` 绝对路径 |
| `test:gateway`、`test:deployment`、`test:runtime` | 部分子项读取 `COCOPROXY_TEST_MIHOMO` 或 `COCOPROXY_TEST_SYSTEMD_ANALYZE` 执行真实语法解析 |
| `test:gateway` 的隔离内核子项 | 固定 Mihomo，显式设置 `COCOPROXY_TEST_GATEWAY_KERNEL=1`，需要 Linux Python/ip/nft/unshare/TUN；在隔离 namespace 内验证原生网关多终端路径 |

示例：

```sh
COCOPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo npm run test:core-live
COCOPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo COCOPROXY_TEST_SING_BOX=/absolute/reviewed/sing-box npm run test:protocol-live
```

Server 检查使用临时合成凭据和 loopback 端口，不替代 systemd 应用。浏览器截图仅在显式 `COCOPROXY_TEST_ARTIFACTS` 私有目录保存。隔离内核测试与原生网关局部实验各自有范围，不能合并推导生产服务、物理网络或重启可靠性。

## 请求时延基线

Windows 终端的一键上下行压测及负载下时延采集见[网络压测](network-benchmark.md)。它使用已有 Node.js 与 curl，由操作者手动运行，不改变网关或路由器设置。

`scripts/measure-latency.mjs` 仅使用 Node 内置模块。每次必须显式提供已授权的测量 URL；默认仅允许 HTTPS，禁止 URL 用户名和口令。它不会自动发现设备、读取订阅或设备配置、安装软件或启动负载。目标路径及查询可能包含私有信息，使用时按本机凭据规范处理命令历史。输出只含样本序号、测量参数、阶段时间和固定失败码，不含目标 URL、查询、端点、响应正文或原始异常。

```sh
node scripts/measure-latency.mjs --url 'https://probe.example/latency' --samples 100 --warmup 5 --concurrency 1 --timeout-ms 10000 --mode cold
node scripts/measure-latency.mjs --url 'https://probe.example/latency' --samples 100 --warmup 5 --concurrency 1 --timeout-ms 10000 --mode reuse --interval-ms 100
npm run test:latency-baseline
```

`cold` 只保证每次请求新建 TCP/TLS 连接，使用单次请求的独立 Agent，不共享工具内的 TLS 会话缓存；它不清空操作系统、核心、路由器或递归 DNS 缓存，也不修改路由、代理或主机配置。真正冷 DNS 需要经授权后在对应解析器环境安排独立条件，本工具不主动清缓存。`reuse` 使用有界 keep-alive 连接池，预热请求不计入统计；预热失败、服务端关闭连接或池未充分预热时，正式样本仍可能建立新连接，因此以每条样本的 `reusedSocket` 为准。复用样本没有发生的 DNS/TCP/TLS 阶段记为 `null`，不记为零，汇总同时给出冷连接和复用连接分组。

DNS 是本次系统 `lookup` 的耗时，字面 IP 不产生该阶段；TCP 从 DNS 完成或套接字分配至连接成功，包含 Node 多地址或地址族竞速时的尝试与等待；TLS 从 TCP 完成至安全连接成功；TTFB 从请求开始至收到响应头，total 至响应体结束。阶段时间单位为毫秒。HTTP 响应只接受 2xx，不跟随重定向；超过 8 MiB 的正文记为 `RESPONSE_LIMIT`，整体请求截止时间覆盖 DNS、建连和响应传输。失败仅记录固定分类，不把失败样本混入成功时延分位数。P50/P95/P99 使用成功且实际发生该阶段的样本，按最近秩取值，并报告样本数量；成功率范围为 0–1，失败非零时命令退出码为 1，参数错误为 2。

默认 20 个正式样本、2 个预热、1 个并发、10 秒截止时间、零间隔。参数上限分别为 10000 个样本、1000 个预热、32 个并发、120 秒截止时间和 60 秒间隔；间隔作用于每个 worker 的相邻请求，不是全局请求速率限制。`--allow-http` 是显式允许明文 HTTP 的开关，主要用于本机合成服务验证。并发与样本数量会产生实际请求，应在目标授权范围内选择。

先在空闲条件下用相同目标、参数和核心版本分别保存冷连接与复用连接基线，再在已获授权的外部负载持续运行时原样复测。逐项调整一个配置变量，比较成功率、失败分布、TTFB 和 total 的分位数及样本数，同时在现场读取 CPU、重传、队列、丢包等指标；本工具不提供这些系统读数，也不自动执行 iperf 或改动 qdisc。DNS/TCP/TLS 的变化需要结合是否复用连接判断，低样本量的高分位数不能当作稳定结论。

结果默认只写标准输出；需要留存时重定向到仓库根目录被忽略的 `.local/reports/` 中，并先显式创建所需目录。该结果包含实际性能与运行记录，遵循本地资料边界，不提交到仓库、不随源码或发行包同步。

## 待完成的验收

当前主要缺口是冷启动／规则清空期间的连续阻断、开机启动与整机重启、持续负载，以及 x86-64 和新路由器组合；具体状态以发行说明为准。实体多终端仍须现场验收；跨网段及 IPv6 扩展前须先完善两端配置与故障模型。

源码同步与打包遵循 [AGENTS.md](../AGENTS.md)，排除本地资料、凭据、依赖和生成物，不跟随共享目录链接。
