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

## MetaCubeXD overlay 的理由与升级方法

完整替换/新增文件由 [overlay](../integrations/metacubexd/overlay) 和固定 [source-tree.json](../integrations/metacubexd/source-tree.json) 表达。新增路径在固定树中无同名项；替换的 base blob/mode 直接从 source-tree 读取，不另抄路径计数和机器清单。覆盖的人工维护重点如下：

| 范围与关键文件 | 存在理由及接管行为 | 更新时核对 |
| --- | --- | --- |
| Server supervisor、boot-kernel、control 路由和 auth middleware | systemd 和 CoCoProxy 事务持有核心生命周期；旧 Agent/getAgent 及直接写活跃配置通道明确拒绝 | 新上游新增/改名路由、插件或 supervisor 不得恢复旁路；HTTP middleware 不能替代全局 WS upgrade gate |
| Server cocoproxy 桥接、API catch-all、clash relay、SPA catch-all | 惰性加载管理网关，认证失败/加载失败可解释；Controller HTTP/WS 统一同源会话，secret 仅服务端；SPA 回退不吞 API/资源错误 | Nitro/h3/crossws 接口、路由优先级、异常和连接清理、背压/撤销；新入口须审阅 |
| Server nitro.config、公共 config.js | Node 单实例、项目源码及完整生产依赖；公共脚本不注入凭据 | trace 闭包、public 覆盖顺序、缓存头、静态 config 注入；不能推导多 worker 会话同步 |
| UI auth.global、login/cocoproxy 页面、同源插件 | 管理员/可信设备会话、退出与撤销、事务恢复；旧 profiles/config/control 路径转入自有流程 | 新页面守卫、hash 路由、错误/等待与触屏操作文字，不能恢复任意远程 endpoint 或核心 secret 登录 |
| UI nuxt.config、Desktop 空插件 | 独立 CSR/hash 页面，关闭上游 PWA、Workbox 离线缓存及 Desktop 同步 | 新插件/桥接/缓存是否重启旁路，不能恢复离线页面缓存 |
| subscriptions、proxies/rules 页面、工作区 store/composable | 来源私密 URL、保存与更新分开、方案隔离；规则/选择自动经事务生效，保留旧草稿兼容 | revision、过时响应和页面切换、当前来源删除限制、保存与生效的反馈，不能直接写活跃配置 |
| traffic 页面、connections store | 用量由后端持续采集并存入 SQLite，浏览器只保留实时连接展示；来源始终按 IP 分组，括号备注独立于登录授权 | 不恢复浏览器 IndexedDB 采集、核心重启清空历史或按登录名称推测设备；检查分页、过期明细提示、请求取消与窄屏 IP 优先展示 |
| NativeProxies/组节点组件、自动选择、TCP/代理/站点检测 composable | 统一检测范围、进度、取消、站点设置和结果；自动策略/节点元数据由后端约束 | 请求去重、代次/取消、组和方案隔离、真实0值、节点不适用情况；前端显示不能扩张检测结论 |
| 导航、Modal、toolbar、规则测试等基础组件 | 移动端可见操作文字、更多导航、受控关闭/焦点及规则解释 | 新路由、虚拟列表/滚动、弹层卸载清理、窄屏溢出与焦点；构建不代替实际触屏验证 |

当前全局 upgrade gate 位于 apps/server/plugins/boot-kernel.ts，局部 relay 位于 apps/server/routes/api/clash/[...].ts，HTTP 和 upgrade 两条入口分别复核。文件理由有变化时更新本表对应职责，避免重新维护逐文件实现摘要。

测试按真实范围选用：latency-batch 直接测纯调度；workspace-ui 抽取脚本在 VM/stub 中执行；overlay 内 composable/store spec 需要现成 Vue/Vitest 环境，不能称 DOM 或真实网络验证。management/controller、automatic-selector、tcp-delay、rule-test、site-probes 保护后端契约，不能替代适配文件执行。management-server-live 的 Server/浏览器分支需要显式构建/浏览器输入；它们不证明 systemd 或物理网络。metacubexd-overlay 测合成 blob、幂等及漂移/冲突，不证明上游修复已保留；未有直接断言的桥接失败、组件焦点/布局等仍是缺口，不为填表新增镜像测试。

上游更新按以下步骤作人工三方比较：

1. 固定旧/新完整提交及可信来源，核对 catalog、各 manifest.commit 和完整 Git 树的路径/blob/mode；解包目录在安装依赖前用 verify-git-tree.mjs 验证。manifest 自称 commit 不能替代来源身份。
2. 用 `git diff --find-renames --name-status <old> <new>` 先看全树新增/删除/重命名，再看 Server/UI 内容。不能只看当前 overlay 同名文件，须找新路由、插件、构建 hook 和生命周期/认证旁路。
3. 对每个受影响覆盖读取旧 base、新上游和当前 overlay 完整内容：旧→新识别修复/API/依赖变化，旧→overlay 确认自有理由，新→overlay 判断保留、手工移植、冲突或撤销。可用 `git show <commit>:<path>` 和私有目录中的 diff --no-index，差异退出1属正常。
4. 替换文件删除/改名时确认职责迁移，再决定跟随、转新增或撤销；自有新增遇上游同名视为所有权冲突，即使字节相同也记录新归属/base。来源不可读、blob 不符或职责不清时先解决，不空占位、不强制套用。
5. 在同一目的提交中更新组件/审核锁、source-tree、必要 overlay 和本表理由；记录对应路径、旧新来源、三方结论、采用/拒绝理由、实际检查及未验证项。原始 diff/输出留私有位置，不新增长期审阅模板。
6. 先验证新原始树，再在已获环境许可且具备现成依赖的目录应用、构建和按影响检查。overlay 应用工具只接受锁对应 base 或相同已应用字节；可应用不表示上游修复已审阅。

## 分别维护五类上游

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

### 5. 路由器适配组件

当前提供可选的 [AlwayRoute SSH 适配器](../scripts/router-ssh-hook.py)，由[远程部署入口](deployment.md#后续更新)在升级时调用。动作、参数映射、版本化声明及真实能力检查以[路由器契约中的适配器说明](router-contract.md#alwayroute-参数映射)为准；它不安装或更新组件、升级固件，也不生成通用固件配置。其他路由器可以提供符合该入口约定的 hook；存在 hook 不能证明整个组合已经满足[路由器契约 v1](router-contract.md)。

1. 单独审阅路由器固件、协作组件和适配器的变更，核对 `job_status`、`external_status`、`external_get`、`external_apply`、`external_disable` 的实际 API 和结果语义。AlwayRoute 启用动作使用已有配置的 revision；异步任务须等待完成并读回确认，不能只按 SSH 退出码判断已启用或已关闭。
2. 维护状态映射、任务超时、独立关闭及原开启意图恢复的行为。关闭结果须确认交付、保护残留及专用 DNS 已撤销；故障或不稳定状态应停止协调并要求审阅。真实连接参数与恢复记录保持私有，适配器只引用已有密钥和主机指纹文件，不为维护复制凭据。
3. 按影响执行 `python3 -B tests/router-ssh-hook.test.py` 与远程协调的合成检查，核对任务失败、超时、状态读回及原意图保留。它们不连接路由器，不能替代固件重载、重启、故障阻断及外设离线后独立关闭的组合验收；真实设备操作与对方项目修改须在各自授权范围内执行。
4. 更新兼容记录时分别注明行为契约版本、实际固件/组件与适配器版本，以及 R1–R9 各项的验证范围和未执行项。适配器的版本化声明、实际 capabilities 校验和组合验收各有范围，具体边界见[路由器契约](router-contract.md)；不能把 `status` 返回的 `enabled` 或一次合成检查写成组合验证，也不要求两端使用相同产品版本号。

## 已有例外与退出条件

| 例外 | 当前理由与范围 | 重新审阅/移除条件 |
| --- | --- | --- |
| 适配 UI 显式用 TypeScript 5.9.3 | 当前上游 vue-tsc 默认启动 TypeScript 7 的问题；[专用脚本](../scripts/typecheck-metacubexd-ui.mjs)检查适配 UI | 上游修复或升级类型工具后重试原生检查；未执行上游全量检查时保持审核 false |
| 构建警告 | 当前记录 UI 大 chunk、上游未使用 import；构建成功不抹除警告 | 更新后复核是否消失/变化，新增警告单独说明，不统一忽略全部警告 |
| 运行验证缺口 | `review.json` 的 x86-64 运行、完整 systemd 集成及 `compatibilityVerified` 未通过 | 完成对应平台/场景证据后逐项修改；不因版本发布、锁校验或回环成功改为全部通过 |

每个新增例外须注明精确版本/文件范围、必要理由、验证影响与退出条件。对未知来源漂移、缺许可、实际哈希不符或权限/凭据边界变化应停止本次装配并修正输入；不能以宽泛 allowlist 把异常固化。

## 变更完成与交付核对

相关检查通过后审查 diff、来源锁、overlay 清单、许可及必要脱敏结论，更新[支持矩阵](support-matrix.md)/[发行说明](release-notes.md)中的实际范围。维护检查选择以 [package.json](../package.json)和[开发说明](development.md)为准，无关检查无需全跑。

发布装配从干净、已提交的 HEAD 读取；版本、组件锁、审核记录、源码树、manifest 与附件来源必须一致。更新同一目的的代码和相应验证一起提交，遵循 `type: 中文说明`；未经当前请求授权不推送、创建/移动 tag 或修改 Release。原始下载、构建目录、真实运行记录及私有配置保持本地，源码/载荷明确排除 `.local/`。
