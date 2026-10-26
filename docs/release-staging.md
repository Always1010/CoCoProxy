# 发行载荷装配

`scripts/stage-explicit-release.mjs` 将固定 HEAD 源码、已构建 Server/UI、运行依赖和审核 Mihomo 组合为新目录，支持显式及原生网关后续安装。脚本名称保留兼容；装配不安装依赖、构建上游、操作服务或改变网络。后续流程见[部署与维护](deployment.md)。

## GitHub Actions 发布

[Release 工作流](../.github/workflows/release.yml) 在推送 `v<package.json 版本>` 的 Tag 时运行，例如首版 `v0.1.0-preview.1`。Tag 必须符合 SemVer，且与根 package.json、package-lock.json 版本一致；带预发布后缀的版本自动标记为 GitHub Pre-release。

GitHub 托管的 Ubuntu Runner 按锁安装构建依赖，执行类型、上游源码校验、overlay、发行元数据、离线文档、安装配置、发行装配及部署测试；随后核验固定上游源码与锁文件、构建 UI/Server，并复用现有装配器生成 ARM64 和 x86-64 载荷。构建入口为 `scripts/build-github-release.mjs`，完整构建只允许在 Actions Linux 环境执行。两个平台均不在构建中执行外来 Mihomo；构建成功不替代目标设备验收。

固定输入以[组件清单](../integrations/metacubexd/components.json)为准，包括上游 tag、commit、源码及锁摘要、包管理器、两种平台的资产名、下载地址、压缩包摘要与核心摘要；[审核记录](../integrations/metacubexd/review.json)另存实际验证范围。构建和装配拒绝清单与审核、完整源码树之间的身份或摘要分歧，构建还要求 tooling 的包管理器版本与其锁一致。更新验证结论不会自动更改组件版本，下载入口也不查询 latest。

全部检查成功后，独立发布任务用内置 `GITHUB_TOKEN` 的 `contents: write` 权限创建 Release，无须额外 PAT 或 SSH 密钥。构建任务只有仓库读取权限。发布附件包括两种架构的 `.tar.gz` 安装包、各自的 `.manifest.json`、CoCoProxy/MetaCubeXD/Mihomo 对应源码压缩包、`SOURCES.txt`、`RELEASE-NOTES.md` 和 `SHA256SUMS`。安装包由装配白名单生成，源码包使用 `git archive HEAD`，均不纳入 `.local/` 或跟随本地共享链接。

后续发布先更新根包和锁文件版本及发行说明，提交并推送目标分支，再创建并推送对应 Tag：

```sh
git tag -a v0.1.0-preview.1 -m 'CoCoProxy 0.1.0-preview.1'
git push origin refs/tags/v0.1.0-preview.1
```

上例版本仅用于首次发布；后续使用新版本号。不移动已经发布的 Tag，也不覆盖既有 Release。失败时查看 Actions 日志，临时下载故障可重跑失败任务；需要修正源码时应提交修复并发布新版本。

下载后先按可信 Release 的 `SHA256SUMS` 核对附件，再解压所选架构安装包。校验对应 `.manifest.json` 与包内 `manifest.json` 一致，其 SHA-256 即安装入口需要的 `manifestSha256`；继续按部署说明核验文件集和安装前置条件。

## 输入与布局

```sh
node scripts/stage-explicit-release.mjs \
  --source-dir /absolute/source/cocoproxy \
  --server-dir /absolute/build/metacubexd/apps/server/.output \
  --runtime-dependencies /absolute/source/cocoproxy/node_modules \
  --core /absolute/reviewed/mihomo \
  --output /absolute/private/staging/release
```

五个路径须规范、绝对、无符号链接或 Windows 联接，Windows短路径先转换真实路径。输出父目录已存在且可信，输出不得存在或位于任一输入内。装配期间输入与目录由单一可信操作者保持稳定；普通文件API不防御恶意并发目录替换。

```text
source/
  apps/、packages/              # HEAD运行源码与模块参考
  docs/、examples/              # 白名单中的部署、使用及来源说明
  package.json、package-lock.json
  scripts/cocoproxy-setup.sh    # 安装配置与诊断入口
  node_modules/                # 完整生产依赖
  integrations/metacubexd/      # 来源、review、LICENSE
  integrations/mihomo/LICENSE
server/.output/{server,public}/
bin/mihomo
README.md                     # 解压后的离线导航
cocoproxy                     # 相对自身目录定位的命令入口
manifest.json
```

解压后从根 `README.md` 或 `./cocoproxy help` 开始，入口按自身位置查找源码，不要求当前目录等于载荷目录。[安装配置与诊断](setup.md)说明 doctor、configure 和后续安装入口；`source/docs/getting-started.md` 提供[从零部署与使用总指南](getting-started.md)。相对链接引用的使用说明、模块说明、图像和合成样本均随载荷保留，可离线阅读。指向上游及源码专用维护说明的 HTTPS 链接仍需联网。

在目标 Linux 上直接更新已有安装可运行 `sudo ./cocoproxy deploy --local`，从另一台电脑更新则运行 `./cocoproxy deploy <IP>`。首次安装输入与预览方式见[本机与远程部署更新](deployment.md)。本地入口直接复用安装协调器，无需 SSH 连接本机。

源码必须是干净 Git 工作树根，拒绝受跟踪修改和未忽略的新文件；固定启动HEAD，以 Git blob 读取并在完成前复核。symlink/gitlink 拒绝，不执行 Git hooks 或构建代码。

选择 apps/packages 运行源码、根包元数据及存在的 LICENSE/NOTICE、明确的运维文档／样本与来源记录，以及安装配置和部署维护入口。可信部署选项说明 `examples/deployment-options.md` 随载荷提供。规则数据、旧候选兼容数据及许可随运行源码保留，规则生成器留在源码仓库。开发约定、发布 workflow、开发／构建／压测说明、协议夹具与构建 README、时延测量工具不进入运行包；运维文档需要的开发参考链接到官方源码仓库。排除 .local、.git、缓存、测试与协议对端；不遍历本地共享链接。受跟踪源码含任意 `.local` 路径时，源码归档和装配都拒绝。

装配在固定白名单内验证所有 Markdown 的本地链接、图片、引用式链接和 HTML src/href 目标；缺失、越界或不安全目标均拒绝并清理本次暂存。检查不按文档链接自动扩大白名单，也不验证远程地址或 Markdown 页内锚点。CI 的 `npm run test:release-stage` 同时运行装配、离线文档及发行元数据测试，使用同一检查验证仓库导航闭包。

## 依赖与构建产物

根生产依赖仅允许 package.json 的 ws/yaml 及必需闭包。锁为v3，根元数据、安装快照version/integrity和包声明必须一致；拒绝链接、选中开发依赖、未知模块、缺许可及未支持的必需peer/optional。根目录已知开发依赖可存在，但不进入载荷。装配时核对并带入 Server 的完整生产依赖。

npm integrity对应tarball，展开目录无法重算；快照一致不能证明字节未被同时篡改。使用按锁安装、审阅且稳定的输入；manifest 为实际复制字节另算SHA-256。

Nitro输入仅选 server/public，入口为 server/index.mjs。依赖trace允许是根包文件子集，但模块集合必须恰等于生产闭包；每文件与根包字节一致，package.json仅允许JSON语义不变的格式／键序差异。拒绝代码漂移、未知文件、pnpm store链接和.links。输出两处node_modules都从根包复制完整文件，恢复被裁剪入口和许可，不直接分发裁剪trace。

所有区域拒绝特殊文件、硬链接、目录链接、常见私有配置／密钥文件和第二主要运行核心；省略.map，避免带入构建路径。文件名筛查不能替代输入与产物审阅。

## 核心与许可

Mihomo二进制必须匹配HEAD中[组件清单](../integrations/metacubexd/components.json)的唯一平台摘要，并核验ELF64 little-endian及机器类型，复制为bin/mihomo、0755。CLI不接受任意替换摘要；库函数测试注入不属于部署接口。

| 平台 | 固定资产 |
| --- | --- |
| linux-arm64 | mihomo-linux-arm64-v1.19.33.gz |
| linux-amd64-v1 | mihomo-linux-amd64-v1-v1.19.33.gz |

目标运行和验收范围见[发行说明](release-notes.md)。跨架构装配不执行外来核心，目标安装还须核对架构和能力。

载荷保留MetaCubeXD MIT、Mihomo GPLv3、ws MIT、yaml ISC及其依赖许可与固定来源。对外分发还需按实际分发方式提供适用的对应源码、通知等，装配完成本身不证明分发要求全部满足。当前载荷的版本与文件以manifest为准。

## 输出与复核

在同父目录的随机私有暂存内完成后rename到新输出，开始和结束都检查目标不存在；失败仅清理本次暂存。目录请求0700，manifest0600，普通文件0644，核心和Git可执行文件0755；目标Linux须另核对实际身份、权限和ACL。输出父目录独占，Node跨平台rename没有目录no-replace保证。

| 限制 | 数值 |
| --- | --- |
| 单文件／总字节 | 256 MiB／512 MiB |
| 文件数／路径 | 12,000；深度32、长度1,024字符 |
| manifest／Git输出 | 8 MiB／32 MiB |

manifest记录schema、源提交、组件版本、锁及组件清单摘要、状态读取兼容声明、每文件路径／SHA-256／大小／模式。兼容声明复用随源码分发的 `packages/deployment/state-compatibility.mjs`；装配核验该文件与当前装配器的声明来源一致，拒绝对不同契约源码套用当前声明。声明仅覆盖列出的持久状态 schema，不承诺配置迁移、任意旧版升级、降级或网络资源兼容；升级仍须核对实际状态、核心配置和验收条件。manifest 自身不递归列入清单，成功回执另给manifestSha256；回执与固定错误码不泄露输入路径或凭据。

安装前独立核验该摘要、文件集和字节。传送时只选择输出目录，不复制父目录或整个工作区。验证命令为 `npm run test:release-stage`，使用合成仓库、普通依赖和假核心，检查白名单、完整性、路径、失败清理及不覆盖，不构成服务或终端验收。
