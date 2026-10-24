# 本地显式代理载荷装配

`scripts/stage-explicit-release.mjs` 把已审阅的源码、已构建的 MetaCubeXD Server/UI、根运行依赖和固定 Mihomo 装配为新的本地目录。它不安装依赖、不执行包生命周期脚本、不构建上游、不创建账户、不写系统目录、不安装或控制服务，也不改变网络。该目录用于后续独立审阅的安装步骤，不表示 systemd、polkit、节点协议或网关已经验收。

从干净的 Coproxy Git 仓库运行：

```sh
node scripts/stage-explicit-release.mjs \
  --source-dir /absolute/source/coproxy \
  --server-dir /absolute/build/metacubexd/apps/server/.output \
  --runtime-dependencies /absolute/source/coproxy/node_modules \
  --core /absolute/reviewed/mihomo \
  --output /absolute/private/staging/explicit-release
```

五个参数均为显式规范绝对路径；前三个目录与核心必须存在。输出父目录必须事先存在且受可信操作者控制，输出自身必须不存在。目录、文件及祖先不能经过符号链接或 Windows 目录联接；Windows 短路径别名也应先转换为规范真实路径。不得把输出放入任何输入目录内部。所有输入及输出父目录必须在装配期间保持稳定，不能由其他进程或不可信身份并发修改；普通 Node 文件 API 不提供针对恶意目录替换的完整隔离。

源目录必须为 Git 工作树根目录，拒绝已暂存或未暂存的受跟踪修改，以及未忽略的未跟踪文件。工具固定启动时的 HEAD，使用 `git ls-tree` 和 `git cat-file` 读取提交内的 blob，并在完成前再次核对 HEAD 和工作区。Git 树中任何 symlink 或 gitlink 均拒绝。被忽略的本地资料不参与装配；读取源码不遍历 `.local/`，也不跟随其中的共享目录链接。调用 Git 只读取元数据和对象，不运行构建或源代码。

载荷布局如下：

```text
source/
  apps/                         # HEAD 内的运行源码
  packages/                     # HEAD 内的运行源码及随附模块说明
  package.json
  package-lock.json
  node_modules/{ws,yaml,...}/    # 仅必需生产依赖
  integrations/metacubexd/      # LICENSE、review、源码树清单与来源说明
  integrations/mihomo/LICENSE
server/.output/
  server/                       # Nitro 入口、运行 chunks 和普通依赖副本
  public/                       # 构建的 UI 静态资产
bin/mihomo
manifest.json
```

源码仅选取 HEAD 的 `apps/`、`packages/`、根 package 元数据、存在的根 LICENSE/NOTICE，以及明确列出的来源记录。显式排除 `.local`、`.git`、node_modules、缓存、构建目录和协议夹具；根开发工具、测试、真实部署设置、凭据和其他工作区资料不复制。运行依赖通过下面的独立规则加入，不能通过源码目录夹带。MetaCubeXD overlay 已包含在构建产物中，完整上游源码和构建工作区不复制到载荷。

根生产依赖限定为当前 package.json 声明的 `ws` 和 `yaml`，递归选择锁文件中的必需生产依赖。`package-lock.json` 必须为 v3，根元数据和依赖声明必须匹配；安装目录 `.package-lock.json` 的 version/integrity 必须与受跟踪锁一致，每包的 package.json 名称、版本和必需依赖也必须匹配。拒绝选中模块的链接、开发依赖标记、未知模块、缺失许可、未经支持的必需 peer 或 optional 依赖。根目录中锁文件已知的开发依赖允许存在，但不进入载荷；`.bin` 与安装目录快照也不复制，不运行其中的命令。

这里的 npm integrity 校验是锁文件与已安装快照之间的一致性检查。npm integrity 对应压缩 tarball，不能从已展开目录重新计算；该检查不能证明展开文件没有被同时篡改。应使用已审阅、按锁安装且未被其他进程修改的依赖目录。清单为实际复制字节记录独立 SHA-256，便于后续复核。工具不会为补足证明而联网下载或执行 npm。

Nitro `.output` 只选择 `server/` 和 `public/`，忽略顶层构建元数据。`server/node_modules` 必须是上述生产依赖的完整普通文件副本，模块集合、文件集合及内容必须与根运行依赖一致；不能使用指向 pnpm store 的链接或 `.links`。Server 入口必须包含 `server/index.mjs`。所有区域均拒绝特殊文件、硬链接、目录链接、私有配置常见文件名、密钥文件和另一个主要运行核心；协议测试中的 sing-box 不进入安装载荷。`.map` 文件始终省略，避免将 sourcemap 中的真实构建路径带入载荷。文件名筛查不能替代对构建产物内容和构建输入的审阅。

Mihomo 解压后可执行文件的 SHA-256 必须与 HEAD 内 `integrations/metacubexd/review.json` 的 `coreCandidate.binarySha256` 相同，复制目标固定为 `bin/mihomo`，模式为 `0755`。版本、固定提交和摘要来自同一审阅记录。CLI 不接受更换摘要的参数；库函数的 `reviewedCoreSha256` 仅供合成测试在代码中显式注入，不属于部署配置接口。

MetaCubeXD 使用固定提交 `8bbc8f58fef71148a94fb5c0ff808f79b057337d` 的 [MIT LICENSE](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/LICENSE)，载荷保留该通知、审阅记录和源码树来源。Mihomo 使用固定提交 `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8` 的 [GNU GPL v3 LICENSE](https://github.com/MetaCubeX/mihomo/blob/3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8/LICENSE)，工具要求此文本已经作为 `integrations/mihomo/LICENSE` 进入源提交。ws 的 MIT 许可和 yaml 的 ISC 许可随完整生产模块保留。这份载荷只是内部安装审阅产物，尚未发布；仅保留许可证与固定源码提交链接不能自行证明 GPLv3 对外分发合规。实际分发前须另行准备对应源码与适用的提供方式，并按分发方式审查通知等要求；此事不阻塞内部装配，也不构成已经合规的结论。

输出在同一父目录下使用随机私有暂存目录，内容全部完成后以 rename 原子切换到最终目录。初次和最终发布前均检查输出不存在；失败只删除本次创建的暂存目录，不清理任何输入或其他载荷。输出根及内部目录请求 `0700`，manifest 请求 `0600`，普通文件记录 `0644`、Git 可执行源文件及 Mihomo 记录 `0755`。Windows 不提供相同的 POSIX 权限语义，目标 Linux 上仍须核对实际所有者、模式与 ACL。输出父目录应独占使用，避免其他操作者在最终检查和 rename 之间创建同名目标；Node 的跨平台 rename API 没有目录级 no-replace 标志。

单文件最大 256 MiB，载荷总字节数最多 512 MiB，最多 12,000 个文件，相对路径最多 32 层且不超过 1,024 字符，manifest 最大 8 MiB；Git 命令输出另有 32 MiB 上限。清单包含 schemaVersion、源提交、组件版本、锁摘要以及每个载荷文件的相对路径、SHA-256、大小和目标模式。manifest 自身不递归列入文件清单，其 SHA-256 在成功回执中返回。回执不包含输入绝对路径、配置内容或凭据；错误仅返回固定错误码。

可以对 manifest 所列每个文件重新计算大小与 SHA-256，并对比目标模式。校验载荷后，再由独立授权的安装流程把需要的文件放到受控系统位置，生成对应部署计划并检查服务身份与权限。装配结果不得通过整体复制本地工作区的方式替代；打包时只选择该输出目录，不包含其父目录或任何 `.local/` 链接。

`tests/release-stage.test.ts` 使用合成 Git 仓库、普通依赖副本和假核心验证固定 HEAD、未跟踪漂移、依赖锁及副本一致性、真实链接拒绝、不覆盖已有输出、失败清理和逐文件清单。测试不安装依赖或服务，不访问网络，不证明真实核心与系统服务兼容。
