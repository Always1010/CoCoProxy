# 首批开发与验证

当前已实现配置、草稿、来源、事务、systemd 运行适配源码、管理认证与事务 Fetch 接口和开发 CLI。固定核心已通过独立回环检查；服务尚未安装，网页集成和 LAN 接管仍未验收，不把测试替身结果作为真实核心或终端验收。

## 环境与命令

使用 Node.js 22.18 或更高版本的原生 TypeScript 类型擦除；首批代码没有第三方依赖，无需 npm install。类型擦除只加载代码，不执行静态类型检查。Linux 运行检查在明确的独立项目工作区完成，不能用其他操作系统的结果替代 Linux 文件权限、锁和进程行为验证。

严格检查工具以 `tooling/package-lock.json` 固定 TypeScript 5.9.3、Node 22 类型和 pnpm 10.34.1。在获准的项目目录执行 `npm ci --prefix tooling --ignore-scripts --no-audit --no-fund`，再运行 `npm run typecheck`。这不替换系统 Node 或包管理器；node_modules、缓存和上游构建产物不参与源码同步及提交。

以下命令从仓库根目录执行。样本只使用合成节点、文档专用 IP 和示例凭据，适合离线编译，不是可联网的部署配置。

```sh
npm run cli -- help
npm run cli -- compile --input examples/explicit-proxy.json --output "$PWD/.local/runtime/mihomo.json"
npm run cli -- stage --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store"
npm run cli -- status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-save --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- draft-status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-stage --state-dir "$PWD/.local/runtime/store" --expected-revision 1
```

compile 要求显式绝对输出路径，生成私有文件且不覆盖已有目标。stage 只保存不可变候选；status 是只读的历史状态，没有状态文件时返回空状态。公共输出只含摘要、状态和固定错误码，不打印生成配置或核心原始诊断。所有实际配置和运行状态均应在私有区域，不能提交。

已有、已审阅的核心可用于实际语法检查：

```sh
npm run cli -- validate --input /absolute/private/input.json --mihomo-bin /absolute/path/to/reviewed/mihomo
```

此命令只调用核心的 -t 模式，在权限受限的临时工作目录内校验，不启动服务。默认超时 15 秒、输出总量 64 KiB；超时终止原进程组并设置最终截止，临时内容在结束后清理。原始诊断可能含凭据，因此不输出。必须信任显式指定的二进制；该包装器不是恶意进程沙箱，不能保证清除自行脱离进程组的恶意后代。

草稿保存使用严格 revision 检查，与运行代次分开；首次保存使用 expected-revision 0。draft-stage 捕获指定保存版本并暂存对应候选，返回 stagedRevision，不应用配置。捕获后其他人可以继续保存新草稿，暂存回执仍指捕获的版本。公开的 draft-status 只有摘要与版本，私有输入不打印。

CLI 另提供 runtime-plan 纯生成和显式 runtime-apply/recover/status。后者使用固定单元的生产 systemd 适配器，没有模拟成功路径；须先取得独立安装授权并完成部署预检。详见[运行适配](../packages/runtime/README.md)。可先离线生成审阅计划：

```sh
npm run cli -- runtime-plan --input examples/runtime-deployment.json --output "$PWD/.local/runtime/service-plan.json"
```

示例的二进制摘要和 UID 为合成占位值，不能直接安装。该命令只创建私有计划文件；不会创建账户、复制系统单元、daemon-reload、enable 或 start。

## 订阅节点快照

来源定义和 HTTPS 许可策略都从私有 JSON 文件读取，避免将查询令牌暴露在命令行。以下占位路径需换成自己的私有文件，格式参考 examples/subscription-source.json 和 examples/subscription-policy.json；示例域名不是实际来源。

```sh
npm run cli -- source-configure --input /absolute/private/source.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- source-status --source-id example-feed --state-dir "$PWD/.local/runtime/store"
npm run cli -- source-refresh --source-id example-feed --state-dir "$PWD/.local/runtime/store" --expected-revision 1 --policy /absolute/private/https-policy.json
npm run cli -- source-stage --source-id example-feed --input /absolute/private/base.json --state-dir "$PWD/.local/runtime/store" --expected-revision 2
```

来源操作返回 revision。成功刷新、304 和持久化的刷新失败都会递增它；后续操作必须使用实际返回/重新读取的 revision。失败保留上次接受的快照；更换 URL 后旧快照暂不可用于新定义。source-stage 捕获指定来源版本，将节点加入基础配置的 sources 后编译并暂存，返回捕获的来源 revision 和快照 revision。基础策略需引用所需节点，重复来源或节点名由编译器拒绝。该命令不应用配置，也不把其他同时发生的草稿保存视为已应用。

当前解码只接受严格的 JSON `{proxies:[...]}`，不支持完整 YAML 订阅、远程策略组、规则或脚本。存储层可注入受审查的 decoder，后续通过上游 YAML 适配接入；此处不把临时输入格式宣称为完整订阅兼容。详见[订阅模块](../packages/subscriptions/README.md)与[HTTP 客户端](../packages/subscriptions/http.md)。

## 针对性检查

```sh
npm run test:config
npm run test:transaction
npm run test:drafts
npm run test:subscriptions
npm run test:mihomo
npm run test:cli
npm run test:runtime
npm run test:management
npm run test:git-tree
```

按修改范围选择命令。配置测试覆盖保护边界和稳定摘要；事务测试覆盖完整性、CAS、回滚、中断、跨进程锁、Linux 死锁核验和权限；草稿与订阅测试覆盖保存/刷新并发、旧回包、失败数据保留和输入完整性，HTTPS 测试用已有 openssl 生成临时证书并执行实际 TLS 握手；核心包装器测试使用明确的可执行测试替身；CLI 测试验证真实命令行进程、私有输出和不伪报运行状态。不能用这些测试宣称协议节点、核心实际语法、网关接管、DNS 或终端出口已验收。

真实核心另由显式命令执行：`COPROXY_TEST_MIHOMO=/absolute/private/reviewed/mihomo npm run test:core-live`。未提供路径时该项跳过，不下载程序；提供的二进制必须匹配 review.json 中已审阅的解压后摘要。测试执行真实 `-t`、PID/控制端口核验、回环 HTTP 转发和 UDP/TCP localhost DNS；只用高位 loopback 端口和临时私有目录，不安装服务或修改系统网络，不代表外部节点、WAN DNS 或透明接管验收。

管理模块的 API、认证和剩余挂载关卡见[管理说明](../packages/management/README.md)。普通接口测试使用显式运行替身；真实核心测试与上游构建均单列，不能混为同一种证据。

## 后续实施顺序

1. 在获准的项目目录准备固定上游源码、包管理器和锁定依赖，补静态类型检查。审查固定核心资产并记录摘要，不跟随浮动版本。
2. 依据上游适配记录接入配置编辑、订阅和唯一生命周期管理者，所有应用进入本仓库事务入口。先完成仅回环的显式代理闭环。
3. 实现受限网络执行服务与独立就绪检查；网络改动先做隔离测试，再按单终端协作范围进入设备验证。
4. 故障恢复和独立关闭通过后，才扩大接管范围与测量性能。

依赖安装、服务部署和系统网络变更分别列出实际操作与影响，遵守项目授权边界。源码同步先预览，显式排除 .git、.local、凭据、缓存和产物，不跟随本地共享链接。设备与当前环境的原始证据仅保存在本地资料区。
