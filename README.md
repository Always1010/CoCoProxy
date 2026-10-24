# Coproxy

Coproxy 面向 Linux 网关，提供可通过浏览器管理的局域网代理、DNS 与分流能力。终端通过接入路由器统一使用服务，无需逐台安装代理客户端；软件不绑定个人设备或当前调试网络。

当前已实现配置编译、版本化草稿、受限订阅快照、不可变候选、持久化应用事务、systemd 运行适配源码和 CLI。MetaCubeXD 的适配界面已接入独立登录、策略编辑、来源管理和明确的捕获／应用操作，并通过回环 Server 与浏览器验证；核心 HTTP／WebSocket 统一经过会话鉴权和受限代理。网页来源支持 JSON 与 Clash YAML 的节点导入。固定 Mihomo 已通过语法、回环代理、UDP/TCP localhost DNS，以及受限控制器查询与流量流检查；真实 systemd 安装、协议节点、WAN DNS、网关接管和发行包仍未验收，不能将此阶段当作完整网关交付。

开发基线为 Node.js 22.18 或更高版本。运行依赖及类型声明由根 package-lock.json 固定，开发工具另由 tooling 锁文件固定；在获准的项目环境执行相应 `npm ci --ignore-scripts --no-audit --no-fund`。运行 `npm run cli -- help` 查看入口，构建管理界面和针对性检查见[开发与验证](docs/development.md)及[适配记录](integrations/metacubexd/README.md)。原生类型擦除与静态类型检查分别执行。

## 项目文档

- [项目目标与技术方案](docs/project-plan.md)：范围、开源选型、架构、实施阶段与验收要求。
- [软件架构](docs/architecture.md)：模块归属、配置事务和网关协作边界。
- [首批开发与验证](docs/development.md)：已实现范围、CLI、针对性检查和后续关卡。
- [配置模块](packages/config/README.md)与[事务模块](packages/transaction/README.md)：内部 API、保护边界和恢复约束。
- [草稿模块](packages/drafts/README.md)与[订阅模块](packages/subscriptions/README.md)：修订号、私有快照、刷新和候选捕获。
- [运行适配](packages/runtime/README.md)：systemd 单一监管、候选应用、进程与 controller 核验、恢复与安装前提。
- [管理模块](packages/management/README.md)：私有凭据、cookie 会话、策略编辑、来源捕获与统一应用入口。
- [MetaCubeXD 适配记录](integrations/metacubexd/README.md)：固定源码引用、待接入入口和候选版本差异。
- [与接入路由器的协作](docs/router-cooperation.md)：通用职责、流量和解析边界，以及本机联调资料的范围说明。
- [协作规则](AGENTS.md)：源码归属、本地资料和提交约定。

路由器端运行方式控制和相关恢复机制不纳入本仓库。路由器协作文档仅表达 Coproxy 的通用边界，不代表对方项目已经接受或实现。本机联调的共同资料保存在仓库外，通过被忽略的目录链接 `.local/lab/shared/` 直接访问；项目独有资料仍留在自己的 `.local/`。

项目独有的真实环境配置、拓扑、访问方式、调试记录和专用脚本留在 Git 忽略的 `.local/`，共同资料按共享入口维护；两者均不属于源码同步、发布包或附件。正式文件只使用通用角色、参数与合成数据。
