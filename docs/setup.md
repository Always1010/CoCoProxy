# 统一部署入口

本入口将环境事实转换为原安装器接受的私有部署输入，复用载荷、字段、权限和归属校验。完整接线、证书及终端验收见[从零部署](getting-started.md)，设备边界见[支持矩阵](support-matrix.md)。

发行包解压后使用根目录 `cocoproxy`；源码目录使用 `sh scripts/cocoproxy-setup.sh` 或 `npm run setup --`。以下命令在已核验发行包及获准目标 Linux 中执行，路径是合成角色示例，须替换实际值。

## 1. 盘点环境

```sh
sh ./cocoproxy check
sh ./cocoproxy doctor
```

`check` 仅检查基础工具是否存在，不依赖 Node。`doctor` 汇总 Linux、架构、Node、systemd、Python、ip/nft、polkit、TUN 和 IPv4 转发结果。失败或未知的必要项使退出码为 1。结果包含固定 id、解释及处理方向，不输出原始系统错误。软件、账户、地址和 IPv4 转发仍按目标系统准备，检查不会安装依赖或改变网络。

## 2. 填写一次环境事实

将随包 `source/examples/setup-environment.json` 作为合成参考，在已存在的私有目录创建自己的 0600 文件。不要直接使用文档地址。

必填内容为接口、外设/路由器 IPv4、路由器交付 MAC、精确 LAN CIDR、管理 origin、纯 IP 引导 DNS 和订阅 HTTPS origin 许可。端口、网络资源编号和安装位置有默认值，可通过 `ports`、`resources`、`system` 覆盖；生成器继续调用完整部署校验。`system.serviceUser` 默认 `cocoproxy`。目标 Linux 从唯一的非登录账户读取 UID；离线生成时必须提供 `system.serviceUid`，目标安装仍重新核验。

```sh
ENVIRONMENT=/etc/cocoproxy-install/environment.json
sh ./cocoproxy doctor --environment "$ENVIRONMENT"
```

该检查只读，不创建 TUN、规则、账户或服务，不把默认路由猜成已授权交付路径。路由器条件、浏览器证书信任与终端路径须独立验收；通过只表示可以继续安装预检。

## 3. 生成私有安装输入

```sh
PAYLOAD=/srv/cocoproxy-staging/release
MANIFEST_SHA='<从可信发行清单核验的64位manifest摘要>'
INPUT=/etc/cocoproxy-install/deployment.json
sh ./cocoproxy configure --environment "$ENVIRONMENT" \
  --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --output "$INPUT" \
  --router-output /etc/cocoproxy-install/router-parameters.json
```

输出父目录须已存在、由当前身份所有且权限 0700；输出新建为 0600，拒绝覆盖。完整载荷先经过摘要和文件集核验，再派生 release 目录、核心摘要、source/binary/server 路径、前缀和重复 DNS 端口，首次生成随机内部 controller secret。摘要必须来自可信来源，不能只对未知下载自算摘要建立信任。

路由器参数文件含真实网络信息，仍是私有资料；它不是任意固件的可导入配置，按[协作约定](router-contract.md)映射到已验证适配器。程序不会据此写入另一台设备。

## 4. 安装预检与执行

```sh
sh ./cocoproxy install --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT"
sh ./cocoproxy install --payload "$PAYLOAD" --manifest-sha256 "$MANIFEST_SHA" --input "$INPUT" --apply
```

第一条只读。第二条才安装文件并 daemon-reload，仍不启动服务。随后按[安装与维护](deployment.md)准备管理员和[HTTPS](management-https.md)，完成首次应用、路由器交付、终端验收及[持久运行](getting-started.md#8-启用持久运行与自动恢复)。HTTPS 登录成功不代表终端信任证书或[通知](notifications.md)已可用。

## 5. 升级输入与维护

```sh
sh ./cocoproxy configure --environment "$ENVIRONMENT" \
  --payload /srv/cocoproxy-staging/new-release --manifest-sha256 '<新可信manifest摘要>' \
  --existing-input "$INPUT" --output /etc/cocoproxy-install/deployment-next.json
```

升级必须提供原输入，保留内部 secret、已支持的解析配置和下载策略。环境文件省略的端口、网络资源、探测许可、服务身份和系统路径沿用旧输入；明确填写的字段表示待审阅的新值。服务身份改变会拒绝；旧安装使用自定义状态、设置或凭据布局时继续使用底层安装器。origin 或许可变化仍需安装器显式配置审阅，不能绕过收据。

`upgrade`、`uninstall` 参数与 `install` 相同，前置及顺序见[维护流程](deployment.md#关闭升级与卸载)。旧 release 保留不等于任意状态格式都可降级；入口不自动复制凭据或创建备份。

在关闭服务之前可以准备新版本，并检查安装归属与持久状态的读取格式：

```sh
sh ./cocoproxy prepare --payload /srv/cocoproxy-staging/new-release \
  --manifest-sha256 '<新可信manifest摘要>' --input /etc/cocoproxy-install/deployment-next.json
sh ./cocoproxy inspect
sh ./cocoproxy recover
```

`prepare` 允许服务仍运行，但不表示已经可以执行升级；应用阶段会重新要求暂停、停用服务和退役网络。`inspect` 读取收据、锁和文件证据。`recover` 默认仅预览：只有新事务已写完全部预期字节、原进程已退出且当前状态满足约束时，才允许用返回的审阅摘要显式收尾。它不重试部分写入，不删除未知锁，不进行程序降级。详细步骤见[安装中断检查与恢复](maintenance-recovery.md)。

## 6. 可选的受管 HTTPS

已有反向代理可以继续按[HTTPS 配方](management-https.md)管理。若希望本项目安装收据统一管理独立 nginx 配置及 unit，在环境输入增加：

```json
{
  "https": {
    "mode": "managed",
    "certificatePath": "/etc/cocoproxy/web/server.crt",
    "privateKeyPath": "/etc/cocoproxy/web/server.key"
  }
}
```

这是环境文件的可选片段，不是完整输入。nginx 需预置，默认路径 `/usr/sbin/nginx`，可以通过 `nginxPath` 指定可信系统路径。管理 origin 必须使用 HTTPS 及非特权端口，证书覆盖该主机并与私钥匹配；证书和密钥须按配方准备好归属与权限。工具只引用既有证书/密钥，不申请、复制或删除它们，不修改终端信任。

生成后安装计划包含本项目专用 nginx 配置和网页 unit，其升级/卸载纳入同一收据。已有手工同名文件不能自动接管，必须先核对归属。`https` 省略时，升级生成保留旧输入的受管模式；首次生成沿用外部 HTTPS。明确设置 `{"mode":"external"}` 表示外部管理，受管模式的撤销不能绕过安装器的文件集合与迁移约束。

## 7. 初始化、启动与持久运行

[生命周期入口](setup-lifecycle.md)把初始化、管理启动、持久运行启用、暂停及停机退役组织为可预览步骤：

```sh
sh ./cocoproxy lifecycle --action start-management --input "$INPUT"
sh ./cocoproxy lifecycle --action start-management --input "$INPUT" \
  --apply --reviewed-plan-sha256 '<本次预览返回的摘要>'
```

入口核对当前完整安装收据、输入和文件字节，执行时与安装/恢复共用互斥条件。初始化另外指定私有 `--admin-input`；完整步骤及各动作的条件见生命周期说明。`--terminal-path-verified`、`--router-disabled` 记录操作者已完成实际验收或关闭的确认，不是工具自己观测到的网络证据。

从另一台电脑安装或更新时使用[SSH 部署入口](remote-deployment.md)，由该入口协调目标上的安装、服务和已有路由器适配器；它不要求在本机执行 Linux 服务命令。

## 输出边界

环境、部署输入及路由器参数含真实网络或秘密，保留在目标私有位置；仓库内调试材料只放被忽略的 `.local/`，不进入发行、同步或公开附件。命令默认只打印固定结果与必要状态，不打印内部秘密或环境 JSON。

`configure` 的部署输出与可选路由器输出分别使用独占新建，并非跨文件原子事务。如果第二个输出失败，第一个私有部署输入可能已经生成；检查已有文件后选择新的输出路径，不覆盖或反复生成内部秘密。
