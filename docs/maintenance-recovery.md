# 升级准备与中断检查

部署维护沿用显式 Linux root 安装边界。所有输入、发布目录和系统文件仍须通过所有权、权限、清单及内容哈希检查；这些命令不会创建账号、安装软件或改变主机配置。命令失败只输出稳定错误码，避免将私有配置或命令输出带入终端记录。

## 服务运行时准备升级

```sh
node --experimental-strip-types source/apps/deployment/main.ts \
  --operation prepare \
  --payload /root/release-payload \
  --input /root/private-upgrade.json \
  --manifest-sha256 <由独立可信渠道取得的清单哈希>
```

`prepare` 只读验证新旧发布、现有安装收据、受管文件、账号、工具、输入及目录。它允许现有服务和自动生命周期保持运行，不执行停止服务或网络资源移除。输出给出待写文件、配置变化路径、配置审阅摘要及正式实施的前置条件。`review.digest` 绑定新旧清单、当前受管私有配置哈希和新输入的完整字节；运维人员确认变更后，可将其交给 `upgrade --reviewed-configuration-sha256`。生成摘要本身不表示授权实施。

候选发布清单的 `compatibility.stateSchemas` 保留各类状态版本，并用 `contentReaders` 声明对应的完整内容 reader。当前明确的 reader ID 为 `cocoproxy.<store>.v1`，store 为 `transaction`、`lifecycle`、`trustedDevices`、`notifications`、`draft`、`workspace`、`siteProbes`、`automaticSelections`、`selection`、`subscription`；另有 `configurationReader: "deployment-v1"`、`candidateReader: "canonical-compiled-v1"`。这些字段由发行装配器从同一个源码契约写入清单，不另维护版本推断表。只有版本及完整 reader 声明吻合，并且当前数据通过同一运行 reader 的内容校验，才将该格式范围判为 `supported`。同版本但字段损坏为 `unsupported`；目标清单缺少或声明未知 reader 为 `unknown`，不能仅凭版本号相同推断兼容。

`prepare` 返回 `compatibilityAssessment.assessments`，逐项包含 `status`、固定 `code`、实际 `scope`、中文 `reason`、后续 `conditions`，以及独立的子项证据。`supported` 只覆盖写明的当次格式与声明，不代表服务加载、过期处理、真实网络、核心语法或未来写入已经通过。

| 评估项 | 实际读取和判定 | 必须保留的边界 |
| --- | --- | --- |
| `state` | 事务、生命周期、可信设备、通知、草稿、工作区、站点设置、自动选择、运行选择、订阅的完整记录；草稿及订阅摘要也复用原校验；订阅数量遵守原 Store 的 100 条及盘点余量限制 | 数据原地读取，不初始化 Store、不执行通知或过期清理；运行中快照仍须在实施前重读 |
| `configuration` | 目标部署计划、新旧运行设置、管理 origin 和核心部署选项复用原解析与编译；核对目标配置 reader 声明 | 保留配置变化审阅；不替代实际核心和反代运行验证 |
| `historyCandidates` | 枚举保留候选，校验规范字节、内容摘要、活动/目标/选择引用及目标设置下的运行重编译；核对目标候选 reader 声明 | 结果限定为候选格式；未运行目标核心的语法验证，不据此宣称核心可读 |
| `network` | 新旧静态网关绑定分别比较，可信回执的版本和 `complete` / `removed` / `incomplete` 状态单列 | 不验证回执完整 `resources`，不执行旧 helper，不证明实时内核归属或资源已清空；自动网关通常仍有 `unknown` 子项与停机核验条件 |
| `identity` | 已有管理员凭据内容、origin、服务 UID、凭据路径，以及可信设备与通知保存的身份指纹 | origin 或身份绑定变化导致的合法失效与内容损坏分开；需要重新登录和重新授权时明确提示 |

原 `stateCompatibility` 数组保留版本判断，并增加 `contentCompatibility`。`DEPLOYMENT_STATE_CONTENT_INVALID` / `DEPLOYMENT_STATE_JSON_INVALID` 表示已经读到坏内容；`DEPLOYMENT_STATE_CONTENT_READER_NOT_DECLARED` / `DEPLOYMENT_STATE_CONTENT_READER_UNKNOWN` 表示目标 reader 证据不足；`DEPLOYMENT_STATE_OBSERVATION_UNAVAILABLE` 表示可信读取不可用。报告不包含状态原文、候选内容、节点、订阅、管理员哈希、设备令牌或通知密钥。

旧 `readiness: "prepared-not-applied"` 只表示必须已查的状态完整格式、目标配置格式和历史候选格式可以继续进入维护准备；JSON 同时给出 `readinessScope: "required-static-formats-ready-for-maintenance-preparation"`。其中任一项不支持或未知，分别返回 `compatibility-unsupported` 或 `compatibility-evidence-incomplete`。完整五维结论仍由 `compatibilityAssessment.readiness` 和各项原因表达：动态网络未验不会被旧字段掩盖，也不会让正常的“运行中准备、随后停机退役”流程永久阻断。远程入口仍只接受其既有的配置未变化路径，不能将这个旧值翻译成全兼容或可立即实施。

状态目录和管理员凭据原地保留；设备令牌摘要、通知密钥、订阅、草稿及历史候选不会复制到准备输出或额外目录。管理 origin 或管理员凭据改变会按应用既有规则使设备信任和通知绑定失效，因此应单独审阅这类配置变化。合法绑定失效不标成状态损坏，旧设备和通知不能靠还原文件自动重新获得授权。

准备报告只评估升级到目标版本，不提供回退评估或自动回退；`automaticProgramRollback` 固定为 `false`。保留旧 release 不证明旧程序能读取升级后状态。实际回退前须重新核验当时的状态、配置、身份绑定、网络归属及所选核心语法，并显式执行维护流程；恢复普通直连还需从实际终端验证 DNS、直连和本地访问。

当前软件回归使用合成状态、缺失或未知的目标 reader 声明和由当前编译器生成的保留候选，验证上述升级判定及拒绝边界；它们不是某个旧发行版本升级、旧核心读取或实际程序回退的验收证据。

正式实施仍需明确授权，暂停自动生命周期，停止并禁用部署服务，清除既有网关网络资源，然后重新执行完整升级预检。安装器对已知坏完整内容返回 `INSTALL_STATE_CONTENT_UNSUPPORTED`，对不支持的版本返回 `INSTALL_STATE_SCHEMA_UNSUPPORTED`，对读取不足返回 `INSTALL_STATE_INSPECTION_UNAVAILABLE`，对缺少完整 reader 声明返回 `INSTALL_STATE_COMPATIBILITY_NOT_DECLARED`。历史候选格式不支持或未知分别使用 `INSTALL_HISTORY_CANDIDATE_UNSUPPORTED`、`INSTALL_HISTORY_COMPATIBILITY_NOT_DECLARED`；目标配置对应 `INSTALL_CONFIGURATION_FORMAT_UNSUPPORTED`、`INSTALL_CONFIGURATION_COMPATIBILITY_NOT_DECLARED`。取得安装锁后会重新检查状态内容；停服、归属及实时资源冲突的原严格检查继续保留。准备结果不能替代实施时的检查。

## 检查中断状态

```sh
node --experimental-strip-types source/apps/deployment/main.ts --operation inspect
```

检查输出列出收据状态、每个受管文件是否与收据相符、发布完整性、锁所属进程是否仍存在以及发现的安装临时文件。文件缺失、权限变化、哈希变化和旧格式锁会单独显示。该命令不会删除锁、删除临时文件、重复安装、修改收据或启停服务。损坏或缺失的收据不能提供可靠文件归属，输出要求人工审阅。

## 仅完成已经写好的安装

新安装器使用事务 ID、启动标识和进程开始时间记录安装锁。只在以下条件全部满足时允许 `recover`：收据与该锁属于同一安装或升级事务，原进程已经退出，全部预期文件与发布清单的字节和权限均正确，生命周期已暂停，所有受管服务停止且禁用，没有 unit 覆盖冲突。

```sh
node --experimental-strip-types source/apps/deployment/main.ts --operation recover
# 审阅上一步动作及 reviewedRecoverySha256 后，在明确授权范围内实施：
node --experimental-strip-types source/apps/deployment/main.ts \
  --operation recover --apply --reviewed-recovery-sha256 <上一步摘要>
```

已知首次安装事务允许管理员凭据尚未创建：此时恢复结果分别报告 `credential: "initialization-required"` 与 `administratorInitializationRequired: true`。收据恢复为完成后，按[初始化入口](setup-lifecycle.md)执行 `initialize`，再启动管理服务。恢复不会创建管理员，也不会把缺少凭据误报成可登录；状态目录或生命周期标记尚未创建仍沿用首次安装的正常语义。升级事务缺少原管理员凭据则返回 `INSTALL_RECOVERY_CREDENTIAL_REQUIRED`，不能借恢复重新初始化身份。已有凭据始终检查可信父路径、服务 UID、0600 权限及普通单链接文件约束。

恢复仅执行 systemd 配置重载、将该收据标为完成，并移除同一事务的遗留安装锁。它不会补写部分文件、恢复历史文件、改写状态、移除网络资源或重启服务。审阅摘要同时绑定凭据的存在状态及已有内容摘要；实施取得恢复锁后使用相同规则重检，存在状态或内容变化会拒绝沿用旧计划。进程身份、受管文件、发布完整性、生命周期及服务停止/禁用条件仍须通过检查；恢复再次中断时保留证据，要求人工处理。

旧 PID 锁、缺少事务标识的 pending 收据、部分写入、已变更文件、卸载中断和遗留恢复锁均不自动处理。单独删除锁后重试可能把混合版本当作正常安装；应先依据只读检查确认归属、已完成动作和待处理动作，再制定具体修复步骤。保留旧发布目录不等于已经验证旧程序可读取当前数据，故不提供通用程序回滚命令。
