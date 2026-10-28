# 开发与验证

当前架构见[软件架构](architecture.md)，版本支持及未验收项见[发行说明](release-notes.md)。本文保留开发入口和验证选择，模块契约从架构导航进入。

## 本地 UI 预览

调整页面布局、操作按钮、弹窗和移动端样式时，使用独立的前端开发入口：

```sh
npm run dev:ui
```

默认访问 `http://127.0.0.1:3000/#/proxies`，只监听本机回环地址。运行真实 Nuxt 页面，模拟接口和 WebSocket 在同一个开发进程内提供合成数据，不启动管理后端、Mihomo、数据库或设备服务。预览插件将页面的 API 请求转到本机临时模拟端口，避免取消检测、刷新与 Nuxt 的请求适配及热更新连接互相干扰。未模拟的接口明确返回不可用，不转发到真实设备。正式构建不加载预览工具、模拟接口或预览工具栏。

首次需要显式提供固定上游归档与已经准备好的依赖目录，之后输入保存在被忽略的 `.local/ui-preview/settings.json`，重复启动无需再传。目录及文件路径必须为绝对路径；可用 `--port 3100` 更换端口。

```sh
npm run dev:ui -- --archive /absolute/cache/metacubexd.tar.gz --dependencies /absolute/prepared/upstream
```

归档必须匹配 `integrations/metacubexd/components.json` 固定摘要，依赖目录须保留对应的 `pnpm-lock.yaml`、根目录及 `packages/ui`、`packages/config-editor` 的 `node_modules`。可以复用现有 Server/UI 构建依赖；尚未准备依赖时，取得本机环境变更许可后，按下方说明准备根与 tooling 依赖，按 [UI 构建说明](../integrations/metacubexd/README.md)准备固定上游源码；仅为预览安装上游依赖可限定为：

```sh
node tooling/node_modules/pnpm/bin/pnpm.cjs --dir /absolute/prepared/upstream --filter '@metacubexd/ui...' install --frozen-lockfile --ignore-scripts
```

启动命令不会自动下载或安装依赖。每次从归档创建临时开发目录，核验完整文件树及 blob，再应用当前 overlay，链接已有依赖。Windows 的预览核验不比较 NTFS 无法表达的 Unix 执行位；归档摘要、文件集合和内容仍核验，此目录不能用作发行输入。开发目录退出时删除，依赖目标不删除；异常终止可能留下 `.local/ui-preview/run-*` 临时目录。真实设备资料不参与装配，也不复制 `.local/` 内容。

继续编辑 `integrations/metacubexd/overlay/packages/ui/` 中的源码。启动器自动同步新增、修改、删除并交给 Nuxt 热更新；删除覆盖文件会恢复固定上游原文件。修改 Nuxt 基础配置会触发开发服务重启。不要在临时开发目录中维护正式改动。预览工具栏组件本身也支持热更新；修改启动器或模拟接口实现后需停止并重新启动。

页面顶部“UI 预览 · 模拟数据”可展开，选择正常、空节点、大量与长名称、读取失败、慢速加载或检测超时，点击“应用并重置”刷新当前页面。选择和设置修改只保存在当前进程内；重置场景会清除，多个标签页共享该进程的场景。节点切换、基准检测、TCP 检测、站点检测、方案及设置弹窗可预览；带宽实测、设备配置应用及未模拟的管理操作不可用。首个交付重点为节点工作台和公共导航，其余页面仅覆盖已有模拟接口，不能代替业务验收。浏览器响应式模式可检查窄屏。

验证入口为 `npm run test:ui-preview`，检查模拟操作、拒绝真实接口回退以及 overlay 更新/删除恢复。修改 UI 时仍执行 [UI 类型检查](../integrations/metacubexd/README.md)，最后在真实设备验收接口、运行状态和实际探测行为。

## 环境与构建

使用 Node.js ≥22.18 的原生 TypeScript 类型擦除；静态检查单独执行。根锁文件固定运行依赖和类型声明，tooling 锁文件固定 TypeScript、pnpm。经环境管理许可后准备项目依赖：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix tooling --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run cli -- help
```

管理 Server/UI 按[MetaCubeXD 构建说明](../integrations/metacubexd/README.md)准备固定源码、核验 Git 树并应用 overlay；完成后按[发行装配](release-staging.md)生成载荷。合成样本不能直接联网或安装，真实输入和输出保持私有。

### Ubuntu 纯克隆仓库的本地构建

日常只需记住两个公共入口：`bash scripts/build-release.sh` 构建，`sudo bash scripts/deploy-local.sh` 部署本次成功结果。Shell 文件只转发参数；`build-local.mjs` 准备普通 Git 仓库输入，`build-release.mjs` 统一执行构建与装配。部署传输交给 `deploy-ssh.mjs`（也支持本机），目标端维护决策集中在 `remote-deploy.py`；不要直接调用内部安装器替代协调器。

在 ARM64 或 x86-64 Ubuntu 上克隆仓库后，不需要其他机器的私有目录、源码同步回执或已有构建配置。先准备 Node.js ≥22.18、npm、Git、Python 3、tar、flock；首次下载还需要 curl。构建以普通用户执行，首次明确允许准备项目依赖及固定构建输入：

```sh
bash scripts/build-release.sh --prepare
sudo bash scripts/deploy-local.sh
```

`--prepare` 只按根和 tooling 的锁安装项目依赖，并下载组件清单固定的上游源码与当前机器架构的 Mihomo；限定上游 Server/UI 依赖使用固定 pnpm、`--frozen-lockfile --ignore-scripts`。它不安装系统软件、不使用全局 pnpm、不更新到 latest。默认不联网安装依赖，缺失或锁不一致时提示重新运行 `--prepare`。后续日常构建使用 `bash scripts/build-release.sh`；部署行为及首次安装引导见[部署与维护](deployment.md#ubuntu-源码本机部署入口)。

构建要求干净且已提交的 Git 根目录。默认工作目录是仓库旁的 `<仓库名>-build/`，包含 `cache/`、`work/`、`releases/` 和 `build-result.json`；也可用 `--workspace /absolute/build-directory` 指定，部署时传相同参数。不能放在仓库内部、经过目录链接，或占用其他项目的目录。根和 tooling 的 `node_modules` 是项目内被 Git 忽略的依赖。构建不依赖任何预先存在的本机私有资料目录。

新入口自动为固定提交准备必要的临时源码、镜像和 Git 装配快照，复用下面已有编译与装配校验。上游依赖缓存同时按固定上游源码和当前 overlay 身份区分，防止 pnpm workspace 链接引用旧适配源码。中间目录结束时清理；成功发行保留在独立的新目录中。每次构建先撤销上一份可部署记录，失败不回退旧包。构建与部署共用工作目录锁；部署还核对当前干净 HEAD、完整文件集合和摘要，源码改变后须重新构建。

仅验证本地输入交接和失败门禁时执行 `node --test tests/build-local.test.mjs`；Linux 子项使用无私有资料目录的临时 Git 仓库、真实文件和锁，编译步骤使用替身，不下载依赖或部署系统。

### 已准备工作区的一步构建

这是集成工具入口，普通克隆仓库用户继续使用上面的两条命令。两类输入最终使用相同构建实现，不维护独立的组件策略。

Linux 开发工作区可使用通用入口，前提是同步流程已经核验源码，并准备现成的 Node、npm、Git、tar、flock、运行依赖、tooling、上游限定依赖、固定上游源码包和已审阅核心。入口只接受一份绝对路径的私有配置：

```sh
node scripts/build-release.mjs --config /absolute/private/build-config.json
node scripts/build-deploy.mjs --config /absolute/private/build-config.json
```

### 按组件构建

默认 `--components all` 保留完整构建和维护部署。支持 `frontend`、`backend`、`core` 单项范围，以及同时更新前后端、排除核心的 `management`；不接受逗号组合值。无效范围直接拒绝，不自动扩大为全量。

```sh
# 普通克隆仓库：构建前端更新，再部署成功记录中的同一范围。
bash scripts/build-release.sh --components frontend
sudo bash scripts/deploy-local.sh

# 只构建后端，复用基线 UI；部署仍进入完整维护窗口。
bash scripts/build-release.sh --components backend
sudo bash scripts/deploy-local.sh

# 同时构建前后端，复用已安装核心；部署仍进入完整维护窗口。
bash scripts/build-release.sh --components management
sudo bash scripts/deploy-local.sh

# 只装配审核核心，复用前后端；部署仍进入完整维护窗口。
bash scripts/build-release.sh --components core
sudo bash scripts/deploy-local.sh

# 已准备工作区：一步构建部署。
node scripts/build-deploy.mjs --config /absolute/private/build-config.json --components frontend
```

基线默认从当前管理服务的 ExecStart 获取，也可用 `--base-release /absolute/installed-release` 显式指定。基线必须有对应模式所需的输入摘要且完整载荷校验通过；旧发行包缺少该信息时，先全量构建部署一次。`management` 使用已有核心二进制摘要，不要求新增构建输入摘要。前端模式要求前端以外的源码、依赖、构建输入不变，文档和测试变化不计入输入摘要。

前端模式重新生成 UI 并完成承载新资源所需的 Server 打包，省略根项目类型检查；它不是完全跳过 Server 打包。构建清单绑定基线 manifest 摘要，部署时重新核验；不得选择另一个基线强行安装。默认全量构建和 GitHub 正式发行始终从当前提交构建，不依赖已安装版本。

后端模式要求基线具有 `frontendInputSha256`，复用已核验的 `server/.output/public`，跳过 UI generate 和 UI 类型检查，执行项目类型检查及 Server build。UI、上游或共享构建输入变化时拒绝。装配清单携带 `componentUpdate`，安装预检再次核对基线、全部静态资源和核心摘要；部署使用完整维护及恢复流程，会中断代理。它仅减少构建范围，不保证仅重启后端。所有局部模式均要求已有安装，旧基线缺少所需摘要时先全量构建部署。

`management` 同时执行项目类型检查、UI generate、UI 类型检查和 Server build，使用基线中的 `bin/mihomo` 装配完整发行包。基线核心必须与当前配置的审核核心及当前提交审核清单一致；不一致时拒绝，不自动扩大为全量。`componentUpdate` 绑定基线 manifest 摘要和核心 SHA256，安装预检允许前后端产物变化，但要求核心内容、大小和权限与已安装版本一致。发行包仍携带同一核心，以保持现有完整载荷布局；此模式排除核心升级，不是无核心包。部署仍进入完整维护窗口，可能停止并重新启动 MiHomo、短暂中断代理。

核心模式要求基线具有 `serverInputSha256`，复用整个 `server/.output`，跳过 UI/Server 编译与相应类型检查。保守复用摘要覆盖其余源码及构建输入；允许核心清单/审核记录变化，但单独绑定其中的管理组件元数据，修改管理版本、UI 或运行适配代码仍须全量构建。装配器继续按当前提交审核清单核对核心摘要、架构及依赖，安装预检比对全部 Server/UI 文件。核心来自既有固定二进制，不在此入口编译核心源码；未准备好输入时停止，不自动下载或安装。部署仍是完整维护，会中断代理。

构建入口附加 `--preview` 只验证输入并输出计划，不编译、不装配、不部署、不覆盖成功记录；会使用已有工作区锁。普通克隆仓库预览要求已有构建工作区，不可与 `--prepare` 同用。部署 `--preview` 的暂存和锁语义见[部署说明](deployment.md)。

配置包含绝对、规范且不经过符号链接的 `workspace`、`source`、`mirror`、`snapshot`、`runtimeDependencies`、`toolingDependencies`、`upstreamArchive`、`upstreamDependencies`、`core`、`releases`。其中 `source` 是可构建源码，`mirror` 是纯源码镜像，`snapshot` 是同次同步生成的干净 Git 根目录，`releases` 是发行输出父目录；这四者须位于 `workspace` 内且彼此及依赖输入没有包含关系。`runtimeDependencies` 和 `toolingDependencies` 分别指向已准备好的 `node_modules` 根目录；`upstreamDependencies` 指向保留 `pnpm-lock.yaml` 及上游各包 `node_modules` 的依赖工作区。pnpm 依赖内部链接可以保留，源码、快照、归档和核心路径不能通过链接重定向。

配置的 `expected` 必须包含 `commit`（40 位提交 ID）、`files`（每项为 `[相对路径, 字节数, SHA256, 是否可执行]`）与 `dirs`（完整父目录清单）。它是同步成功后生成的校验回执，不能手工复用历史回执。同步集成须与构建共同使用 `workspace/.workspace-sync.lock`：开始新同步前在锁内撤销旧配置，只有源码、镜像及快照全部核验成功后，才在锁内原子写入新配置。

构建入口在整个构建、装配及可选部署期间持有该锁；锁忙即失败。它核验镜像与构建源码的完整清单，并使用 Git clean 规则将源码与快照提交对应，允许受控的 CRLF 规范化。随后在 `source` 下新建独立临时目录，核验固定归档、Git 树、上游锁和 pnpm 版本，复用既有依赖运行项目类型检查、UI generate、适配 UI 类型检查及 Server build。默认 Node 内存上限为 3 GiB，libuv 和 Rayon 工作线程数各为 2；不安装依赖，不下载构建输入。临时构建目录在结束时清理。

每次成功装配使用全新的 `提交前缀-随机ID` 输出目录，并校验装配回执、提交、manifest 摘要、文件集合、内容及模式。普通构建保留该发行目录；构建并部署仅在全部校验通过后通过 `sudo` 调用本次发行中的公开 `deploy --local` 实现，传入确切发行目录和 manifest 摘要，复用既有安装的目标协调器。不会查找或回退到旧包。命令日志写入标准错误，最后一行标准输出为 JSON 回执，其中 `output` 是本次发行绝对路径，`manifestSha256` 是对应摘要，`deployed` 表示是否已完成部署。任一步失败即非零退出；构建失败不会进入提权部署。

仅核验编排门禁时执行 `node --test tests/build-release.test.mjs`；该测试使用临时合成源码和替代执行器，Linux 子项另核验真实 CLI 的锁竞争，不构建真实服务或执行部署。

## CLI 常用流程

下列命令从仓库根目录执行，输出使用绝对路径；`compile` 和计划生成不覆盖已有输出：

```sh
npm run cli -- compile --input examples/explicit-proxy.json --output "$PWD/.local/runtime/mihomo.json"
npm run cli -- stage --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store"
npm run cli -- status --state-dir "$PWD/.local/runtime/store"
npm run cli -- draft-save --input examples/explicit-proxy.json --state-dir "$PWD/.local/runtime/store" --expected-revision 0
npm run cli -- draft-stage --state-dir "$PWD/.local/runtime/store" --expected-revision 1
npm run cli -- validate --input /absolute/private/input.json --mihomo-bin /absolute/reviewed/mihomo
npm run cli -- deployment-plan --input /absolute/private/deployment.json --output /absolute/private/plan.json
```

stage 只保存不可变候选，draft-stage 捕获指定保存版本；均不应用。revision 使用操作返回或重新读取的实际值。validate 只执行 `mihomo -t`，不启动服务；指定核心须可信，包装器不是恶意二进制沙箱。运行应用和恢复见[运行模块](../packages/runtime/README.md)。

来源流程使用 `source-configure`、`source-status`、`source-refresh`、`source-stage`，完整参数见 CLI help；格式参考[来源](../examples/subscription-source.json)与[下载策略](../examples/subscription-policy.json)。URL 和查询凭据从私有文件输入。CLI 默认严格接受 JSON 节点快照，管理服务使用完整订阅 decoder；格式、provider 与刷新语义见[订阅模块](../packages/subscriptions/README.md)。

## 按改动选择检查

全部可用命令以 [package.json](../package.json) 为准，不需要每次全跑。

| 改动范围 | 主要检查 |
| --- | --- |
| 编译、草稿、来源 | `test:config`、`test:drafts`、`test:subscriptions`、`test:subscription-yaml` |
| 应用事务与运行 | `test:transaction`、`test:runtime`；校验包装器另用 `test:mihomo` |
| 工作区、规则、管理 | `test:workspace`、`test:management`；UI 适配另用 `test:overlay` 和独立 UI 类型检查 |
| 原生网关与部署 | `test:gateway`、`test:deployment`（含状态兼容检查） |
| 载荷与源码装配 | `test:release-stage`（含仓库文档链接与发行元数据）、`test:git-tree` |
| 时延与网络诊断工具 | `test:diagnostics`；仅检查时延基线时用 `test:latency-baseline` |
| CLI | `test:cli` |

单元层覆盖输入约束、冲突、权限、锁、持久提交和恢复；显式替身不构成真实服务或网络验收。Linux 文件权限、进程与内核行为须在 Linux 验证。

## 真实组件与隔离检查

测试使用显式指定、已安装的工具和固定审核二进制，不自行下载或安装。缺少前提时的跳过不计为通过；提供路径后摘要或实际路径失败应报错。

| 入口 | 需要的输入与观察范围 |
| --- | --- |
| `test:core-live` | `COCOPROXY_TEST_MIHOMO`：核心语法、身份、回环 HTTP 与 UDP/TCP DNS |
| `test:protocol-live`、`test:protocol-reality-live` | 再提供 `COCOPROXY_TEST_SING_BOX`：真实协议回环，范围见[协议夹具](../integrations/protocol-fixture/README.md) |
| `test:management-live` | `COCOPROXY_TEST_SERVER` 指向构建后 Server；浏览器子项另需 `COCOPROXY_TEST_PLAYWRIGHT` 与 `COCOPROXY_TEST_BROWSER` 绝对路径 |
| `test:gateway`、`test:deployment`、`test:runtime` | 部分子项读取 `COCOPROXY_TEST_MIHOMO` 或 `COCOPROXY_TEST_SYSTEMD_ANALYZE` 执行真实语法解析 |
| `test:gateway` 的隔离内核子项 | 固定 Mihomo，显式设置 `COCOPROXY_TEST_GATEWAY_KERNEL=1`，需要 Linux Python/ip/nft/unshare/TUN；在隔离 namespace 内验证原生网关多终端路径 |

示例：

```sh
COCOPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo npm run test:core-live
COCOPROXY_TEST_MIHOMO=/absolute/reviewed/mihomo COCOPROXY_TEST_SING_BOX=/absolute/reviewed/sing-box npm run test:protocol-live
```

Server 检查使用临时合成凭据和 loopback 端口，不替代 systemd 应用。浏览器截图仅在显式 `COCOPROXY_TEST_ARTIFACTS` 私有目录保存。隔离内核测试与原生网关局部实验各自有范围，不能合并推导生产服务、物理网络或重启可靠性。

## 请求时延基线

`scripts/measure-latency.mjs` 仅使用 Node 内置模块。每次必须显式提供已授权的测量 URL；默认仅允许 HTTPS，禁止 URL 用户名和口令。它不会自动发现设备、读取订阅或设备配置、安装软件或启动负载。目标路径及查询可能包含私有信息，使用时按本机凭据规范处理命令历史。输出只含样本序号、测量参数、阶段时间和固定失败码，不含目标 URL、查询、端点、响应正文或原始异常。

```sh
node scripts/measure-latency.mjs --url 'https://probe.example/latency' --samples 100 --warmup 5 --concurrency 1 --timeout-ms 10000 --mode cold
node scripts/measure-latency.mjs --url 'https://probe.example/latency' --samples 100 --warmup 5 --concurrency 1 --timeout-ms 10000 --mode reuse --interval-ms 100
npm run test:latency-baseline
```

`cold` 只保证每次请求新建 TCP/TLS 连接，使用单次请求的独立 Agent，不共享工具内的 TLS 会话缓存；它不清空操作系统、核心、路由器或递归 DNS 缓存，也不修改路由、代理或主机配置。真正冷 DNS 需要经授权后在对应解析器环境安排独立条件，本工具不主动清缓存。`reuse` 使用有界 keep-alive 连接池，预热请求不计入统计；预热失败、服务端关闭连接或池未充分预热时，正式样本仍可能建立新连接，因此以每条样本的 `reusedSocket` 为准。复用样本没有发生的 DNS/TCP/TLS 阶段记为 `null`，不记为零，汇总同时给出冷连接和复用连接分组。

DNS 是本次系统 `lookup` 的耗时，字面 IP 不产生该阶段；TCP 从 DNS 完成或套接字分配至连接成功，包含 Node 多地址或地址族竞速时的尝试与等待；TLS 从 TCP 完成至安全连接成功；TTFB 从请求开始至收到响应头，total 至响应体结束。阶段时间单位为毫秒。HTTP 响应只接受 2xx，不跟随重定向；超过 8 MiB 的正文记为 `RESPONSE_LIMIT`，整体请求截止时间覆盖 DNS、建连和响应传输。失败仅记录固定分类，不把失败样本混入成功时延分位数。P50/P95/P99 使用成功且实际发生该阶段的样本，按最近秩取值，并报告样本数量；成功率范围为 0–1，失败非零时命令退出码为 1，参数错误为 2。

默认 20 个正式样本、2 个预热、1 个并发、10 秒截止时间、零间隔。参数上限分别为 10000 个样本、1000 个预热、32 个并发、120 秒截止时间和 60 秒间隔；间隔作用于每个 worker 的相邻请求，不是全局请求速率限制。`--allow-http` 是显式允许明文 HTTP 的开关，主要用于本机合成服务验证。并发与样本数量会产生实际请求，应在目标授权范围内选择。

先在空闲条件下用相同目标、参数和核心版本分别保存冷连接与复用连接基线，再在已获授权的外部负载持续运行时原样复测。逐项调整一个配置变量，比较成功率、失败分布、TTFB 和 total 的分位数及样本数，同时在现场读取 CPU、重传、队列、丢包等指标；本工具不提供这些系统读数，也不自动执行 iperf 或改动 qdisc。DNS/TCP/TLS 的变化需要结合是否复用连接判断，低样本量的高分位数不能当作稳定结论。

结果默认只写标准输出；需要留存时重定向到仓库根目录被忽略的 `.local/reports/` 中，并先显式创建所需目录。该结果包含实际性能与运行记录，遵循本地资料边界，不提交到仓库、不随源码或发行包同步。

## 待完成的验收

当前主要缺口是冷启动／规则清空期间的连续阻断、开机启动与整机重启、持续负载，以及 x86-64 和新路由器组合；具体状态以发行说明为准。实体多终端仍须现场验收；跨网段及 IPv6 扩展前须先完善两端配置与故障模型。

源码同步与打包遵循 [AGENTS.md](../AGENTS.md)，排除本地资料、凭据、依赖和生成物，不跟随共享目录链接。
