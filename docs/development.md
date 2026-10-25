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
| 原生网关与部署 | `test:gateway`、`test:deployment` |
| 载荷与源码装配 | `test:release-stage`、`test:git-tree` |
| CLI | `test:cli` |
| 旧 network 框架 | 对应 `test:network-*`；该框架不在当前主路径，见[保留框架说明](../packages/network/README.md) |

单元层覆盖输入约束、冲突、权限、锁、持久提交和恢复；显式替身不构成真实服务或网络验收。Linux 文件权限、进程与内核行为须在 Linux 验证。

## 真实组件与隔离检查

测试使用显式指定、已安装的工具和固定审核二进制，不自行下载或安装。缺少前提时的跳过不计为通过；提供路径后摘要或实际路径失败应报错。

| 入口 | 需要的输入与观察范围 |
| --- | --- |
| `test:core-live` | `COPROXY_TEST_MIHOMO`：核心语法、身份、回环 HTTP 与 UDP/TCP DNS |
| `test:protocol-live`、`test:protocol-reality-live` | 再提供 `COPROXY_TEST_SING_BOX`：真实协议回环，范围见[协议夹具](../integrations/protocol-fixture/README.md) |
| `test:management-live` | `COPROXY_TEST_SERVER` 指向构建后 Server；浏览器子项另需 `COPROXY_TEST_PLAYWRIGHT` 与 `COPROXY_TEST_BROWSER` 绝对路径 |
| `test:gateway`、`test:deployment`、`test:runtime` | 部分子项读取 `COPROXY_TEST_MIHOMO` 或 `COPROXY_TEST_SYSTEMD_ANALYZE` 执行真实语法解析 |
| `test:network-kernel` | 固定 Mihomo/sing-box、Linux Python/ip/nft/unshare/TUN；在隔离 namespace 内验证旧框架四角色路径 |

示例：

```sh
COPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo npm run test:core-live
COPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo COPROXY_TEST_SING_BOX=/absolute/reviewed/sing-box npm run test:protocol-live
```

Server 检查使用临时合成凭据和 loopback 端口，不替代 systemd 应用。浏览器截图仅在显式 `COPROXY_TEST_ARTIFACTS` 私有目录保存。隔离内核测试与原生网关局部实验各自有范围，不能合并推导生产服务、物理网络或重启可靠性。

## 待完成的验收

当前主要缺口是冷启动／规则清空期间的连续阻断、开机启动与整机重启、持续负载，以及 x86-64 和新路由器组合；具体状态以发行说明为准。扩大到多终端、跨网段或 IPv6 前须先完善两端配置与故障模型。

源码同步与打包遵循 [AGENTS.md](../AGENTS.md)，排除本地资料、凭据、依赖和生成物，不跟随共享目录链接。
