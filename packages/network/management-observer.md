# 固定管理服务 PID 来源

`observeGatewayManagement({ systemctlPath, managementUid })` 是生产只读观察器。调用方从已验证的网络部署计划取得数字管理 UID；不能传入 PID、服务名、单元路径、cgroup 路径或替代读取器。输入拒绝额外字段、访问器、Proxy 和非普通对象，校验不调用输入 getter。

观察器只在 Linux root 上运行，通过规范的 `/usr/bin/systemctl` 查询固定 `coproxy-management.service`。验证命令、固定 `/etc/systemd/system/coproxy-management.service` 文件及其祖先由 root 控制，不允许组或其他用户写入、符号链接和文件硬链接。服务必须 loaded、active/running，无待处理 job、drop-in 或待重载配置，数字 User 必须等于计划中的管理 UID，ControlGroup 必须为 `/system.slice/coproxy-management.service`。

前后各读取一次服务与进程证据，要求 PID、启动时间、boot ID、命令和单元文件元数据、命名空间及挂载视图稳定。校验 procfs/cgroup2fs 挂载和相关路径无覆盖挂载；观察器与 PID 1 的 user/net/pid/cgroup/mnt 命名空间一致，初始完整 UID 映射和单层 NSpid 关系成立。管理进程的 user/net/pid/cgroup 命名空间一致；允许 systemd 沙箱创建独立 mount 命名空间。进程四个 UID、NSpid、存活状态、启动时间和固定 cgroup 必须符合要求。

结果仅包含固定原因码及最小事实，不泄漏原始错误或探测路径。每次命令有 1 秒超时和 16 KiB 输出上限；整次成功观察最多 5 秒。命令调用保留 `NetworkCommandError` 的已知收敛分类，未知命令异常按未收敛处理；本地文件读取或输出解析失败仍属于已收敛。`commandsSettled: false` 表示命令后代清理无法确认，调用方不得据此开始恢复写操作。

此证据只证明管理服务 PID 来源和对应的最小进程身份，不证明单元正文或二进制摘要，也不证明 cgroup 完整成员、内核 ID、socket 隔离、网络 ready 或业务可用。完整 cgroup 身份仍交给 `observeCoreCgroup` 验证，最终驱动必须关联 boot ID、PID 和启动时间。

`observeGatewayManagementFixture(input, reader)` 是合成测试入口，其结果永久标记 `scope: 'fixture'`；生产入口没有读取器注入或失败后的 fixture 回退。
