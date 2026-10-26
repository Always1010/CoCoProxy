# MetaCubeXD overlay逐文件维护

本说明是源码维护资料，从[上游维护流程](upstream-maintenance.md)进入，不随运行载荷的离线导航扩展白名单。当前以[组件锁](../integrations/metacubexd/components.json)中的 MetaCubeXD **v1.273.1 / `8bbc8f58fef71148a94fb5c0ff808f79b057337d`** 为base；[完整原始树](../integrations/metacubexd/source-tree.json)共476个文件。下表以项目已提交基线 `ea91f38` 的66条路径为起点，并补充本次站点设置组件及配置回归测试，合计68条：**30个整文件替换、38个项目新增**。路径职责按当前实现记录；基线标识用于追溯集合，不表示后续功能已存在于旧提交。新增、删除或移动文件时须同步补齐本表并重新核对实际集合。

“替换”的完整base blob和模式来自该固定提交的source-tree；不是overlay自身摘要。“新增”指该固定树没有同名路径，base为无；新增文件可以承接上游其他文件的职责，因此不等于业务概念从未存在。表内“覆盖行为”描述当前文件接管的职责和结果，不声明已审阅尚未提供的新上游修复。更新上游时必须读取旧、新实际内容并记录决策，不能只看能否应用。当前没有新的目标提交或新树输入，**本表不是一次已完成的上游三方升级审阅**。

## 如何读测试列

以下标识是定位已有测试的简写，**不是本次执行记录或每文件全覆盖证明**。直接导入/脚本隔离执行、构建集成、后端间接保护分开；Vue脚本隔离或字符串断言均不等于真实页面运行。写“无直接测试”表示未定位到专门针对该文件的直接断言，不能用构建成功替代。

| 标识 | 真实测试与保护范围 | 不覆盖/执行前提 |
| --- | --- | --- |
| D-UTIL | [latency-batch.test.ts](../tests/latency-batch.test.ts)直接导入overlay的`latencyBatch`，断言去重key、补位、取消和代次 | 纯函数/异步调度，非页面或实际网络 |
| D-VM | [workspace-ui.test.ts](../tests/workspace-ui.test.ts)抽取`subscriptions.vue`、`AutomaticSelectionSettings.vue`脚本和`useWorkspace.ts`，转译后在注入API/响应式stub的VM执行 | 不挂载真实DOM，不证明焦点、CSS、触屏或浏览器布局 |
| D-BATCH | [useBatchLatencyTest.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useBatchLatencyTest.spec.ts)直接导入composable，mock store/API，测进度、补位、取消与每组URL | 需要已准备的上游Vue/Vitest环境；本轮未安装/执行 |
| D-WORKBENCH | [useProxyWorkbench.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useProxyWorkbench.spec.ts)用Vue effectScope/ref直接测组/scroll/方案隔离 | 非真实虚拟列表/DOM；同样需要上游测试环境 |
| D-TCP | [useTcpDelay.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useTcpDelay.spec.ts)mock API测去重、有效0、fingerprint变化与并发取消 | 非真实TCP或页面；需要上游测试环境 |
| D-BOARD | [useReachabilityBoard.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useReachabilityBoard.spec.ts)mock请求测许可、错误、进度、取消、过时结果与卸载 | 非真实站点/解锁验证；需要上游测试环境 |
| D-SITE | [useSiteProbes.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useSiteProbes.spec.ts)直接导入组展开/检测composable，mock settings/API/store，测断环、结果保留、代次与并发取消 | 不执行真实useSiteSettings、组件DOM或网络；需要上游测试环境；不能替代页面或网络验证 |
| I-SERVER | [management-server-live.test.ts](../tests/management-server-live.test.ts)对已构建Server断言SPA、control拒绝、config不含secret、HTTP/WS会话与Origin边界 | 要求Linux与显式`COCOPROXY_TEST_SERVER`；缺前提skip，不能称单测或systemd验收 |
| I-UI | 同文件的浏览器子测试：生成UI登录/退出、订阅、规则、方案/组/节点、错误、代理/TCP反馈、响应式导航与操作文字 | 还需现成Playwright/浏览器；部分API拦截为合成响应，非真实核心/目标网络；不能泛化覆盖所有组件 |
| I-NOTIFY | [notifications-browser-live.test.mjs](../tests/notifications-browser-live.test.mjs)真实生成UI/浏览器/Worker，模拟订阅provider和PushEvent，断言主动启停、去旧/过期、退出和无cache | 需显式UI/driver/browser输入；不是公网推送、系统锁屏或所有终端证书信任验收 |
| P-HTTP | [management.test.ts](../tests/management.test.ts)、[controller.test.ts](../tests/controller.test.ts)验证自有后端认证/Controller接口策略 | 间接保护依赖契约，不直接执行Nuxt/Nitro适配文件 |
| P-AUTO | [automatic-selector.test.ts](../tests/automatic-selector.test.ts)验证后端策略、调度、回切与预算 | 不执行自动设置组件或其DOM |
| P-TCP | [tcp-delay.test.ts](../tests/tcp-delay.test.ts)验证服务端TCP测量语义、取消与节点元数据 | 不执行overlay客户端/显示组件 |
| P-RULES | [rule-test.test.ts](../tests/rule-test.test.ts)验证后端规则匹配解释 | 不证明弹层定位、输入/取消和规则列表DOM |
| P-SITE | [site-probes.test.ts](../tests/site-probes.test.ts)验证后端站点配置持久化、方案隔离、revision与URL许可 | 不执行useSiteSettings或前端站点设置/结果组件 |
| D-SITE-SETTINGS | [useSiteSettings.spec.ts](../integrations/metacubexd/overlay/packages/ui/composables/__tests__/useSiteSettings.spec.ts)直接导入客户端，验证方案/响应隔离、保存范围和冲突恢复 | mock服务端；非持久化或DOM验证 |
| D-SITE-MODEL | [site-latency.spec.ts](../integrations/metacubexd/overlay/packages/ui/stores/__tests__/site-latency.spec.ts)直接导入真实store验证站点与基准历史隔离 | mock网络；非真实核心/浏览器端到端 |
| P-RELEASE | [release-stage.test.ts](../tests/release-stage.test.ts)含真实已构建trace闭包分支及合成装配保护 | 真实trace分支需显式构建输入，不能当Nitro配置所有选项单测 |

[metacubexd-overlay.test.ts](../tests/metacubexd-overlay.test.ts)只用合成文件验证blob、幂等、整批漂移拒绝、新增同名冲突及链接防护；不会逐个执行下列文件的产品行为。`source-tree`校验和[overlay应用工具](../scripts/apply-metacubexd-overlay.mjs)也不判断上游修复是否被整文件覆盖。

## 逐文件记录

路径相对overlay根。`100644`是当前全部替换base的模式；新增文件base明确为无。测试列通过上面的标识定位具体文件/场景；没有列出的行为不得推断已有保护。五项中任何一项发生变化，连同文件增删/移动、base归属和测试现实一起更新。

### Server集成、生命周期和路由

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `apps/server/lib/cocoproxy.ts`<br>新增；base无（固定上游树无此路径） | 避免在加载模块时启动核心或泄漏私有配置 | 惰性加载并缓存管理网关，失败后可重试 | 项目新增服务桥接，无上游同名base；统一503/no-store | 无直接单测；I-SERVER仅间接覆盖成功加载与Controller下游不可用；桥接加载失败/清缓存重试无直接测试 | 新上游同名库冲突、Nitro生命周期、失败缓存是否阻碍恢复 |
| `apps/server/lib/supervisor.ts`<br>替换；base `201c7a356bab2184ec061b34f4623730beebb48b`；模式 `100644` | 消除第二套Agent进程/配置所有者 | 调用getAgent固定抛LEGACY_AGENT_DISABLED | 整文件替换上游supervisor入口，拒绝Agent接管 | 无直接getAgent断言；I-SERVER只覆盖控制路由拒绝，不替代本函数 | 新入口是否另建supervisor，导出签名与直接写活跃配置的旁路 |
| `apps/server/middleware/auth.ts`<br>替换；base `04b0b1f602d08c07e209df65b3bb7c64ceca5967`；模式 `100644` | 不让旧control路径进入上游动作 | 对/api/control前缀返回404/no-store | 接管上游auth middleware的control拒绝分支，实际管理认证在自有网关 | 无隔离单测；I-SERVER验证control HTTP404 | 路径规范化/前缀与middleware顺序；HTTP不能代全局WS gate |
| `apps/server/nitro.config.ts`<br>替换；base `462f6a6e370fbe8af04a3f6dd9a777af3d50569f`；模式 `100644` | 让Server构建连接项目源码和完整推送依赖 | Node preset、私有源码alias、websocket、public资产及缓存头 | 替换上游Nitro构建配置，显式trace web-push并排除测试 | 无直接配置单测；I-SERVER/I-NOTIFY依赖构建结果；P-RELEASE核验闭包 | Nitro/h3/crossws升级、trace裁剪、public顺序、Worker头及单实例假设 |
| `apps/server/plugins/boot-kernel.ts`<br>替换；base `8e4fbf7e81f7c6d4b2392ee1dff3b3e539dfc93f`；模式 `100644` | 把生命周期还给systemd/自有事务并补全局upgrade保护 | 启动/关闭自有协调；所有WS升级先验路径和会话 | 替换上游启动核心插件，不调用原Agent；安装全局h3 websocket hooks | 无隔离单测；I-SERVER直接请求非clash/匿名/跨origin WS并断言拒绝 | h3 websocket缓存对象/crossws默认upgrade行为；不能只保留HTTP认证或路由局部hook |
| `apps/server/routes/[...].ts`<br>替换；base `474d284acf647fad124259c78e2c2d7180bab6ba`；模式 `100644` | 让hash/SPA页面回退不掩盖API或资源错误 | 只给GET/HEAD无扩展非API路径返回index.html | 接管上游catch-all，使用Nitro localFetch定位public | 无隔离单测；I-SERVER断言/cocoproxy HTML200 | 新上游route优先级、API/扩展名404、HEAD/方法处理和资源布局 |
| `apps/server/routes/api/[...].ts`<br>新增；base无（固定上游树无此路径） | 把自有API送入同一认证/事务网关 | Web Request转gateway.fetch，加载失败503 | 新增API兜底，无同名base；不是任意上游控制接口透传 | 无隔离单测；I-SERVER调用session/draft/stage接口 | 新上游API catch-all碰撞、h3 Request转换与异常/no-store边界 |
| `apps/server/routes/api/clash/[...].ts`<br>新增；base无（固定上游树无此路径） | 让Controller HTTP/只读流始终受同源会话控制 | 代理HTTP及WS relay，连接上限/背压/撤销/清理 | 新增受控clash挂载，secret仅服务端；客户端消息拒绝 | 无隔离适配器单测；I-SERVER验证HTTP/WS拒绝；P-HTTP验证底层会话/relay，非完整适配器压力测试 | peer.websocket/ws接口、open/close重复清理、128连接及2MiB背压、会话撤销 |
| `apps/server/routes/api/control/[...].ts`<br>替换；base `8edcf9326a4d89fa20fe5139f2d0df1567d3e0a0`；模式 `100644` | 封闭旧生命周期和直接写配置入口 | 固定404 LEGACY_AGENT_DISABLED/no-store | 整替换上游control catch-all，不提供原Agent操作 | 无隔离单测；I-SERVER请求kernel/start为404 | 上游新增更具体control路由可能抢先匹配，须检查全路由树 |
| `apps/server/routes/config.js.ts`<br>替换；base `45eb8609f3b145adc4bf3e757391641771ae20a5`；模式 `100644` | 阻止核心secret成为公共脚本 | 只返回冻结的空配置对象与no-store | 替换上游公共配置注入；静态public/config.js也可能优先 | 无隔离单测；I-SERVER断言最终/config.js不含secret，不能确定命中此动态文件 | 新上游静态脚本/运行时配置注入、缓存及路径优先级 |

### UI启动、认证和页面

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/middleware/auth.global.ts`<br>替换；base `835e331ca060369979164467fc42c36f2f3ed075`；模式 `100644` | 网页路由使用自有会话而非上游endpoint登录 | session读取与/login/overview/旧页面重定向 | 替换上游全局守卫，profiles转订阅，config/control转自有设置 | 无直接守卫单测；I-UI覆盖登录/退出重定向 | 新页面绕过守卫、读session失败、旧路径迁移、hash路由和SSR差异 |
| `packages/ui/nuxt.config.ts`<br>替换；base `acb09c2e312759521aae3b9d541a0fbec7179014`；模式 `100644` | 固定独立CSR/hash构建并关闭上游离线缓存 | 源码布局/构建目录、自有manifest引用、mock关闭/无远程字体 | 替换Nuxt配置；保留PWA选项但disable，不注册上游Workbox | 无直接配置单测；I-UI/I-NOTIFY依赖产物；I-NOTIFY断言cache为空 | Nuxt4 srcDir/auto-import、PWA disable是否仍生效、public重复manifest及远程构建输入 |
| `packages/ui/pages/cocoproxy.vue`<br>新增；base无（固定上游树无此路径） | 管理运行恢复、设备授权和通知入口 | 状态刷新、事务recover、设备撤销、退出、NotificationSettings | 新增自有设置页，替代旧control/config的落点 | 无隔离组件单测；I-UI访问/退出；I-NOTIFY经该页开启通知 | recover只能走自有事务，设备撤销当前会话、状态错误和通知条件独立 |
| `packages/ui/pages/login.vue`<br>新增；base无（固定上游树无此路径） | 提供本地管理员与可信设备登录 | 用户名/口令、trust选项及错误/等待状态 | 新增自有/login页，不恢复上游核心secret输入 | 无隔离组件单测；I-UI/I-NOTIFY输入登录并退出 | 登录字段/可信时长、提交防重、错误不泄密及触屏可见操作文字 |
| `packages/ui/pages/overview.vue`<br>替换；base `72fb22dc347f7f4e3b1488d5c0ace2f8344a7513`；模式 `100644` | 保留上游概览图表并衔接可失败的代理数据刷新 | 同源流量/内存/连接图、节点数据加载 | 整文件覆盖上游overview，使用useProxyRefresh而非把读失败吞作空数据 | 无针对图表的直接测试；I-UI路由/页面错误检查仅间接 | 上游图表修复/性能、watch卸载清理、重复时间点及核心离线显示 |
| `packages/ui/pages/proxies.vue`<br>替换；base `3f1b2447f0d217eb4f029ea2e0bf29ea7d5b62a2`；模式 `100644` | 将代理页接入本地/订阅工作区 | WorkspaceToolbar与NativeProxies统一加载 | 替换上游proxy页面入口为自有容器 | 无隔离组件单测；I-UI代理页/方案切换/离线反馈 | 全局/重复tab是否重现、工作区先加载、组件生命周期和错误呈现 |
| `packages/ui/pages/rules.vue`<br>替换；base `e484316b2f4249262845d806c6ae44da26ce84c0`；模式 `100644` | 把编辑与生效规则区分，保存走事务 | 自定义规则增删/排序/保存，NativeRules展示与RuleTestPopover | 替换上游规则页面入口，规则保存触发workspace.save | 无隔离组件单测；I-UI明确断言编辑/排序/保存与无额外Apply | dirty/revision切换、规则顺序、失败不误报生效、原生规则读取边界 |
| `packages/ui/pages/subscriptions.vue`<br>新增；base无（固定上游树无此路径） | 让来源编辑/切换/删除符合工作区与私密URL边界 | 读当前revision/URL，保存/下载分开，删除前选替代 | 新增自有订阅页，替代原profiles入口职责 | 直接D-VM订阅脚本；I-UI导入/切换/删除/移动按钮可见字 | 编辑过时请求、关闭清URL、当前来源不能删空、刷新失败与保存成功分开 |
| `packages/ui/plugins/cocoproxy.client.ts`<br>新增；base无（固定上游树无此路径） | 保证Controller endpoint固定同源且不存secret | Pinia就绪后写唯一/api/clash endpoint与空secret | 新增初始化插件，替代自由远端选择的运行前提 | 无直接插件单测；I-UI经同源API运行属间接覆盖 | 插件依赖顺序、新上游持久endpoint回填覆盖、跨origin或凭据重新注入 |
| `packages/ui/plugins/desktop-endpoint.client.ts`<br>替换；base `81300d3135e4c1b460ddebef3be91434b595ce43`；模式 `100644` | 阻止桌面桥接覆盖同源endpoint | 空插件保留模块入口 | 替换上游桌面endpoint同步逻辑为禁用 | 无直接测试；I-UI网页正常不证明所有Desktop桥接永不触发 | 新Desktop hook/IPC或插件改名导致旁路重新启用 |
| `packages/ui/plugins/desktop-sync.client.ts`<br>替换；base `9b8cc3162cca96c342b35f0df8b93513ceba43ab`；模式 `100644` | 不让Desktop同步改写当前网页状态/配置 | 空插件禁用桌面同步 | 替换上游Desktop同步插件 | 无直接测试 | 新同步插件名、启动自动导入或全局桥接路径 |

### 工作区、导航和基础组件

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/components/MobileBottomNav.vue`<br>替换；base `b3331c3e3394f7eec75251cf8d32b3605eca30e4`；模式 `100644` | 在触屏保留订阅/代理/规则主导航与更多项 | 响应式主/次导航及当前页重复点击事件 | 替换上游导航文件，调整路由分组和reselect分发 | 无隔离组件单测；I-UI在390px打开更多并检查connections/订阅入口 | 新增路由、hash判断、弹层关闭和触屏文字不退化纯图标 |
| `packages/ui/components/Modal.vue`<br>替换；base `f8750ae5d7a8be2a83861b2225b3e810a8f412d1`；模式 `100644` | 让弹层支持受控关闭、焦点及移动布局 | beforeClose、过渡计时、唯一标题ID、reduced-motion | 整替换上游通用Modal，服务组/检测等组合使用 | 无专门焦点/过渡单测；I-UI管理策略组弹层间接覆盖 | 上游dialog修复、esc/backdrop、焦点还原、异步close和卸载计时器 |
| `packages/ui/components/NativeProxies.vue`<br>新增；base无（固定上游树无此路径） | 统一代理页检测和设置范围 | 检测进度/取消、站点上下文与详情、代理设置三页签 | 项目代理页容器；移除全部组/全部TCP与独立站点板入口 | D-SITE仅调度；无持久化页面组件单测，需验证菜单/触屏布局 | 组切换归属、页面离开取消、设置保存范围、窄屏无溢出 |
| `packages/ui/components/NativeProxyMasterDetail.vue`<br>新增；base无（固定上游树无此路径） | 紧凑组工作台与统一操作范围 | 检测/定位/组设置，三类检测展开全部成员，筛选仅影响展示 | 保留上游分组节点浏览，移除重复检测按钮 | D-WORKBENCH保护浏览状态；D-SITE保护组展开；菜单DOM无持久化单测 | 隐藏嵌套组、筛选不改检测范围、自动算法标识、子按钮事件 |
| `packages/ui/components/NativeRules.vue`<br>新增；base无（固定上游树无此路径） | 把生效规则/来源查看与自定义编辑容器分工 | 规则/来源查询、筛选/排序/虚拟列表及支持的运行操作 | 新增文件承接原规则浏览职责；不是上游同名替换，不声称原逻辑全部重写 | 无直接组件行为测试；P-RULES只保护后端匹配，I-UI主要测外层自定义tab | 上游原规则页修复需人工对照；禁用/更新权限、generation及虚拟滚动结果变更 |
| `packages/ui/components/ProtectedResources.vue`<br>替换；base `7c17230885a8071a224fedfda8f272b18908662d`；模式 `100644` | WebSocket只随已认证会话保持 | session建立connect、退出disconnect、日志等级重连 | 替换上游保护资源激活条件，不从endpoint secret推断登录 | 无直接组件单测；I-UI退出、I-SERVER会话/WS属间接覆盖 | watch immediate、卸载清理、重连不能在注销后恢复，日志等级变化行为 |
| `packages/ui/components/ProxyNodeListItem.vue`<br>替换；base `aaf61e510ee28604ef81b72d7b27dd63d17cff70`；模式 `100644` | 紧凑节点行中区分站点与代理证据 | 站点摘要/色条、代理与TCP、选点与详情点击隔离 | 整替换上游节点行；组内用站点色条，提供者保留延迟历史条 | D-SITE-MODEL保护基准隔离；I-UI旧选点流程间接；新增摘要DOM需验证 | 行高、窄屏次要信息、键盘事件冒泡、popover清理 |
| `packages/ui/components/Sidebar.vue`<br>替换；base `5d5a237787670494531cafe915d5cd7218a4b6f9`；模式 `100644` | 桌面/抽屉导航指向项目任务入口 | 订阅/代理/规则/设置入口及切换关闭抽屉 | 整替换上游sidebar导航与路由分组 | 无隔离组件单测；I-UI宽屏/平板导航间接覆盖 | 新上游菜单和路由迁移、选中态/抽屉关闭、不要引回control/profiles编辑入口 |
| `packages/ui/components/WorkspaceGroupsMenu.vue`<br>新增；base无（固定上游树无此路径） | 提供本地模板组管理而不直接改核心 | 添加/移除自定义或目录组，保护默认/引用组 | 项目新增菜单，增删工作区选择后事务应用 | 无隔离组件单测；I-UI明确添加/移除Browser Custom | 默认/被规则引用的组保护、名字重复、自动选择配置随删组清理 |
| `packages/ui/components/WorkspaceToolbar.vue`<br>新增；base无（固定上游树无此路径） | 统一方案/运行模式/刷新和应用反馈 | 本地/订阅切换、DIRECT/global/rule、pending/dirty/错误重试 | 项目新增工具条；修改走workspace.save，刷新只读 | 无隔离组件单测；I-UI方案切换、保存失败及刷新可见文字 | 保存/生效不可混同，旧legacy不可新选，运行模式变更和触屏操作字 |

### 自动选择、检测和显示组件

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/components/AutoProbeSettings.vue`<br>新增；base无（固定上游树无此路径） | 在代理设置内维护共用自动选点检测参数 | 主/复核HTTPS、期望状态、超时/慢阈值，验证后保存 | 项目新增嵌入式设置；不再嵌套打开独立设置弹窗 | P-AUTO仅后端参数/调度间接；无直接组件单测 | 保持origin许可、冻结revision/active、验证失败不保存 |
| `packages/ui/components/AutomaticProxyNode.vue`<br>新增；base无（固定上游树无此路径） | 核心自动组也可读独立站点结果 | 无手动选点的紧凑行、TCP/基准/站点摘要 | 项目新增只读自动组节点行，不改核心算法 | D-SITE间接调度；无独立组件单测 | 不增加选点旁路、行高和groupName归属 |
| `packages/ui/components/AutomaticSelectionSettings.vue`<br>新增；base无（固定上游树无此路径） | 统一当前组的节点选择和站点选择设置 | 节点选择/站点连通页签；优选/备选/回切和组内目标 | 项目组设置弹层；非手动组仍保留核心算法 | D-VM保护自动策略保存/重开；P-SITE保护站点写入；无完整DOM单测 | 组/方案切换关闭、偏好保留、轮询与可见页签、两类保存互不混用 |
| `packages/ui/components/ConnectionErrorBanner.vue`<br>替换；base `b3357ac477955be617c5d7b6530f6c04d5ef89c7`；模式 `100644` | 核心读失败可观察且可重试 | 已登录非设置页显示错误，重试version及代理刷新 | 整替换上游连接错误条，不因读失败清空既有节点 | 无隔离组件单测；I-UI核心不可用文字 | session/route门槛、重试并发/动画、页面不是核心ready证明 |
| `packages/ui/components/ConnectivityBoard.vue`<br>替换；base `f22a8a6a85a830e5ee46d0b64b993a6cea9dfcea`；模式 `100644` | 站点检测按指定对象和许可给证据 | 节点/类别切换失效、允许项检测、进度/取消/目标域名 | 替换上游站点板，不用直连浏览器fetch伪装节点路径 | 无直接组件测试；D-BOARD测底层；未覆盖完整板DOM | 当前对象/allowedOrigins变动清证据，未许可项不发送，解锁说明不能当业务保证 |
| `packages/ui/components/Latency.vue`<br>替换；base `613b37b6e8c50c2f0fa9a1ebb4c1c69fe5efedfb`；模式 `100644` | 让代理时延有明确状态而非只显示数值 | testing/denied/timeout反馈、历史时延、可交互a11y标签 | 整替换上游时延显示，与TCP结果分开 | 无隔离组件单测；I-UI实际断言未启用/88ms/超时；D-BATCH测底层进度 | 0/失败数值语义、旧缓存与当前失败区分、检测动作名称/键盘反馈 |
| `packages/ui/components/LatencyCard.vue`<br>替换；base `08becb959f0a08bc6de1dbf9b50dc83b3171b11b`；模式 `100644` | 保留概览中浏览器到后台的延迟语义 | useLatencyTest结果、平均与进度和重试 | 整替换上游延迟卡，明确是浏览器链路耗时，非节点代理速度 | 无直接组件测试；I-UI概览访问只间接，不证明数值语义 | onMounted检测与卸载、浏览器路径和代理路径命名、失败/0/平均算法 |
| `packages/ui/components/RuleTestPopover.vue`<br>新增；base无（固定上游树无此路径） | 解释当前生效规则匹配，不另起真实目标访问 | 目标/协议/源目端口输入、取消、active绑定、策略结果 | 项目新增规则匹配弹层；通过rules/test API读取当前证据 | 无直接组件测试；P-RULES验证后端匹配，非DOM交互 | Popover定位/滚动/关闭、过时active响应、复杂规则不可确定时准确说明 |
| `packages/ui/components/TcpLatency.vue`<br>新增；base无（固定上游树无此路径） | 区分TCP建连耗时和代理访问 | 展示零值/不可用/取消/失败及独立重测 | 项目新增TCP显示，复用useTcpDelay，不等同认证/业务可用 | 无直接组件单测；I-UI断言TCP12ms；D-TCP只测composable | 合法0、fingerprint失效、tooltip不能代操作文字、与代理延迟分列 |

| `packages/ui/components/SiteResultBadge.vue`<br>新增；base无（固定上游树无此路径） | 在原有行高中展示站点覆盖 | 稳定顺序小段、可达计数与未完成状态、点击详情 | 项目新增紧凑摘要，不把红色慢延迟当作站点失败 | D-SITE间接结果；无持久化组件DOM单测 | 嵌套组实际出口、灰/黄语义、触屏点击不选点 |
| `packages/ui/components/SiteProbeDetails.vue`<br>新增；base无（固定上游树无此路径） | 让触屏可查看完整检测证据 | 站点名称/耗时/状态/时间、单节点重测、代理历史 | 项目新增Modal内容，窄屏底部呈现，不撑高列表 | D-SITE保护单节点重测；D-SITE-MODEL保护代理历史；无直接DOM单测 | 节点时间不被别的节点重测更新、忙状态与目标失效、成功非解锁 |
| `packages/ui/components/SiteTargetSettings.vue`<br>新增；base无（固定上游树无此路径） | 统一目录管理与当前组多选 | 分类/搜索、添加/删除、最多16项、保存/冲突反馈 | 项目新增设置组件，共用于代理目录页与组设置 | P-SITE保护服务端持久化/冲突/许可；无直接持久化组件单测 | 受限已选项可取消、跨方案响应、目录引用不能静默删除 |

### UI请求、状态和检测逻辑

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/composables/useApi.ts`<br>替换；base `cd5d00a724b804d8d29fc7b920c89020eedbb741`；模式 `100644` | 把上游大量API调用收口到同源受控Controller | 去Authorization、代次If-Match、401清会话、探测固定错误分类 | 整替换上游API封装；选节点委托workspace；保留mock辅助但Nuxt默认关闭 | 无完整封装直接单测；I-UI代理探测错误/选取；P-HTTP服务端策略间接 | 新上游方法/endpoint、ky hooks签名、URL逃逸、重试/timeout和非GET写入许可 |
| `packages/ui/composables/useBatchLatencyTest.ts`<br>替换；base `9d6911d3ed94877564cf5a14a351013ba4e349ad`；模式 `100644` | 批量代理检测有取消、并发与代次隔离 | 节点/组URL去重、队列进度/当前对象/失败汇总 | 整替换上游批测composable，复用latencyBatch和自有feedback | 直接D-BATCH mock store/API测进度/取消/组URL；I-UI当前组探测 | session/generation变化取消、晚结果、分组URL、吞吐补位及检测不切节点 |
| `packages/ui/composables/useCoCoProxy.ts`<br>新增；base无（固定上游树无此路径） | 所有自有API共享会话/代次和错误清理 | same-origin/no-store请求、login/trust/logout、清理通知与workspace | 项目新增API/状态底座，不在浏览器暴露核心secret | 无隔离composable单测；I-UI/I-NOTIFY认证/退出集成；P-HTTP底层间接 | 401/403/409含义、注销本地状态/Worker、响应generation和trust选择 |
| `packages/ui/composables/useLatencyFeedback.ts`<br>新增；base无（固定上游树无此路径） | 用结构状态表达代理检测失败而非模糊数值 | node反馈、批次summary、probe_denied/timeout/failed中文短名 | 项目新增反馈状态与错误分类，兼容既有delay值展示 | 无独立直接测试；D-BATCH通过导入/调用间接涉及，I-UI断言显示 | 状态key是否共享错误对象、重复检测/取消清理、旧正值不掩盖当前失败 |
| `packages/ui/composables/useProxyRefresh.ts`<br>新增；base无（固定上游树无此路径） | 后台读失败保留节点并让错误可见 | 包装fetchProxies，独立错误useState、成功清错 | 项目新增刷新包装，调用方不会把读取失败当空列表 | 无直接composable测试；I-UI核心错误条间接覆盖 | 新store失败行为、并发刷新、旧数据保留与错误回收 |
| `packages/ui/composables/useProxyWorkbench.ts`<br>新增；base无（固定上游树无此路径） | 保存浏览组和滚动，不随核心代次乱重置 | 按scheme scope持久化group/scroll，组消失才回退 | 项目新增浏览上下文，状态不属于配置选择 | 直接D-WORKBENCH模拟vue/effectScope；I-UI方案返回组 | 上游resolveActiveGroup变更、scope键碰撞、重挂载/刷新不丢组 |
| `packages/ui/composables/useReachabilityBoard.ts`<br>替换；base `273cbffa465d6667ebe3a5cff2ddc5ab4e1b4d02`；模式 `100644` | 站点证据绑定节点/代次/会话和许可 | 默认目标、逐站状态/进度、超时/繁忙/拒绝、取消晚回包 | 整替换上游站点探测，经过受控Controller节点delay接口 | 直接D-BOARD mock请求测拒绝/错误/取消/代次/卸载；无真实业务解锁证明 | allowedOrigins、finite positive delay、换对象清证据、同名目标/URL及状态分类 |
| `packages/ui/composables/useSiteSettings.ts`<br>新增；base无（固定上游树无此路径） | 按方案保存站点目标并防旧请求覆盖 | 目录/组选择、revision+workspaceRevision+scope、会话与来源隔离 | 项目新增客户端；保存检测偏好不应用路由 | D-SITE-SETTINGS直接验证旧读取、来源切换与冲突恢复；P-SITE保护服务端 | 同来源模式切换、单调revision、默认目标、保存不修改业务配置 |
| `packages/ui/composables/useSiteProbes.ts`<br>新增；base无（固定上游树无此路径） | 按节点和站点隔离检测证据 | 嵌套断环/去重、10并发、取消、逐节点时间、配置失效 | 项目新增多站点调度；站点摘要替代旧独立站点板入口 | D-SITE直接保护展开/结果/取消；D-SITE-MODEL保护基准不回退到站点 | 迟到结果、scope/目标/节点/generation绑定、不得改选取或推荐 |
| `packages/ui/composables/useTcpDelay.ts`<br>新增；base无（固定上游树无此路径） | TCP结果绑定实际节点内容并限制批量 | fingerprint去重/有效0、10并发、取消/代次失效 | 项目新增TCP测量客户端，不复用HTTP代理时延缓存 | 直接D-TCP mock API/时间测0、重复、修改、并发取消；P-TCP服务端间接 | 节点编辑/active变动、请求/取消竞态、结果不得冒充代理认证成功 |
| `packages/ui/composables/useWebSocket.ts`<br>替换；base `38ab6dda34cc4d7418c1ee1921ae7f15a5168c64`；模式 `100644` | 同源会话流无query token/secret | traffic/memory/connections/logs串流、断线退避、注销/卸载清理 | 整替换上游WS连接封装，以浏览器Cookie而非endpoint凭据 | 无直接composable测试；I-SERVER只测服务端gate，I-UI退出属间接 | URL参数、重连timer/session race、旧事件回调、日志重连不能跨会话 |
| `packages/ui/composables/useWorkspace.ts`<br>新增；base无（固定上游树无此路径） | 保存、应用、读回与手动选取走单事务路线 | revision/expectedActive、busy/operation/pending、选择确认后反馈 | 项目新增工作区composable，禁止仅保存就显示已生效 | 直接D-VM手动接管脚本；I-UI保存/失败/不确定/选择反馈 | 失效revision、apply响应丢失、只有读回确认才成功；local/subscription/legacy隔离 |

### 直接测试文件、store和纯工具

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/composables/__tests__/useBatchLatencyTest.spec.ts`<br>替换；base `a2d2999b3add798e99696aa9b434e877b2228e3e`；模式 `100644` | 保留批测反馈/取消回归 | D-BATCH测试载体 | 替换上游同名测试以适应CoCoProxy mock依赖 | 本文件即直接断言载体；非页面运行，不另设镜像测试 | 依赖mock与真实返回schema漂移，测试漏测边界需明示 |
| `packages/ui/composables/__tests__/useProxyWorkbench.spec.ts`<br>新增；base无（固定上游树无此路径） | 防止刷新/重挂载丢浏览上下文 | D-WORKBENCH测试载体 | 项目新增测试文件，无上游base | 本文件直接断言group/scroll/scheme；不测试虚拟列表DOM | watch/effectScope时序、组不存在回退与持久key隔离 |
| `packages/ui/composables/__tests__/useReachabilityBoard.spec.ts`<br>替换；base `c9a4d6b3b9d6c679e79183d2b38fa1bfc4ee8d96`；模式 `100644` | 防站点检测伪成功和过时证据 | D-BOARD测试载体 | 替换上游同名测试，适应自有许可与会话 | 本文件直接mock请求断言拒绝/timeout/busy/晚结果；非站点实测 | mock不能跳过生产许可/代次规则，新增状态要有相应断言 |
| `packages/ui/composables/__tests__/useSiteProbes.spec.ts`<br>新增；base无（固定上游树无此路径） | 防按组多站点检测改变业务状态或保留过时结果 | D-SITE测试载体 | 项目新增mock测试，无上游base | 本文件直接导入useSiteProbes/siteGroupMembers；mock useSiteSettings/API/store，非真实页面或网络 | mock数据和生产scope/target schema同步；分清当前单目标用例与尚未覆盖的多目标/失败组合 |
| `packages/ui/composables/__tests__/useTcpDelay.spec.ts`<br>新增；base无（固定上游树无此路径） | 防TCP重复/零值/取消/并发回归 | D-TCP测试载体 | 项目新增测试文件，无上游base | 本文件直接mock API断言；非真实TCP测量或DOM | fingerprint/API schema变化、取消时所有testing项是否清空 |
| `packages/ui/stores/proxies.ts`<br>替换；base `c698e4176dd63c3ff08f7ef9fa36ae0c070ecf7b`；模式 `100644` | 统一节点读模型并隔离不同检测证据 | fetch/解析/选择委托、基准与历史回退排除站点专属记录 | 整替换上游store，选择仍经useWorkspace；不把站点历史重新标作基准 | D-SITE-MODEL直接保护真实store的基准/历史回退；D-BATCH仍mock store | 上游extra/history变化、无per-URL历史时保留基准、并发读取与选择事务 |
| `packages/ui/utils/latencyBatch.ts`<br>新增；base无（固定上游树无此路径） | 为HTTPS批测提供有限并发和同轮去重 | key含generation/identity/name/url/timeout，动态补位 | 项目新增纯工具，无同名base | 直接D-UTIL导入实际函数测身份/URL隔离、并发补位、取消和generation失效 | 新去重维度、跨代复用、同步抛错/取消及并发上限10 |

| `packages/ui/stores/__tests__/site-latency.spec.ts`<br>新增；base无（固定上游树无此路径） | 防站点检测污染基准延迟和历史 | 直接导入真实proxies store，模拟核心extra和通用history | 项目新增回归测试，无上游同名base | D-SITE-MODEL测试载体；mock网络而不mock被测store | 请求URL精确优先、站点成功不填充失败基准、无extra回退 |

| `packages/ui/composables/__tests__/useSiteSettings.spec.ts`<br>新增；base无（固定上游树无此路径） | 防止旧响应或旧方案污染当前站点偏好 | 真实客户端读写与scope/revision冲突回归 | 项目新增测试，无上游同名base | D-SITE-SETTINGS测试载体；仅mock服务端请求 | 迟到GET不能回退revision、来源切换清理、保存仅写检测设置、失败释放pending |

### 通知与安装资产

| 路径、归属与完整base blob | 为什么存在 | 对应自有能力 | 覆盖或承接的上游行为 | 真实保护测试/明确缺口 | 上游更新重点 |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/components/NotificationSettings.vue`<br>新增；base无（固定上游树无此路径） | 每设备主动开启/关闭及可核对测试结果 | 偏好/组范围、历史与发送状态、测试排队提示 | 项目新增通知设置，不把accepted标系统已显示 | 无隔离组件单测；I-NOTIFY真实生成UI/Worker结合合成provider事件 | 关闭不撤销管理信任、测试提示、设备条件/状态错误与隐私显示 |
| `packages/ui/composables/useNotifications.ts`<br>新增；base无（固定上游树无此路径） | 将通知能力、权限和订阅管理限制到主动动作 | secureContext/PWA/Push条件、register、同key订阅、偏好/测试 | 项目新增通知客户端，非自动注册所有设备 | 无隔离composable单测；I-NOTIFY主动开启/关闭/注销集成 | iOS安装条件、applicationServerKey比较、registration复用、权限拒绝/重订阅 |
| `packages/ui/public/cocoproxy-sw.js`<br>新增；base无（固定上游树无此路径） | 只处理通知，不缓存应用或API | PushEvent过期/去旧、IndexedDB持久禁用标记、同源点击/更新订阅 | 项目新增notification-only Worker，无fetch/app-shell缓存 | I-NOTIFY执行真实Worker并注入合成PushEvent，断言去旧/过期/关闭/无cache；不是公网Push或锁屏实测 | 事件负载/数据上限、固定同源落点、关闭清订阅、不要引入fetch缓存/远程脚本 |
| `packages/ui/public/manifest.webmanifest`<br>新增；base无（固定上游树无此路径） | 提供自有站点安装身份与通知所需入口 | CoCoProxy名称、hash起始页、scope/图标引用 | 项目新增静态清单，Nuxt生成的上游manifest已disable | 无直接字段单测；I-NOTIFY依赖清单/安装条件；现有发行核验仅确认实际文件存在 | scope/start_url、图标路径、与生成清单冲突、安装能力不等于信任或推送显示 |

## 人工旧上游 / 新上游 / 当前overlay比较

这是一条只读审阅路线，**不自动合并、不安装依赖、不构建或操作设备**。从尚未修改组件锁/source-tree的项目提交开始；已有本地上游Git对象库必须可信并含两个完整提交。没有新输入时记录“未提供/未执行”，不得随意把latest、旧版本或overlay本身当新上游。

### 1. 固定并校验三份输入

在项目源码根的POSIX shell运行，路径为角色占位符：

```sh
UPSTREAM_GIT=/absolute/reviewed/metacubexd-git
OLD_COMMIT=8bbc8f58fef71148a94fb5c0ff808f79b057337d
NEW_COMMIT='<审阅确定的40位新上游提交>'
OLD_CATALOG="$PWD/integrations/metacubexd/components.json"
OLD_MANIFEST="$PWD/integrations/metacubexd/source-tree.json"
NEW_MANIFEST=/absolute/reviewed/new-source-tree.json
OVERLAY="$PWD/integrations/metacubexd/overlay"
```

先确认项目源码提交与工作区状态，记录`git rev-parse HEAD`、组件锁版本/提交及overlay修改；未提交overlay变化须单独审阅，不套用旧项目提交的结论。更新过组件锁后重做旧版审阅时，显式取原项目提交中的旧catalog和旧manifest，分别设置OLD_CATALOG/OLD_MANIFEST指向该组输入，不能把已更新文件当旧输入；来源及摘要写进审阅记录。

以下片段同时验证旧manifest与指定OLD_CATALOG/旧提交关系，以及两个manifest与实际Git树的**精确路径、mode、blob集合**。它不fetch或checkout，不执行上游代码；新manifest须是预先取得的完整树，而非只列overlay文件。

```sh
python3 - "$UPSTREAM_GIT" "$OLD_COMMIT" "$NEW_COMMIT" "$OLD_CATALOG" "$OLD_MANIFEST" "$NEW_MANIFEST" <<'PY'
import json, re, subprocess, sys
from pathlib import Path
repo, old, new, old_catalog, old_manifest, new_manifest = sys.argv[1:]
catalog = json.loads(Path(old_catalog).read_text())
assert catalog['management']['commit'] == old, 'old catalog/commit mismatch'
for target, filename in [(old, old_manifest), (new, new_manifest)]:
    assert re.fullmatch('[0-9a-f]{40}', target), 'full commit required'
    manifest = json.loads(Path(filename).read_text())
    assert manifest['commit'] == target and manifest['truncated'] is False
    resolved = subprocess.check_output(['git', '-C', repo, 'rev-parse', target + '^{commit}'], text=True).strip()
    assert resolved == target, 'commit object mismatch'
    actual = {}
    tree = subprocess.check_output(['git', '-C', repo, 'ls-tree', '-rz', '--full-tree', target])
    for entry in tree.split(b'\0'):
        if not entry: continue
        meta, path = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        assert kind == 'blob' and mode in ['100644', '100755', '120000']
        actual[path.decode('utf-8')] = (mode, oid)
    expected = {item['path']: (item['mode'], item['sha']) for item in manifest['files']}
    assert len(expected) == len(manifest['files']) and actual == expected, 'tree/manifest mismatch'
    print(target, len(actual), 'exact tree verified')
PY
```

若使用解压后的干净源码，另按[集成说明](../integrations/metacubexd/README.md#准备与构建)在安装依赖前用`verify-git-tree.mjs`验证实际目录；“manifest自己写了commit”本身不能证明来源身份。Git对象库身份/下载来源仍须审阅，不能用上述一致性检查替代来源信任。

### 2. 先看全树变化，再逐个覆盖文件比较

```sh
git -C "$UPSTREAM_GIT" diff --find-renames --name-status "$OLD_COMMIT" "$NEW_COMMIT"
git -C "$UPSTREAM_GIT" diff --find-renames "$OLD_COMMIT" "$NEW_COMMIT" -- apps/server packages/ui
```

第一条找新增、删除和重命名，包括当前overlay没有覆盖的新路由/插件/构建hook；不能只比较本表已有同名路径而漏掉新的生命周期或认证旁路。重命名是Git相似度线索，须人工确认职责转移。对每个路径核对本表旧base与旧manifest一致，再读取旧/新blob与当前overlay；例如选择本表已有的路径：

```sh
FILE=apps/server/plugins/boot-kernel.ts
git -C "$UPSTREAM_GIT" rev-parse "$OLD_COMMIT:$FILE"
git -C "$UPSTREAM_GIT" cat-file -e "$NEW_COMMIT:$FILE"
git -C "$UPSTREAM_GIT" show "$OLD_COMMIT:$FILE"
git -C "$UPSTREAM_GIT" show "$NEW_COMMIT:$FILE"
```

逐项决策：

1. **旧base与新上游**：阅读完整diff，列上游修复、接口/依赖变化、安全边界和配置迁移，不能以“无文本冲突”跳过。
2. **旧base与当前overlay**：列当前覆盖理由与自有改动；读取完整overlay文件，确认本表五项与实现/测试仍相符。
3. **新上游与当前overlay**：逐个判断上游修复是否已保留、需手工移植、与自有边界冲突或可撤销覆盖；记录理由与验证计划。需要导出blob作`git diff --no-index`时，仅写操作者指定的私有审阅目录，差异退出1属正常，其他错误须处理。

`cat-file -e`不存在不等于“可以继续照旧覆盖”：

- 旧替换文件被新上游删除/改名：从全树diff确定新职责位置；记录保留为自有新增、跟随迁移或撤销覆盖的决定，再调整归属/base。不得把缺文件错误当通过。
- 原项目新增文件在新上游同名出现：视为所有权冲突；完整比较双方职责，明确改名、合并、采用上游或继续替换，并为新的替换记录新base。即使字节恰相同也记录归属变化。
- 旧上游本就没有的自有新增：无须伪造旧base，比较其依赖/调用接口与新同名冲突；原有自有职责仍须维护。
- 新上游的新增入口在overlay之外：检查middleware、route优先级、全局WS gate、Agent启动、配置写入、Desktop同步、PWA/静态config注入，决定是否增加覆盖；新增覆盖也须补本表五项。

旧/新某输入不可读、blob与manifest不符、重命名职责不清或来源不可信时停止该项审阅；不要跳过、用空文件占位或套用历史“已验证”。

### 3. 审阅记录模板与完成条件

下面是**空模板，不是当前已执行记录**。每次上游更新按路径填表；不含真实配置、网络参数或个人目录。原始完整diff/命令输出保留操作者私有审阅位置，正式说明只保留必要脱敏结论。

```text
审阅状态：待输入 / 进行中 / 已审阅待验证 / 已验证（注明范围）
项目提交与overlay状态：<项目commit；是否有未提交变化；overlay树/内容摘要>
旧上游：<tag/commit；catalog/manifest摘要；完整Git树验证结果>
新上游：<tag/commit；manifest摘要；完整Git树验证结果或未提供>
路径与归属：<旧路径 → 新路径；新增/替换/删除；old/new base blob与mode或无>
存在原因与自有能力：<对应能力/约束>
旧base→新上游：<修复/行为/API/依赖变化>
旧base→overlay：<自有覆盖及理由>
新上游→overlay：<被遮住的修复；已保留/待移植/不采用及理由>
新同名/重命名/删除/新入口检查：<结果或阻断原因>
决策与产物：<保留/手工移植/改名/转新增/撤销；相关文件>
保护与验收：<真实测试文件/具体断言；直接/集成/间接/无直接测试>
执行结果：<命令/所用输入提交；pass/fail/skip/not-run；产物/证据范围>
未验证项与后续：<目标systemd/实际终端/网络等不能据本次推断的事项>
审阅日期与复核：<日期/复核结论>
```

完整升级仍按[上游维护流程](upstream-maintenance.md#2-metacubexd-源码与-overlay)顺序处理：先比原始树，后在已获授权且具备现成依赖的目录应用和检查。`apply-metacubexd-overlay.mjs`默认只接受当前组件锁提交对应的manifest；不要把新的manifest直接塞给旧工具或强制绕过校验。审阅决定确认后，在同一目的的提交中更新catalog、review、source-tree、必要overlay与本表；先验证新原始树，再进行获授权的构建/运行检查。软件/页面/平台证据逐项记实际范围，新核心/新组合不能继承旧运行结论。

## 本清单的静态复核

每次增删/移动overlay后，从实际目录重新枚举文件，与表中路径精确集合对比；根据固定source-tree逐条验证新增/替换归属、完整blob和mode；确认五项非空且引用的测试文件真实存在。对没有直接测试的项保留缺口，不靠创建同实现的镜像测试填满。源码维护文档之间的本地链接须可解析；运行包仍按原显式白名单/离线闭包检查，不因文档引用自动带入源码维护资料。
