# Coproxy

当前发行目标为 **0.1.0-preview.1 体验版**，内容、验收范围与已知限制见[发行说明](docs/release-notes.md)。固定版本和可安装包不代表正式稳定性验收已完成。

Coproxy 是可独立部署在符合条件的 Linux 外接设备上的代理产品，承担代理协议、加密、DNS 与分流，并提供浏览器入口管理订阅、节点及配置。协同路由器负责终端接入和流量转交；AlwayRoute 是可选的路由器侧实现，Coproxy 的安装和运行不依赖它。满足要求的原厂固件或其他组件可以保留原管理方式，不预设必须刷 OpenWrt。设备按系统、架构与网络能力选择，具体条件见[协同路由器要求与说明](docs/cooperating-router-requirements.md)。

当前配置、草稿、订阅、候选、事务和管理界面已经实现，固定显式发行已通过实际 Linux/systemd 安装与事务验收。MetaCubeXD 的界面复用独立登录、策略和来源管理；核心 HTTP／WebSocket 统一经过会话鉴权。来源接受 JSON／Clash YAML 节点，HTTP 订阅须由私有部署单独许可。首轮网关使用 Mihomo 原生 TUN 自动路由／重定向，加必要的独立 guard、出口和回程集成。ARM64 Linux 与已适配接入路由器已完成一台真实终端的浏览器代理、核心停止阻断及独立关闭恢复验收；TCP／UDP 和恢复流程另有隔离网络验证。多终端、整机重启及其他硬件组合仍须分别验收，不能由这次结果推导。

开发基线为 Node.js 22.18 或更高版本。运行依赖及类型声明由根 package-lock.json 固定，开发工具另由 tooling 锁文件固定；在获准的项目环境执行相应 `npm ci --ignore-scripts --no-audit --no-fund`。运行 `npm run cli -- help` 查看入口，构建管理界面和针对性检查见[开发与验证](docs/development.md)及[适配记录](integrations/metacubexd/README.md)。原生类型擦除与静态类型检查分别执行。

当前自动网关仅支持一台明确的 IPv4 终端，受管公网 IPv6 阻断。通用部署按 Linux 架构和接入路由器能力选择，当前不承诺任意封闭固件、多终端或整个 LAN 接管；详见部署与协作说明。

## 项目文档

先看[软件架构与总览图](docs/architecture.md)：从开源组件、运行进程和模块对应关系，理解终端流量与配置应用如何经过系统。

- [软件架构](docs/architecture.md)：Mihomo 与 MetaCubeXD 的分工、整体结构图、流量图、配置应用时序图及源码导航。
- [终端访问公网的数据流](docs/traffic-flow.md)：终端原始访问、外设代理连接、同一路由器的 LAN／WAN 职责，以及请求与响应的完整路径。
- [项目目标与技术方案](docs/project-plan.md)：产品范围、早期候选选型、实施阶段与验收要求；当前实现以软件架构为准。
- [原生网关](packages/gateway/README.md)：上游自动接管、最小外部集成及首轮部署样本。
- [首批开发与验证](docs/development.md)：已实现范围、CLI、针对性检查和后续关卡。
- [配置模块](packages/config/README.md)与[事务模块](packages/transaction/README.md)：内部 API、保护边界和恢复约束。
- [草稿模块](packages/drafts/README.md)与[订阅模块](packages/subscriptions/README.md)：修订号、私有快照、刷新和候选捕获。
- [运行适配](packages/runtime/README.md)：systemd 单一监管、候选应用、进程与 controller 核验、恢复与安装前提。
- [管理模块](packages/management/README.md)：私有凭据、cookie 会话、策略编辑、来源捕获与统一应用入口。
- [MetaCubeXD 适配记录](integrations/metacubexd/README.md)：固定源码引用、待接入入口和候选版本差异。
- [与接入路由器的协作](docs/router-cooperation.md)：通用职责、流量和解析边界，以及本机联调资料的范围说明。
- [协同路由器要求与说明](docs/cooperating-router-requirements.md)：独立产品定位、外设条件、原厂固件判断、可选组件及不使用 AlwayRoute 的落地流程。
- [可重复部署](docs/deployment.md)：角色与系统边界、只读预检、七文件安装、终端验收及升级和保留数据卸载。
- [协作规则](AGENTS.md)：源码归属、本地资料和提交约定。

路由器端运行方式控制和相关恢复机制不纳入本仓库。路由器协作文档仅表达 Coproxy 的通用边界，不代表对方项目已经接受或实现。本机联调的共同资料保存在仓库外，通过被忽略的目录链接 `.local/lab/shared/` 直接访问；项目独有资料仍留在自己的 `.local/`。

项目独有的真实环境配置、拓扑、访问方式、调试记录和专用脚本留在 Git 忽略的 `.local/`，共同资料按共享入口维护；两者均不属于源码同步、发布包或附件。正式文件只使用通用角色、参数与合成数据。
