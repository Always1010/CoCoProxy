# 私有网关候选校验

`validateGatewayCandidate(candidate, expected: NetworkPlanInput)` 是无副作用的完整校验入口；`loadGatewayCandidate(settings, generation, expected)` 从私有 candidate store 按代次读取并校验，不创建目录，不启动核心，不执行网络操作。返回 `candidate`、`networkPlan`、`controller`，loader 额外返回固定 store 中的 `path`。核心工作目录由独立网关运行计划校验，不从 root 私有 state 目录推导。

`expected` 必须由部署所有者从可信配置取得，包含明确 generation、核心 UID、固定二进制摘要和 unit 摘要。不能把浏览器、HTTP 请求或执行器传入的 preview、plan 或候选内 metadata 当成可信 expected；函数只接受严格的 `NetworkPlanInput`，自行重新渲染 plan。摘要提供内容标识，不提供执行授权。调用方仍须在受保护的部署边界取得 expected，并在实际启动前独立核验二进制和 unit。

校验器先核验候选外壳与规范 JSON 的 SHA-256，再从 `x-coproxy-network` metadata 和核心配置重建 `compileGatewayPreview` 输入。策略保留完整的规则、节点和策略组；编译时折叠的离线来源节点继续保留。DNS bootstrap 与端口还原成部署输入，其余 DNS、TUN、mark、控制器与监听参数由当前编译器重新生成。只有重新编译后的完整 canonical 字节、ID、摘要和重新渲染的完整网络计划均与候选及可信 expected 一致才通过。因此给篡改配置重新计算合法 hash 也无法绕过编译器保护字段。

loader 另核验 runtime settings 的 binary SHA、service UID 和 unit SHA 与 expected 完全一致，binary SHA 必须为当前受审阅的 `GATEWAY_CORE_SHA256`。文件经 `FileTransactionStore.readCandidate` 的不可变内容与 canonical 检查后，再独立读取、核验 SHA 与 canonical 字节，防止第二次读取使用未校验内容。目录与文件继续采用现有 private-files 权限、所有者和符号链接限制；可信祖先目录由部署者保证，Windows 的私有父目录 ACL 也由部署者保证。

所有异常统一抛出 `GatewayCandidateError`，`code` 与 `message` 都为 `GATEWAY_CANDIDATE_UNTRUSTED`，不包含路径、配置、预期值或底层异常。返回对象含控制器 secret 与敏感部署信息，只能在内部运行边界使用，不得直接映射为管理 API 响应。现有 `loadRuntimeCandidate` 继续拒绝 gateway candidate，显式代理入口不会因此取得网关能力。

针对性验证：

```text
node --experimental-strip-types --test tests/network-candidate.test.ts
```

纯校验测试可跨平台运行；私有 Linux 路径及 POSIX 权限测试只在 Linux 运行。测试不安装依赖、不访问设备、不启动服务。
