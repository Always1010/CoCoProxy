# CoCoProxy

CoCoProxy 是部署在 Linux 外接设备上的局域网代理方案，使用 Mihomo 处理代理协议、DNS 和分流，提供基于 MetaCubeXD 的浏览器界面管理订阅、节点和规则。协同路由器负责终端接入、流量交付及独立关闭，可采用满足能力要求的原厂固件或组件。

当前版本为 **0.1.0-preview.1 体验版**。自动网关支持整个同子网 LAN 的普通 IPv4 设备，也兼容显式单终端配置，受管公网 IPv6 阻断。按总指南显式启用持久运行后，两端在启动及同 LAN 断线恢复时自动恢复上次成功配置，并在等待期间保留保护。ARM64 有实机证据及多来源真实核心隔离验证；物理断电、换口、实体多终端等验收边界见[发行说明](docs/release-notes.md)。任意防火墙停止或全表清空仍无连续阻断保证。

## 从哪里开始

源码日常操作使用 `bash scripts/build-release.sh` 构建、`sudo bash scripts/deploy-local.sh` 部署。默认全量；可用 `--components frontend|backend|core` 选择单项范围，部署自动遵循产物范围。前端更新保留核心运行；后端和核心模式复用未选组件产物，部署仍进入完整维护窗口。首次启用及兼容限制见[按组件构建](docs/development.md#按组件构建)。

| 需要做什么 | 阅读入口 |
| --- | --- |
| 第一次搭建，从接线到日常使用 | [从零部署与使用总指南](docs/getting-started.md) |
| 判断设备和路由器是否适用 | [支持范围与设备条件](docs/support-matrix.md)，[路由器契约 v1](docs/router-contract.md) |
| 本机／SSH 安装、升级或卸载 | [部署与维护](docs/deployment.md)，[HTTPS 配置](docs/management-https.md)，[可信部署与性能选项](examples/deployment-options.md) |
| 管理订阅、方案、节点和规则 | [使用说明](docs/usage.md) |
| 理解组件、流量和配置应用 | [软件架构](docs/architecture.md) |
| 开发、构建与验证 | [开发说明](docs/development.md)，[管理界面构建](integrations/metacubexd/README.md)，[上游维护](docs/upstream-maintenance.md) |
| 装配发行载荷 | [发行装配](docs/release-staging.md) |

开发基线为 Node.js ≥22.18，依赖由根目录与 tooling 锁文件固定。CLI 入口为 `npm run cli -- help`，模块参考从架构文档进入。

源码、本地资料和提交规则见 [AGENTS.md](AGENTS.md)。真实配置、凭据及环境记录留在被忽略的本地区域，源码同步和发行明确排除 `.local/`。
