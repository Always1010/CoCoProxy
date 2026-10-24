# 订阅来源与节点快照

`SubscriptionStore(root, client?, decoder?)` 将来源定义和已接受的节点快照存入绝对路径的私有状态目录。它只登记、下载、校验和保存编译输入，不生成候选，不验证或应用运行时配置。所有写入与 `FileTransactionStore` 共用根目录锁；下载和解码在锁外执行，提交时重新检查来源 revision。只读和登记操作不需要 client；没有 client 时 refresh 返回 `SOURCE_CLIENT_REQUIRED`，不发起请求或递增 revision。

默认 HTTPS 下载器、来源许可策略和实际 TLS 验证范围见 [HTTP 客户端](http.md)。

`SnapshotClient.fetch(url, previous?)` 返回 `{status: 'modified', text, etag?}` 或 `{status: 'not-modified'}`；`previous` 仅含可选 ETag。生产客户端必须保证 HTTPS 下载的超时、响应大小和重定向边界。来源 URL 最多 8192 字符，只允许 HTTPS，不允许 userinfo 或 fragment，允许查询参数。保存和发出的 ETag 最多 512 字符且必须是可打印 ASCII；响应中的非法 ETag 被丢弃，合法节点正文仍可接受，下次刷新改为完整下载。URL、ETag、原始响应和节点凭据只属于私有输入，调用方不得记录它们。

默认 decoder 是 `JSON.parse`，也可以显式注入同步 decoder。解码结果必须严格为 `{proxies: JsonObject[]}`。完整订阅里的规则、策略组、provider、脚本、部署及未知顶层字段均返回 `SNAPSHOT_UNSUPPORTED`；节点再通过 `compileConfig` 的离线安全边界，拒绝远程 provider、文件读取、脚本或出口覆盖等字段。校验使用合成部署参数与 `MATCH,REJECT` 策略，不启动网络核心。它不是完整的 Mihomo 协议 schema 校验；真正应用前仍须验证目标核心配置。

公开 API：

- `list()`：只读、按 ID 排序的 metadata 清单；缺目录时返回空数组，不暴露 URL。逐项校验已存记录，拒绝不明文件和超限目录，仅跳过原子写入器的已知临时文件；它不是跨来源原子快照，后续修改仍须按各自 revision 检查。
- `configure({id, url}, expectedRevision)`：输入必须为仅含 `id`、`url` 可枚举数据属性的普通对象，不接受访问器或继承属性；在任何异步操作前复制、校验并冻结内部定义，调用者随后修改原对象不会改变操作目标。新增时 expectedRevision 为 `0`；配置成功 revision 加一。ID 必须匹配 `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，最多 100 个来源。同一 URL 可继续使用已接受快照和 ETag；URL 字符串变化立即清除 ETag，并将旧快照标记为不属于当前定义。
- `refresh(id, expectedRevision)`：只在读取和提交时 revision 都匹配时接受下载。成功、304 和已提交的下载／解码／校验失败都会使 revision 加一；失败保存固定 lastError 后抛出 `SubscriptionError`。并发旧回包返回 `SOURCE_CONFLICT`，不会覆盖新定义、快照或失败记录。锁被其他写入占用时继承存储层的 `STORE_LOCKED` 行为。
- `status(id)`：返回 metadata 或 `null`。metadata 只含 `id`、`revision`、`snapshotDigest`、`snapshotRevision`、`snapshotCurrent`、`lastAttempt` 和 `lastError`，没有 URL、ETag、节点或上游错误文本。
- `snapshot(id, expectedRevision?)`：返回私有编译输入 `{id, proxies, sha256, sourceRevision}`。可选 expectedRevision 在同一次只读操作得到的来源记录上检查，必须匹配当前来源 revision，而不是快照的 sourceRevision，否则返回 `SOURCE_CONFLICT`。不存在的来源返回 `SOURCE_NOT_FOUND`；尚未成功取得当前定义快照时返回 `SOURCE_PENDING`。返回对象的修改不会改变已保存快照。

刷新失败保留上次成功快照和 ETag。URL 未变时，调用方可继续使用该快照；URL 变化后，旧字节仍物理保留，但 `snapshotCurrent` 为 false，`snapshot()` 拒绝输出它。304 仅在当前定义已有快照且请求带有已接受 ETag 时有效，不能使新来源或更换 URL 后的旧快照成为当前数据。304 更新 attempt 和来源 revision，不改变原快照的 sourceRevision。

每个来源保存为私有 `subscriptions/<id>.json` 原子记录，文件最多 4 MiB，节点快照还受配置编译器的深度、数量和安全约束。SHA-256 覆盖 `canonicalJson({proxies})` 的 UTF-8 字节；所有状态和快照读取都检查摘要与结构，损坏时拒绝，不能用刷新悄悄覆盖。摘要用于完整性检查，不构成对私有存储写入者的认证。POSIX 目录和文件分别要求当前用户拥有的 0700／0600 权限，拒绝符号链接；Windows 需要调用方提供受保护的父目录 ACL。只读 API 不创建目录。

刷新错误码为 `SOURCE_FETCH_FAILED`、`SNAPSHOT_DECODE_FAILED`、`SNAPSHOT_UNSUPPORTED`、`SNAPSHOT_INVALID`、`SNAPSHOT_LIMIT`、`SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT`。定义及存储错误包括 `INVALID_SOURCE_INPUT`、`INVALID_SOURCE_ID`、`INVALID_SOURCE_URL`、`INVALID_SOURCE_REVISION`、`SOURCE_CONFLICT`、`SOURCE_LIMIT`、`SOURCE_PENDING`、`SOURCE_NOT_FOUND`、`SOURCE_CORRUPT`，以及底层固定存储错误。所有错误只含固定 code，不透传源异常。
