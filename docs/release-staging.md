# 发行载荷装配

`scripts/stage-explicit-release.mjs` 将固定 HEAD 源码、已构建 Server/UI、运行依赖和审核 Mihomo 组合为新目录，支持显式及原生网关后续安装。脚本名称保留兼容；装配不安装依赖、构建上游、操作服务或改变网络。后续流程见[部署与维护](deployment.md)。

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
  scripts/measure-latency.mjs   # 无第三方依赖的请求时延基线工具
  node_modules/                # 完整生产依赖
  integrations/metacubexd/      # 来源、review、LICENSE
  integrations/mihomo/LICENSE
server/.output/{server,public}/
bin/mihomo
manifest.json
```

源码必须是干净 Git 工作树根，拒绝受跟踪修改和未忽略的新文件；固定启动HEAD，以 Git blob 读取并在完成前复核。symlink/gitlink 拒绝，不执行 Git hooks 或构建代码。

选择 apps/packages、根包元数据及存在的 LICENSE/NOTICE、明确的文档／样本与来源记录，以及独立的请求时延基线工具。可信部署选项说明 `examples/deployment-options.md` 随载荷提供。排除 .local、.git、缓存、其他开发工具、测试、协议对端及上游完整源树；不遍历本地共享链接。文档白名单变更时须同步维护导航依赖。

## 依赖与构建产物

根生产依赖仅允许 package.json 的 ws/yaml 及必需闭包。锁为v3，根元数据、安装快照version/integrity和包声明必须一致；拒绝链接、选中开发依赖、未知模块、缺许可及未支持的必需peer/optional。根目录已知开发依赖可存在，但不进入载荷。

npm integrity对应tarball，展开目录无法重算；快照一致不能证明字节未被同时篡改。使用按锁安装、审阅且稳定的输入；manifest 为实际复制字节另算SHA-256。

Nitro输入仅选 server/public，入口为 server/index.mjs。依赖trace允许是根包文件子集，但模块集合必须恰等于生产闭包；每文件与根包字节一致，package.json仅允许JSON语义不变的格式／键序差异。拒绝代码漂移、未知文件、pnpm store链接和.links。输出两处node_modules都从根包复制完整文件，恢复被裁剪入口和许可，不直接分发裁剪trace。

所有区域拒绝特殊文件、硬链接、目录链接、常见私有配置／密钥文件和第二主要运行核心；省略.map，避免带入构建路径。文件名筛查不能替代输入与产物审阅。

## 核心与许可

Mihomo二进制必须匹配HEAD中[审核数据](../integrations/metacubexd/review.json)的唯一平台摘要，并核验ELF64 little-endian及机器类型，复制为bin/mihomo、0755。CLI不接受任意替换摘要；库函数测试注入不属于部署接口。

| 平台 | 固定资产 |
| --- | --- |
| linux-arm64 | mihomo-linux-arm64-v1.19.33.gz |
| linux-amd64-v1 | mihomo-linux-amd64-v1-v1.19.33.gz |

目标运行和验收范围见[发行说明](release-notes.md)。跨架构装配不执行外来核心，目标安装还须核对架构和能力。

载荷保留MetaCubeXD MIT、Mihomo GPLv3、ws MIT和yaml ISC许可及固定来源。对外分发还需按实际分发方式提供适用的对应源码、通知等，装配完成本身不证明分发要求全部满足。当前载荷的版本与文件以manifest为准。

## 输出与复核

在同父目录的随机私有暂存内完成后rename到新输出，开始和结束都检查目标不存在；失败仅清理本次暂存。目录请求0700，manifest0600，普通文件0644，核心和Git可执行文件0755；目标Linux须另核对实际身份、权限和ACL。输出父目录独占，Node跨平台rename没有目录no-replace保证。

| 限制 | 数值 |
| --- | --- |
| 单文件／总字节 | 256 MiB／512 MiB |
| 文件数／路径 | 12,000；深度32、长度1,024字符 |
| manifest／Git输出 | 8 MiB／32 MiB |

manifest记录schema、源提交、组件版本、锁摘要、每文件路径／SHA-256／大小／模式。自身不递归列入清单，成功回执另给manifestSha256；回执与固定错误码不泄露输入路径或凭据。

安装前独立核验该摘要、文件集和字节。传送时只选择输出目录，不复制父目录或整个工作区。验证命令为 `npm run test:release-stage`，使用合成仓库、普通依赖和假核心，检查白名单、完整性、路径、失败清理及不覆盖，不构成服务或终端验收。
