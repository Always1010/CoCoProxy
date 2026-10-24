# Root helper 的受限 HTTP transport

`helper-http.ts` 只负责 HTTP 边界。生产入口调用
`serveGatewayHelper({ port, tokenSha256 }, handler)`，返回实际 `port` 和幂等异步
`close()`。生产端口必须为 `1024..65535`，地址固定为 IPv4 `127.0.0.1`，不能由请求或
配置切换监听地址。`serveGatewayHelperFixture` 额外接受端口 `0`，仅供合成 backend 的
loopback 测试使用；生产入口不应调用该函数。

handler 提供 `status()`、`stage(policy, sources?)`、`apply(generation, expectedRevision)`
和 `recover()`，全部返回 Promise。HTTP transport 不作系统权限、生产驱动或验收范围的
声明；成功 JSON 来自 backend，fixture 结果也必须保留其合成范围。策略编译、离线
sources 校验、候选身份和 revision CAS 由 backend 执行。transport 不获取订阅 URL，
不接受额外 deployment 或 network 字段。

## 调用契约

每个请求必须使用 HTTP/1.1、精确的 `Host: 127.0.0.1:<实际端口>` 和
`Authorization: Bearer <token>`。token 是恰好 64 位小写十六进制明文；服务端配置仅
保存其 UTF-8 字节的 SHA-256 小写十六进制摘要，认证使用固定长度摘要和
`timingSafeEqual`。Authorization、Host、Content-Type 和 Content-Length 重复头均拒绝。

| 方法和路径 | 请求体 | handler |
| --- | --- | --- |
| `GET /v1/status` | 无请求体 | `status()` |
| `POST /v1/candidates` | `{"policy":...}` 或 `{"policy":...,"sources":...}` | `stage(policy, sources)` |
| `POST /v1/apply` | `{"generation":"<64位小写十六进制>","expectedRevision":0}` | `apply(generation, expectedRevision)` |
| `POST /v1/recover` | `{}` | `recover()` |

POST 必须精确使用 `Content-Type: application/json`，提供规范十进制 Content-Length，
长度不超过 1 MiB。request body 必须是有效 UTF-8 和对象 JSON，且原文与
`JSON.stringify(JSON.parse(raw))` 完全相等，因此不接受空白、重复键、替代数字表示或
非规范转义。顶层字段集合必须与表中完全一致，expectedRevision 必须是非负安全整数。
HTTP body 必须在 3 秒内完整到达；此期限只覆盖读取请求体，不限制已进入 backend 的
事务执行时间。

路径不经过 URL 归一化，仅接受表中的精确原始路径；query、absolute-form URL、编码
路径、尾斜杠和其他方法均拒绝。请求不得携带 Origin、Referer 或任何 Sec-Fetch-* 头，
服务不提供 CORS。Content-Encoding、Transfer-Encoding、Expect、Upgrade 和 CONNECT
均拒绝；客户端应提供有界 Content-Length，不能使用 chunked body。

## 资源、错误与关闭

最多同时处理 8 个请求，包括正在读取请求体的请求；超限返回 503 和
`NETWORK_HELPER_OVERLOADED`。HTTP header 上限 16 KiB，header/完整请求接收超时为
5 秒，keep-alive 超时 1 秒；响应使用 `Connection: close`。底层 HTTP 解析器拒绝的
畸形报文返回无正文的 400。应用层错误返回固定形状 `{"error":{"code":"..."}}`，
未知错误统一为 500 `NETWORK_HELPER_FAILED`，不输出 message、cause、token 或请求原文。
已知业务错误码必须在 transport 的显式 allowlist 中，错误码只读取 own data property，
不执行 getter。

成功响应必须是 JSON 数据对象，嵌套值不能包含 getter、toJSON、自定义 prototype、循环
引用、非有限数字或其他非 JSON 值；总响应不超过 1 MiB，深度和遍历节点数也有上限。
响应携带 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。

客户端断开不会取消已进入 backend 的事务；重试的一致性依赖 backend 的候选身份与
revision CAS。`close()` 停止接受新连接，关闭空闲连接，并等待已接受的请求和 backend
事务结束，不能强杀仍在执行的驱动。未完成的请求体仍受 3 秒限制。backend 如果永远
不结算，其 graceful close 也会等待；进程级强制退出策略应由上层明确管理。

`tests/network-helper-http.test.ts` 使用本机 loopback 和合成 handler，验证协议与生命周期
边界；不安装依赖、不修改主机网络、不证明 Linux 驱动或设备环境可用。
