# 原生网络资源私有凭据

`ResourceJournal(root, scope)` 保存 `native-resource-receipt.json`，scope 固定为 `production` 或 `fixture`。它只提供私有持久存储和跨进程锁；资源操作、独立内核回读、旧工具进程收敛、恢复阻断及 revision CAS 由调用它的原生会话负责。它不接受公共 HTTP 请求，也不把 receipt 当作当前就绪证明。

`read()` 不创建目录。文件不存在时返回 null，存在时要求私有 regular file、单硬链接及严格且有界的 JSON，校验 plan 摘要、固定工具路径和摘要、boot/user/net namespace 格式、renderer 摘要、scope、阶段、合法且无重复的 RPDB/route membership 与精确 pending 步骤。nft JSON 在这里仅做有界结构检查，其 AST 语义、handle 归属及实际内核状态必须另外通过原生回读验证。返回值深度冻结。

`exclusive(operation)` 复用 `FileTransactionStore` 的 owner 身份锁，初始化 0700 目录和保留的 `candidates/`，操作异常保持原有类型和对象；锁与存储异常使用固定错误码。锁初始化之前及拿锁之后均检查目录祖先。production 要求 root 执行，目录及全部祖先由 root 所有，祖先不可被组或其他用户写入，目标目录不可被组或其他用户访问。fixture 允许系统根目录在新 user namespace 显示为 UID 65534，并仅允许系统 `/tmp` 使用 sticky writable 祖先；其下目录必须由当前 euid 所有且私有。所有模式拒绝目录符号链接。Windows 依赖部署方提供可信私有父目录 ACL，不声称 POSIX 权限检查覆盖 ACL。

`write(receipt)` 只可在 `exclusive` 回调内调用，不修改传入对象，返回 revision 加一的新冻结对象。调用方必须在锁内读取当前 receipt 并完成 revision CAS；锁本身不能防止另一个已构造会话使用陈旧内存。pending 必须和变更前的完整 state 一次写入；不能先更新 state 再单独补 pending。成功工具结果与独立回读核验完成之后，才能提交新 state 并清除 pending。

写入使用临时私有文件、文件同步、rename 和目录同步。任何写入或同步失败均抛出 `NETWORK_RESOURCE_STORE_IO`；即使 rename 已完成，也绝不报告成功。调用者必须将会话作废，下一次恢复重新读取受保护记录并核验 pending，不能依赖失败调用之后的内存 revision 猜测落盘状态。

不同 root 的锁彼此独立；受信服务必须为同一网络域固定唯一 authority root。不得在已持有相同 root 的 coordinator 锁时再次进入此锁。锁 owner 尚未持久写完或锁回收 guard 残留时，底层可能安全拒绝自动回收；本组件不承诺任意掉电都可自动恢复，也不删除未知锁。
