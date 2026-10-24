# 首批开发与验证

当前实现是显式代理配置编译、版本化草稿、不可变候选存储、配置事务状态机与开发 CLI。没有真实运行适配器、网页服务或 LAN 接管；不把通过测试替身得到的结果作为真实核心或终端验收。

## 环境与命令

使用 Node.js 22.18 或更高版本的原生 TypeScript 类型擦除；首批代码没有第三方依赖，无需 npm install。类型擦除只加载代码，不执行静态类型检查。Linux 运行检查在明确的独立项目工作区完成，不能用其他操作系统的结果替代 Linux 文件权限、锁和进程行为验证。

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

CLI 入口提供上述编译、校验、候选和草稿命令。事务模块的 apply/recover 是供后续真实运行适配器调用的内部 API，目前不作为 CLI 命令开放，不提供模拟成功的生产适配器。

## 针对性检查

```sh
npm run test:config
npm run test:transaction
npm run test:drafts
npm run test:mihomo
npm run test:cli
```

按修改范围选择命令。配置测试覆盖保护边界和稳定摘要；事务测试覆盖完整性、CAS、回滚、中断、跨进程锁、Linux 死锁核验和权限；核心包装器测试使用明确的可执行测试替身，验证进程参数、输出上限、超时和脱敏；CLI 测试验证真实命令行进程、私有输出和不伪报运行状态。不能用这些测试宣称协议节点、核心实际语法、网关接管、DNS 或终端出口已验收。

## 后续实施顺序

1. 在获准的项目目录准备固定上游源码、包管理器和锁定依赖，补静态类型检查。审查固定核心资产并记录摘要，不跟随浮动版本。
2. 依据上游适配记录接入配置编辑、订阅和唯一生命周期管理者，所有应用进入本仓库事务入口。先完成仅回环的显式代理闭环。
3. 实现受限网络执行服务与独立就绪检查；网络改动先做隔离测试，再按单终端协作范围进入设备验证。
4. 故障恢复和独立关闭通过后，才扩大接管范围与测量性能。

依赖安装、服务部署和系统网络变更分别列出实际操作与影响，遵守项目授权边界。源码同步先预览，显式排除 .git、.local、凭据、缓存和产物，不跟随本地共享链接。设备与当前环境的原始证据仅保存在本地资料区。
