# 保留的自有网络框架

本目录是早期自有网络资源执行与强证据方案，**暂停扩建，与当前 Mihomo 原生自动接管互斥，不在管理服务、CLI 或 systemd 的当前启动链路中**。安装当前产品请看[部署](../../docs/deployment.md)和[原生网关](../gateway/README.md)。

代码保留三路由域、持久命令屏障、资源归属、逐 socket/cgroup 观察和网络协调器，用于维护已有实现与研究已证实缺口。“production”表示组件读取来源和调用约束，不代表该组合已部署验收。

## 维护入口

| 文档 | 内容与对应源码 |
| --- | --- |
| [配置与资源契约](contracts.md) | plan.ts、config.ts、candidate.ts、rules.ts、runtime-plan.ts |
| [执行与资源回读](execution.md) | command.ts、fenced-command.ts、resource-journal.ts、native.ts、readback.ts、helper-http.ts |
| [身份与运行观察](observations.md) | core-observer.ts、management-observer.ts、identity.ts、sockets.ts、host.ts、link.ts、probe.ts、observer.ts |
| [协调与恢复](recovery.md) | transaction.ts、runtime.ts、driver.ts、watchdog.ts |

## 共同边界

- 部署由受信操作者显式指定，不能从浏览器、订阅或当前同名资源推导授权。
- 生产要求 Linux root 和真实主机视图；fixture 入口固定标记 fixture，不可回退或升级成 production。
- 每个网络域只有一个协调器 authority，写操作串行并核对 revision、代次及新鲜证据。进程或工具未收敛时保留 fence。
- scope、verified、历史状态、核心身份、localReady 和终端连通分别判断；terminalPath 始终 unverified。不得用 UID-only 或旧 ready 替代证据。
- 不修改账户、软件、sysctl、主机地址、系统默认路由、其他服务资源或路由器配置。故障保持阻断，用户关闭是独立生命周期。
- 私有计划、凭据、原始输出和测试记录按 [AGENTS.md](../../AGENTS.md) 保存；公共结果仅含固定原因码及必要摘要。

## 验证范围

针对性入口为 package.json 中的 `test:network-*`，按对应源码选择，参数见[开发说明](../../docs/development.md#真实组件与隔离检查)。单元层使用合成 reader／driver，并验证真实私有文件、锁及进程语义。

`test:network-kernel` 在独立 user/network namespace 的四角色网络中使用固定核心，验证 HTTP/UDP、DNS、来源、回程、污染拒绝、故障阻断及资源恢复。它复用已有 cgroup 并禁用管理例外，资源会话未通过完整协调器执行；不能推导生产两个服务隔离、完整 systemd 恢复或真实设备验收。缺少显式二进制参数可跳过，已给参数后的能力或路径失败必须报错。

固定驱动已组合资源、核心和观察组件，但认证 helper 主程序、管理接入、关闭生命周期及完整生产组合未完成验收。跨 boot、namespace、工具及核心 artifact 迁移的限制分别见执行与恢复文档。
