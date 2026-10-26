# 上游组件维护

CoCoProxy 分别固定 Mihomo 核心、MetaCubeXD 源树与 overlay、离线规则资产及 npm/tooling 依赖。更新其中一类不能自动扩大其他组件的兼容范围。每次更新形成独立、可审阅的提交，记录来源、变更原因、实际验证和未验证项；发布与目标安装分别按[发行装配](release-staging.md)和[部署维护](deployment.md)执行。

## 锁与证据的职责

| 文件或目录 | 职责 | 更新时核对 |
| --- | --- | --- |
| [components.json](../integrations/metacubexd/components.json) | 管理组件来源/压缩包/锁文件摘要、各核心平台下载资产及解压后二进制摘要 | 固定提交与 tag 对应；平台、ELF machine、压缩包摘要和二进制摘要分别确认 |
| [review.json](../integrations/metacubexd/review.json) | 审阅与实际验证记录；包含与组件锁对应的来源及历史上游默认核心版本 | 组件一致性、日期、每项验证范围及 false/未执行项；不能把旧版本的运行证据沿用到新字节 |
| [source-tree.json](../integrations/metacubexd/source-tree.json) | MetaCubeXD 完整原始源树 blob/模式清单 | 完整提交、文件集和执行位；在依赖安装/overlay 前校验 |
| [overlay](../integrations/metacubexd/overlay) | 项目持有的完整文件替换与新增文件 | 原上游差异、项目差异及新上游差异逐项比较；不能只确认补丁可应用 |
| [routing/sources.lock.json](../packages/routing/sources.lock.json) | 规则来源提交、各输入 SHA-256、转换后数量及许可 | 与生成脚本、生成资产及旧候选兼容一致 |
| [package-lock.json](../package-lock.json)、[tooling/package-lock.json](../tooling/package-lock.json) | 根运行依赖/类型与独立构建工具的精确版本和 integrity | 包声明一致、生产闭包、许可证、生命周期脚本、引擎及体积变化 |

当前基线为 MetaCubeXD v1.273.1、Mihomo v1.19.33；精确提交和摘要以锁文件为准。MetaCubeXD 源码自带的默认核心 v1.19.27 不决定实际发行核心。

## MetaCubeXD overlay 清单

下表从当前 `integrations/metacubexd/overlay/` 的 58 个文件归类。表内路径相对该目录；分组表示应共同审阅的边界，不表示文件只影响一种行为。新增、删除或上游移动文件时同步此清单及 overlay 检查。

| 边界 | 文件 |
| --- | --- |
| Server 生命周期（2） | `apps/server/lib/supervisor.ts`、`apps/server/plugins/boot-kernel.ts` |
| Server 集成/构建（2） | `apps/server/lib/cocoproxy.ts`、`apps/server/nitro.config.ts` |
| Server 认证与路由（6） | `apps/server/middleware/auth.ts`、`apps/server/routes/[...].ts`、`apps/server/routes/config.js.ts`、`apps/server/routes/api/[...].ts`、`apps/server/routes/api/clash/[...].ts`、`apps/server/routes/api/control/[...].ts` |
| UI 启动与认证（5） | `packages/ui/nuxt.config.ts`、`packages/ui/middleware/auth.global.ts`、`packages/ui/plugins/cocoproxy.client.ts`、`packages/ui/plugins/desktop-endpoint.client.ts`、`packages/ui/plugins/desktop-sync.client.ts` |
| UI 页面（6） | `packages/ui/pages/cocoproxy.vue`、`packages/ui/pages/login.vue`、`packages/ui/pages/overview.vue`、`packages/ui/pages/proxies.vue`、`packages/ui/pages/rules.vue`、`packages/ui/pages/subscriptions.vue` |
| 工作区与导航（9） | `packages/ui/components/MobileBottomNav.vue`、`packages/ui/components/NativeProxies.vue`、`packages/ui/components/NativeProxyMasterDetail.vue`、`packages/ui/components/NativeRules.vue`、`packages/ui/components/ProtectedResources.vue`、`packages/ui/components/RuleTestPopover.vue`、`packages/ui/components/Sidebar.vue`、`packages/ui/components/WorkspaceGroupsMenu.vue`、`packages/ui/components/WorkspaceToolbar.vue` |
| 自动选择与时延显示（7） | `packages/ui/components/AutomaticProxyNode.vue`、`packages/ui/components/AutomaticSelectionSettings.vue`、`packages/ui/components/AutoProbeSettings.vue`、`packages/ui/components/ConnectionErrorBanner.vue`、`packages/ui/components/Latency.vue`、`packages/ui/components/ProxyNodeListItem.vue`、`packages/ui/components/TcpLatency.vue` |
| UI 会话/工作区 composables（5） | `packages/ui/composables/useApi.ts`、`packages/ui/composables/useCoCoProxy.ts`、`packages/ui/composables/useProxyWorkbench.ts`、`packages/ui/composables/useWebSocket.ts`、`packages/ui/composables/useWorkspace.ts` |
| UI 时延/刷新 composables 与状态（7） | `packages/ui/composables/useBatchLatencyTest.ts`、`packages/ui/composables/useLatencyFeedback.ts`、`packages/ui/composables/useProxyRefresh.ts`、`packages/ui/composables/useTcpDelay.ts`、`packages/ui/stores/proxies.ts`、`packages/ui/utils/latencyBatch.ts`、`packages/ui/composables/__tests__/useTcpDelay.spec.ts` |
| 工作区测试（1） | `packages/ui/composables/__tests__/useProxyWorkbench.spec.ts` |
| 站点检测与浏览器耗时（4） | `packages/ui/components/ConnectivityBoard.vue`、`packages/ui/components/LatencyCard.vue`、`packages/ui/composables/useReachabilityBoard.ts`、`packages/ui/composables/__tests__/useReachabilityBoard.spec.ts` |
| 通知与安装清单（4） | `packages/ui/components/NotificationSettings.vue`、`packages/ui/composables/useNotifications.ts`、`packages/ui/public/cocoproxy-sw.js`、`packages/ui/public/manifest.webmanifest` |

上游更新时重点保留这些边界：原 Agent 启动/刷新/直接写活跃配置通道被禁用，配置应用统一进入 CoCoProxy 事务并由 systemd 监管；公共 `config.js` 不注入凭据；浏览器固定同源会话认证的 Controller HTTP/WS，核心 secret 留在服务端；Desktop 同步与上游离线缓存禁用，自有通知 Worker 和安装清单按设备主动启用。不能因新上游增加路由、插件或全局钩子而恢复旁路。

当前 Nitro 全局 WebSocket upgrade gate 处理 crossws 对无处理器路径的升级行为，HTTP middleware 单独不足。该检查在 `apps/server/lib/cocoproxy.ts`；升级 Nitro/h3/crossws 时必须复核 HTTP 和 upgrade 两条入口。当前服务为单实例 Node preset，进程内短会话不能推导多 worker 会话共享/同步撤销支持。

## 分别更新四类输入

### 1. Mihomo 核心

1. 审阅目标版本的官方源码提交、发布资产及相关配置/Controller/TUN/DNS 变化，分别取得两种架构的压缩包摘要与解压后字节摘要；匹配 ELF64 little-endian 与平台 machine。
2. 更新组件锁及对应审核元数据，检查 [gateway/profile.ts](../packages/gateway/profile.ts) 的平台摘要、测试 fixture 和其他固定版本引用。使用 `rg` 搜索旧 tag、提交及摘要，逐项判断，保留有用途的历史候选兼容记录。
3. 按影响运行 `test:mihomo`、`test:gateway`、`test:runtime` 及 `test:release-stage`；有现成可信二进制和隔离前提时再执行 `test:core-live`/相关协议测试。`mihomo -t` 仅证明语法，不能替代核心运行或透明网关验收。
4. 对每个平台分别记录已执行的运行范围；跨架构装配不执行外来二进制，x86-64 构建成功不能写成运行验证通过。网关配置/路由行为变化还需契约及目标组合验收。

### 2. MetaCubeXD 源码与 overlay

1. 固定目标 tag 对应的完整提交，取得完整原始源树清单、源码压缩包和上游 pnpm 锁摘要。对比旧/新上游及项目 overlay，特别查找新入口、重命名、删除文件及依赖生命周期变化。
2. 在独立、干净且未安装依赖的源码目录验证树。共同更新 `source-tree.json` 与组件/审核锁，核对 overlay 工具读取的组件提交及新清单一致，搜索并处理其他残留版本引用；不能单独改 tag 绕过 blob 校验。
3. 按[集成构建步骤](../integrations/metacubexd/README.md#准备与构建)安装已经获许可的限定 Server/UI 依赖并应用 overlay，固定 pnpm、`--frozen-lockfile --ignore-scripts`；不顺带安装 Desktop/Electron 或浏览器资产。安装/构建前后比较上游锁文件，禁止为了通过构建静默重写它。
4. 执行 `test:git-tree`、`test:overlay`、UI generate、适配 UI 类型检查及 Server build。按影响执行管理端认证/Controller/WS 和真实回环浏览器流程，明确哪些需要现成工具。overlay 工具只接受对应原始 blob 或相同已应用内容，遇到漂移应重新审阅/重建，不能强制覆盖手改。
5. 复核产物中不恢复凭据注入、Agent 生命周期、直接配置写入、Desktop 同步或远程离线缓存；更新构建/运行审核项，保留未完成的上游类型检查和目标 systemd 验收状态。

### 3. 离线规则资产

1. 审阅固定上游提交、每个输入 SHA-256、许可证及分类语义；共同修改 [generate-assets.mjs](../packages/routing/generate-assets.mjs) 和预期计数，不把远端“最新”下载加入运行路径。
2. 在更新任务已授权的条件下显式执行 `node packages/routing/generate-assets.mjs`。它在内存下载并校验固定输入，写入生成数组、许可及来源锁；不保存原始 JSON/SRS/缓存。不要把网络失败改为跳过校验。
3. 对照 [routing 模块说明](../packages/routing/README.md)确认精确/后缀/正则语义、国内与境外交集优先级、明确排除的正则及旧候选兼容。旧 `legacy-domestic-data.ts` 和候选标记不能随新名单丢弃。
4. 运行受影响的 `test:config`、`test:workspace`、`test:gateway` 和必要的核心语法检查；检查候选输入/输出字节、值数量预算、DNS 分流及恢复时的代次核验。更新数量本身不等于所有域名分类正确。

### 4. npm、tooling 和构建依赖

1. 区分根运行依赖、根类型声明、tooling 和上游 pnpm 依赖；单独审阅版本/引擎、许可证及安全修复，不把 UI 更新与全部依赖升级捆成一个不可区分的提交。
2. 项目依赖任务不自动授权改变本机环境；需要安装/改版本时遵循会话中的明确授权。CI 使用固定锁安装、禁用生命周期脚本。验证更新后的包声明、锁 integrity 及生产闭包，不能通过删锁或忽略 lockfile 修复失败。
3. 按受影响模块执行类型和针对性检查；运行依赖或 Nitro trace 变化必须验证 Server build 与 `test:release-stage`。装配保留完整生产闭包与许可，不能仅复制 Nitro 裁剪 trace。

## 已有例外与退出条件

| 例外 | 当前理由与范围 | 重新审阅/移除条件 |
| --- | --- | --- |
| 适配 UI 显式用 TypeScript 5.9.3 | 当前上游 vue-tsc 默认启动 TypeScript 7 的问题；[专用脚本](../scripts/typecheck-metacubexd-ui.mjs)检查适配 UI | 上游修复或升级类型工具后重试原生检查；未执行上游全量检查时保持审核 false |
| http_ece 1.2.0 许可正文补件 | npm 包缺正文；仅针对固定版本/integrity，装配按固定上游正文哈希补入 | 依赖升级或 npm 包包含正文时重新审阅，删除不再必要的补件逻辑；依据见[补件来源](../integrations/http-ece/README.md) |
| 四个依赖 CI/目录元数据省略 | 装配仅省略 jws/jwa 的 `opslevel.yml`、buffer-equal-constant-time 的 `.travis.yml`、minimist 的 `.github/FUNDING.yml` | 上游包结构/版本变化时重新检查；不扩展为任意敏感路径过滤例外 |
| 构建警告 | 当前记录 UI 大 chunk、上游未使用 import；构建成功不抹除警告 | 更新后复核是否消失/变化，新增警告单独说明，不统一忽略全部警告 |
| 运行验证缺口 | `review.json` 的 x86-64 运行、完整 systemd 集成及 `compatibilityVerified` 未通过 | 完成对应平台/场景证据后逐项修改；不因版本发布、锁校验或回环成功改为全部通过 |

每个新增例外须注明精确版本/文件范围、必要理由、验证影响与退出条件。对未知来源漂移、缺许可、实际哈希不符或权限/凭据边界变化应停止本次装配并修正输入；不能以宽泛 allowlist 把异常固化。

## 变更完成与交付核对

相关检查通过后审查 diff、来源锁、overlay 清单、许可及必要脱敏结论，更新[支持矩阵](support-matrix.md)/[发行说明](release-notes.md)中的实际范围。维护检查选择以 [package.json](../package.json)和[开发说明](development.md)为准，无关检查无需全跑。

发布装配从干净、已提交的 HEAD 读取；版本、组件锁、审核记录、源码树、manifest 与附件来源必须一致。更新同一目的的代码和相应验证一起提交，遵循 `type: 中文说明`；未经当前请求授权不推送、创建/移动 tag 或修改 Release。原始下载、构建目录、真实运行记录及私有配置保持本地，源码/载荷明确排除 `.local/`。
