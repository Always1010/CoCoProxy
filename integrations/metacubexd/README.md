# MetaCubeXD 适配记录

当前管理界面保留 MetaCubeXD 的概览、连接、流量、日志和原生节点／规则列表；订阅使用独立卡片页，代理页管理出口与策略组，规则页编辑用户覆盖。订阅自带方案与本地模板互斥生效，分别持久保存选择和规则；本地模板包含内置业务分类、国内域名与 IPv4 补漏。常用操作及导航保留短文字，验证覆盖桌面、平板横竖屏及手机。底层统一使用 Coproxy 校验、冲突检查及应用事务，日常界面不再暴露 JSON、捕获或代次操作。

工作区接口与旧草稿迁移见 `packages/management/README.md`，订阅内联配置和 provider 展开边界见 `packages/subscriptions/README.md`，本地模板来源与转换见 `packages/routing/README.md`。原生自动策略组继续由核心选择，前端不把手动选择写入其算法。旧运行配置在用户明确保存或切换前保持原状。

状态：固定源码与 Git 树已核对，Server/UI 依赖已锁定并构建；Coproxy overlay 已通过真实 Server 与浏览器回环检查。验证范围为管理登录、草稿、捕获、冲突与注销，尚未验收真实 systemd 服务应用或完整网关组合。固定核心另通过独立回环及受限代理检查，范围见 review.json。

审查入口为 v1.273.1，其 Git 引用核对为 8bbc8f58fef71148a94fb5c0ff808f79b057337d。后续构建应核对提交，不只信任可移动 tag。上游是 pnpm 工作区；Agent 包是 private workspace 包，不能假定可从 npm 独立安装。根配置指定 pnpm 10.34.1。[根配置](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/package.json)、[Agent 包](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/package.json)

## 已核对的适配点

| 上游入口 | 源码事实 | Coproxy 接入要求 |
| --- | --- | --- |
| packages/agent/src/index.ts | createAgent 直接创建 supervisor，默认创建脚本执行器，并连接订阅刷新任务 | 不原样实例化后再叠加监管；组合受控模块或增加有界适配点，禁止来源脚本 |
| packages/agent/src/types.ts | 导出 supervisor 与 profile store 接口 | 对接实际生命周期和配置事务；不把接口存在当成适配已完成 |
| packages/agent/src/refresh-apply.ts | 活跃订阅刷新可写入活跃配置并重启 | 手动与自动刷新都必须进入统一暂存、校验与应用事务 |
| packages/agent/src/http.ts | 路由包括生命周期、配置及能力入口 | 审查所有修改入口；外层独立认证和访问限制；不能直接公开核心凭据 |
| packages/agent/src/profile-editor.ts | 编辑器有独立的应用逻辑 | 将编辑结果送入受保护编译器，不绕过部署边界 |
| apps/server/plugins/boot-kernel.ts | 启动时自动创建 Agent、拉起核心并启动刷新调度 | 替换自动启动路径；事务恢复与核心监管仍归本项目/systemd |
| apps/server/routes/config.js.ts | 动态脚本向浏览器注入 CONTROL_TOKEN 和可选 GITHUB_TOKEN | 替换为无凭据公共配置；管理会话与核心控制凭据分开 |

上述源码见固定提交的 [Agent 入口](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/index.ts)、[类型](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/types.ts)、[订阅应用](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/refresh-apply.ts)、[控制路由](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/http.ts)、[编辑器](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/profile-editor.ts)。

该版本上游默认核心引用为 v1.19.27，与项目调研候选 v1.19.33 不同；不能自动认为二者兼容，也不能将候选组合命名为生产版本锁。[核心资产定义](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/kernel/assets.ts)

## 构建与验收边界

获准准备依赖后，在项目专用构建目录获取固定提交并使用上游锁文件冻结依赖；先审查安装生命周期脚本，不自动运行任意准备脚本。优先只构建 Server/UI 相关依赖，不安装桌面应用或浏览器资产。上游完整源码、node_modules、缓存和构建输出不进入本仓库源文件或发布源码附件。

已记录固定提交的完整 blob 清单 source-tree.json，共 476 个文件。依赖安装前执行 `node scripts/verify-git-tree.mjs --directory /absolute/build/upstream --manifest integrations/metacubexd/source-tree.json`，按 Git blob 格式核对内容和可执行位，拒绝额外文件及危险路径；验证不会执行上游源码。已有 node_modules 或构建输出的目录不再是干净源树，不能直接用它替代安装前检查。

实际安装使用 pnpm 10.34.1，限定 `--filter '@metacubexd/server...' --filter '@metacubexd/ui...'`，加 `--frozen-lockfile --ignore-scripts`。安装前后 pnpm-lock.yaml 的 SHA-256 一致。UI 的 nuxt prepare 和其他构建步骤在明确的构建命令中执行；安装成功本身不证明这些步骤、网页或 Agent 生命周期已经适配。

固定源码及适配后的 UI `generate` 与 Server `build` 均成功，构建前后上游锁文件摘要一致。overlay 禁用 PWA、mock 和远程字体模块，使用现有 CSS 系统字体回退；保留大分块和未使用导入的构建警告。原始 Server 未启动，只运行适配产物。上游锁定 vue-tsc 3.3.10 默认调用 TypeScript 7 时启动失败；`typecheck-metacubexd-ui.mjs` 使用其 `run(tscPath)` API 显式选择本项目锁定的 TypeScript 5.9.3，完整 UI 类型检查已通过，没有修改上游锁文件或全局工具链。

overlay 已替换启动插件、原控制 router、凭据注入和桌面同步；未实例化原 Agent／scheduler。认证、受限 HTTP/WS 和事务入口统一挂载，界面保留原导航、概览、节点、连接、规则和日志，并增加登录与策略／订阅页。Node WS 全局 upgrade gate 补足 crossws 0.3.5 对无处理器路径仍接受升级的默认行为；不能只依赖 HTTP middleware 或单一路由 hook。

## 复现适配构建

先在获准环境准备本项目根依赖与 tooling，再设置 `UPSTREAM` 为独立上游源码绝对目录。对干净源树运行上面的完整 blob 校验，再按既述 frozen-lockfile/ignore-scripts 安装上游 Server/UI 依赖。下列命令从 Coproxy 仓库根目录执行：

```sh
node scripts/apply-metacubexd-overlay.mjs --directory "$UPSTREAM"
CI=true NUXT_TELEMETRY_DISABLED=1 node tooling/node_modules/pnpm/bin/pnpm.cjs --dir "$UPSTREAM" --filter @metacubexd/ui generate
node scripts/typecheck-metacubexd-ui.mjs --directory "$UPSTREAM"
CI=true COPROXY_SOURCE_DIR="$PWD" node tooling/node_modules/pnpm/bin/pnpm.cjs --dir "$UPSTREAM" --filter @metacubexd/server build
```

装配工具只复制受跟踪 overlay，逐个校验固定上游 Git blob 或已应用的相同 overlay；整批预检后逐文件原子替换，拒绝未知漂移、新增文件冲突和目录链接。它不修改依赖或执行上游代码，不将 `.local/` 同步到目标。更新 overlay 后，应从核验过的原始源树重新装配；不能用强制覆盖掩盖手工修改。复用工作区的依赖时仍须核对锁文件，不能把修改后的目录再称作原始源树。

审阅私有配置后可运行临时回环管理服务：

```sh
COPROXY_MANAGEMENT_CONFIG=/absolute/private/management.json NITRO_HOST=127.0.0.1 NITRO_PORT=18080 node "$UPSTREAM/apps/server/.output/server/index.mjs"
```

origin 必须与访问地址和可信 HTTPS 终止配置一致；上述 HTTP 仅用于精确 loopback origin。该命令不会安装服务或自动启动核心；核心应用依赖单独部署的审阅 systemd 单元与受限授权。使用 `COPROXY_TEST_SERVER` 指向构建入口运行 `npm run test:management-live`，浏览器参数与跳过规则见开发文档。只在单实例 Node preset 验证，其他部署形态尚未支持。

上游代码使用 MIT 许可证；候选 Mihomo 的 LICENSE 为 GNU GPL v3。实际分发时核对具体资产和组合，保留对应许可与来源要求；本记录不表示已制作包含这些资产的发行包。[MetaCubeXD LICENSE](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/LICENSE)、[Mihomo LICENSE](https://github.com/MetaCubeX/mihomo/blob/3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8/LICENSE)

overlay 中复用的上游界面代码沿用本目录 LICENSE 的 MIT 通知。下一关卡是服务安装与受限权限、真实协议输入、完整核心应用恢复，以及独立网络执行与单终端协作；通过前不得报告网关、节点或 LAN 已可用。
