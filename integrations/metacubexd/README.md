# MetaCubeXD 集成与构建

固定上游为 **v1.273.1**，提交 `8bbc8f58fef71148a94fb5c0ff808f79b057337d`，完整476文件 blob 清单见 [source-tree.json](source-tree.json)，组件来源锁见 [components.json](components.json)，组件审核见 [review.json](review.json)。构建核对提交与内容，不只信任 tag。版本更新按源码仓库的[上游维护流程](https://github.com/Always1010/CoCoProxy/blob/main/docs/upstream-maintenance.md)分别处理核心、UI/overlay、规则及依赖；完整 overlay 清单与现有例外也在该文档维护。该维护参考属于源码文档，不随运行载荷提供。

当前 UI 提供概览、连接、流量、日志、节点、订阅和规则。日常流程见[使用说明](../../docs/usage.md)，工作区与兼容草稿见[管理模块](../../packages/management/README.md)，支持格式见[订阅模块](../../packages/subscriptions/README.md)。

## Overlay 边界

| 上游功能 | 本项目处理 |
| --- | --- |
| Agent supervisor、boot-kernel、刷新 scheduler | 禁用原生命周期，配置应用统一进入自有事务，由 systemd 监管核心 |
| refresh-apply、profile-editor、control 路由 | 不保留直接写活跃配置、脚本或启动旁路 |
| config.js 凭据注入 | 只提供无凭据公共配置，核心 secret 留在服务端 |
| UI endpoint/sync、controller 连接 | 禁用桌面同步，固定同源会话认证的 HTTP/WS |
| 页面 | 适配本地／订阅工作区、策略和规则；自动组保留算法 |
| PWA、mock、远程字体 | 关闭上游 PWA 与离线缓存；关闭 mock，使用系统字体 |

Nitro 全局 WS upgrade gate 补足 crossws 0.3.5 对无处理器路径的默认升级行为，不能只靠 HTTP middleware。当前只支持单实例 Node preset；短期会话在进程内，受信任设备授权在私有状态目录持久保存，不支持多 worker 共享或同步撤销。

上游默认核心 v1.19.27 不进入本项目运行锁；实际使用审核后的 Mihomo v1.19.33。来源与许可见本目录 MIT [LICENSE](LICENSE)及 Mihomo [GPLv3](../mihomo/LICENSE)。

## 准备与构建

使用项目专用上游目录，保持来源、依赖和生成物不入本仓库。按[开发说明](../../docs/development.md#环境与构建)准备已获许可的根与 tooling 依赖，再将 UPSTREAM 设为独立源码绝对目录。

先在尚无 node_modules/生成物的干净源树核对 blob 与执行位，拒绝额外文件及危险路径：

```sh
node scripts/verify-git-tree.mjs --directory "$UPSTREAM" --manifest integrations/metacubexd/source-tree.json
node tooling/node_modules/pnpm/bin/pnpm.cjs --dir "$UPSTREAM" --filter '@metacubexd/server...' --filter '@metacubexd/ui...' install --frozen-lockfile --ignore-scripts
node scripts/apply-metacubexd-overlay.mjs --directory "$UPSTREAM"
CI=true NUXT_TELEMETRY_DISABLED=1 node tooling/node_modules/pnpm/bin/pnpm.cjs --dir "$UPSTREAM" --filter @metacubexd/ui generate
node scripts/typecheck-metacubexd-ui.mjs --directory "$UPSTREAM"
CI=true COCOPROXY_SOURCE_DIR="$PWD" node tooling/node_modules/pnpm/bin/pnpm.cjs --dir "$UPSTREAM" --filter @metacubexd/server build
```

安装限定 Server/UI 依赖，使用固定 pnpm 10.34.1，不执行依赖生命周期脚本。构建前后核对上游锁文件不变；不安装 Desktop/Electron 或浏览器资产。UI 类型检查脚本显式使用锁定 TypeScript 5.9.3，以避开上游 vue-tsc 3.3.10 默认调用 TypeScript 7 的启动问题。

Server 默认从项目根 `node_modules` 跟踪运行依赖；隔离构建可显式设置 `COCOPROXY_RUNTIME_DEPENDENCIES` 为已按根锁文件安装的绝对 `node_modules` 目录。该输入不写入运行配置，装配仍校验锁和依赖完整性。

Overlay 工具逐项核对原上游 blob 或相同已应用 overlay，整批预检后原子替换，拒绝未知漂移、冲突和目录链接。更新 overlay 后从核验过的原始源树重新装配，不强行覆盖手改。已有依赖／产物的目录不再是原始干净源树。

## 运行与验证

审阅私有设置后可启动回环服务：

```sh
COCOPROXY_MANAGEMENT_CONFIG=/absolute/private/management.json NITRO_HOST=127.0.0.1 NITRO_PORT=18080 node "$UPSTREAM/apps/server/.output/server/index.mjs"
```

此 HTTP origin 仅限精确 loopback；远程入口使用匹配 origin 的 HTTPS 反代。启动管理服务不自动应用新配置，核心应用依赖单独安装的 unit 和授权。

`test:overlay` 检查装配；真实 Server／浏览器参数见[开发说明](../../docs/development.md#真实组件与隔离检查)。构建产物用于[发行装配](../../docs/release-staging.md)，部署验收范围见[发行说明](../../docs/release-notes.md)。
