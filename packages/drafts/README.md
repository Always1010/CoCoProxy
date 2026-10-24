# 私有配置草稿

`DraftStore` 保存通过当前 `compileConfig` 支持边界校验的输入快照；这仍不是完整的 Mihomo schema 校验。草稿保留合法未知 JSON 字段，不保留调用者对象引用。模块使用 Node.js 22.18+ 内建 API，无第三方依赖。

```ts
import { DraftStore } from './index.ts';

const store = new DraftStore(absolutePrivateDirectory);
const previous = await store.metadata();
const saved = await store.save(configInput, previous?.revision ?? 0);
const snapshot = await store.load(saved.revision);
```

- `metadata(): Promise<DraftMetadata | null>` 仅返回 `{ revision, generation, updatedAt }`。目录或草稿不存在时返回 `null`，不会创建目录。
- `save(input: unknown, expectedRevision: number): Promise<DraftMetadata>`：不存在时以版本 `0` 比较；成功后版本加一；过期版本返回 `DRAFT_CONFLICT`。版本参数必须为非负安全整数。
- `load(expectedRevision: number): Promise<LoadedDraft>` 返回 `{ revision, input, generation }`；不存在返回 `DRAFT_NOT_FOUND`，版本不符返回 `DRAFT_CONFLICT`。`input` 含私有配置、节点及凭据，禁止作为 CLI stdout 或公开响应返回。

根目录必须是绝对路径，并由调用者保证祖先目录可信。唯一草稿文档 `draft.json` 包含版本 `1`、修订号、原始输入快照、编译结果 SHA-256 和 ISO 时间；整个 UTF-8 文档上限 4 MiB。读取时重新编译并核对摘要、版本、结构与时间，损坏文档返回 `DRAFT_CORRUPT`。其他编译失败沿用编译器固定错误码，存储错误沿用共享私有存储固定错误码，所有 `DraftError` 消息只有错误码。

保存复用 `FileTransactionStore.exclusive` 的跨进程锁及私有原子文件助手，不嵌套锁。活跃锁争用返回 `STORE_LOCKED`，调用者可重新读取元数据后决定是否重试；CAS 实际发现旧版本时返回 `DRAFT_CONFLICT`。POSIX 目录及文件要求当前 UID、无组/其他用户权限，创建模式分别为 `0700` 与 `0600`，拒绝符号链接；Windows 需要调用者提供私有父目录 ACL。初始化共享锁可能创建空的候选目录，但不会生成或 stage 任何候选、修改事务状态或触发 runtime。

未完成的应用事务不会将草稿视为已应用；锁释放后仍可保存草稿，包括事务等待恢复的情况。保存不修改 `desired`、`active`、应用事务或健康状态。生成不可变候选及真实应用必须由后续明确操作完成，本模块未接入真实运行环境。模块也不执行远程来源下载、设备写入或节点连通性检查。
