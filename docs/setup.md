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

升级必须提供原输入，保留内部 secret、已支持的解析配置和下载策略。服务身份改变会拒绝；旧安装使用自定义状态、设置或凭据布局时继续使用底层安装器。origin 或许可变化仍需安装器显式配置审阅，不能绕过收据。

`upgrade`、`uninstall` 参数与 `install` 相同，前置及顺序见[维护流程](deployment.md#关闭升级与卸载)。旧 release 保留不等于任意状态格式都可降级；入口不自动复制凭据或创建备份。

## 输出边界

环境、部署输入及路由器参数含真实网络或秘密，保留在目标私有位置；仓库内调试材料只放被忽略的 `.local/`，不进入发行、同步或公开附件。命令默认只打印固定结果与必要状态，不打印内部秘密或环境 JSON。
