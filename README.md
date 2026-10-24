# Coproxy

Coproxy 面向 Linux 网关，提供可通过浏览器管理的局域网代理、DNS 与分流能力。终端通过接入路由器统一使用服务，无需逐台安装代理客户端；软件不绑定个人设备或当前调试网络。

当前已实现配置开发基础：受保护的离线编译、版本化草稿、订阅节点快照、不可变候选存储、持久化应用事务和 CLI。已增加 systemd 核心运行适配源码、受审阅服务计划与进程就绪核验，尚未安装服务或通过真实 Mihomo 验收。订阅可按显式 HTTPS 策略更新，失败保留旧快照，并捕获指定来源版本生成候选；目前仅支持严格 JSON 节点快照，完整 YAML 订阅待上游适配。网页服务、发行包和设备联调仍未交付。首选评估 Mihomo 与 MetaCubeXD Server／Agent 的组合；最终组件和版本在验证后冻结，不将候选写成已交付功能。

开发基线为 Node.js 22.18 或更高版本，使用原生 TypeScript 类型擦除；首批源码没有第三方运行依赖，无需执行依赖安装。运行 `npm run cli -- help` 查看入口，具体用法和针对性检查见[首批开发与验证](docs/development.md)。类型擦除不执行 TypeScript 静态类型检查。

## 项目文档

- [项目目标与技术方案](docs/project-plan.md)：范围、开源选型、架构、实施阶段与验收要求。
- [软件架构](docs/architecture.md)：模块归属、配置事务和网关协作边界。
- [首批开发与验证](docs/development.md)：已实现范围、CLI、针对性检查和后续关卡。
- [配置模块](packages/config/README.md)与[事务模块](packages/transaction/README.md)：内部 API、保护边界和恢复约束。
- [草稿模块](packages/drafts/README.md)与[订阅模块](packages/subscriptions/README.md)：修订号、私有快照、刷新和候选捕获。
- [运行适配](packages/runtime/README.md)：systemd 单一监管、候选应用、进程与 controller 核验、恢复与安装前提。
- [MetaCubeXD 适配记录](integrations/metacubexd/README.md)：固定源码引用、待接入入口和候选版本差异。
- [与接入路由器的协作](docs/router-cooperation.md)：通用职责、流量和解析边界，以及本机联调资料的范围说明。
- [协作规则](AGENTS.md)：源码归属、本地资料和提交约定。

路由器端运行方式控制和相关恢复机制不纳入本仓库。路由器协作文档仅表达 Coproxy 的通用边界，不代表对方项目已经接受或实现。本机联调的共同资料保存在仓库外，通过被忽略的目录链接 `.local/lab/shared/` 直接访问；项目独有资料仍留在自己的 `.local/`。

项目独有的真实环境配置、拓扑、访问方式、调试记录和专用脚本留在 Git 忽略的 `.local/`，共同资料按共享入口维护；两者均不属于源码同步、发布包或附件。正式文件只使用通用角色、参数与合成数据。
