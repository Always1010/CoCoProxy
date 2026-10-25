# Windows 一键网络压测

使用现有 Node.js ≥22.18 和 curl ≥7.70，无 npm/Python 依赖，不需要管理员权限。脚本不安装软件，不切换网络、规则、节点或代理开关。只在用户运行时产生测速流量；操作期间无需 Agent 在线，但互联网测速需要互联网可用。

## 使用

1. 电脑连接要测的接入网络，固定位置、频段及代理节点，暂停其他下载和重型构建。
2. 双击仓库根目录 `run-network-benchmark.cmd`，填写本轮场景后回车。例如 `wifi-direct`、`wifi-gateway-direct`、`wifi-proxy`。场景只是手工标签，脚本不会验证或改变流量路径。
3. 等待约两分钟完成。默认顺序：空闲 15 秒，单连接下载 20 秒、单连接上传 20 秒、4 连接下载 20 秒、4 连接上传 20 秒；阶段之间休息 2 秒。同时每秒尝试一个小请求，慢请求结束后再继续，不堆积并发探测。
4. 控制台显示独立结果目录，默认位于 `.local/reports/network-benchmark/`。先看 `summary.txt`，需要分析时提供同目录的 `report.json` 和 `samples.jsonl`；`summary.csv` 可用表格软件打开。无需上传临时载荷，正常退出时会自动删除。

默认对端是 Cloudflare 公开测速接口：下载 `https://speed.cloudflare.com/__down`、上传 `https://speed.cloudflare.com/__up`；使用其公开的 `bytes` 下载参数及二进制 POST 上传方式，参见 [Cloudflare Speedtest](https://github.com/cloudflare/speedtest)。没有安装或运行 Cloudflare 的 JS 测速引擎，也不调用其结果上报接口；服务端会接收正常测试请求。满载会影响同链路其他业务，快速连接可能消耗数 GB 流量。每次运行只测当前状态，需要对照时手动切换至另一状态后重新运行。

若小下载、探测或小上传检查失败，脚本保存原因后停止，不开始满载；不要把无有效吞吐的阶段当作带宽为零。按 Ctrl+C 会停止子进程并尽量保存已完成阶段和逐请求记录；强制关闭窗口或进程终止不保证生成最终摘要。每个请求有独立截止时间和进程看门狗，单次测试有有限阶段，不会永久持续施压。

## 可选参数

从仓库根目录在终端运行；也可以直接给 `.cmd` 入口追加参数：

```powershell
# 更充分的采样：阶段延长到 45 秒，并重复 3 轮。
node scripts/network-benchmark.mjs --label wifi-proxy --duration-seconds 45 --idle-seconds 45 --rounds 3

# 仅显示帮助，不联网。
node scripts/network-benchmark.mjs --help

# 显式指定自有测速服务；使用合成地址示意，不会自动发现测试对端。
node scripts/network-benchmark.mjs --download-url https://test.example/down --upload-url https://test.example/up --latency-url https://test.example/latency
```

自有下载服务须接受 `bytes` 查询参数并返回相应数量的字节，上传服务须接收二进制 POST 并成功返回；不跟随 HTTP 重定向，不携带凭据，不关闭证书验证。`--allow-http` 只允许本机回环 HTTP 合成验证。可用 `--output-dir` 显式指定其他私有结果父目录。结果包含接口地址、默认 IPv4 路由和 curl 实际本地／对端地址，不能放入可提交或公开同步位置。端点查询参数、响应正文、curl 原始错误及代理凭据不写入结果；场景标签不要填秘密。

## 结果含义和边界

- 吞吐是阶段内 HTTP 应用载荷总量除以整个阶段墙钟时间，包含反复建连和请求间隙。每个下载请求 100 MB，每个上传请求 10 MB，按阶段时限重复；并发为独立 curl 进程。它适合对照实际路径，不等于 iperf 或线路物理速率。下载只统计成功状态下的有效传输及阶段截止时的部分传输；错误页不计入。
- 上传速率是 curl 记录的客户端发送量，阶段截止时未完成的上传也可能计入；不是远端确认的有效吞吐。`acknowledgedUploadBytes` 只包含完成且返回成功状态的请求发送量。若全部请求都未完成，结果明确警告；不要把它当作经过服务器确认的带宽上限。
- 小请求每次新建 IPv4 HTTP/1.1 连接；系统 DNS 缓存不清理。HTTPS TTFB 从请求开始到首字节，包含 DNS、TCP、TLS 和服务端耗时。JSON 也保留累计连接／TLS时间、总时间和成功率。它不是 ping RTT；请求失败率也不是 ICMP/UDP 丢包率。跨过阶段截止时间的探测另计，不混入该阶段时延分布。
- 默认样本量用于初步判断，少于 40 个成功样本会提示 P95 仅供探索，不输出 P99。默认单轮不产生严格的统计结论，需要时延长阶段、重复同条件对照。
- curl 使用 `-q` 忽略个人 curl 配置、`--noproxy '*'` 忽略环境代理，并固定 IPv4 HTTP/1.1；流量按当前系统路由发出，适用于透明网关路径。它不会自动采用浏览器代理，也不会证明请求实际经过哪个节点。多网卡时必须另行核实实际出口；本地／远端 IP 和路由快照只是辅助证据。
- Wi-Fi、宽带、互联网测试对端和代理节点都可能先到瓶颈。端点不可达或被限速时无法测得设备极限。脚本不 SSH 登录网关／路由器，不采集它们的 CPU，不做 UDP、连接数或故障注入测试。

逐请求记录会持续写入 `samples.jsonl`，每阶段更新 `report.json`。`deadlineTimeouts` 表示阶段结束造成的预期传输截断，与提前发生的请求故障分开。其他失败会出现在摘要警告中；连接连续失败两次的负载 worker 提前退出，避免持续重试。
