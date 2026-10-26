# 可选的管理 HTTPS 探测

需要确认调用电脑能否访问管理 HTTPS 时，使用统一入口：

```sh
./cocoproxy management-report --input /absolute/private/deployment.json --probe-https
```

命令仅从调用端 Node 请求配置 origin 下固定的 `/api/cocoproxy/health`，最多等待 5 秒、读取 2 KiB，不跟随跳转，不发送认证信息，不允许忽略 TLS 校验。可信 TLS、HTTP 200 及预期管理 health 内容均满足才通过。省略 `--probe-https` 时不联网，唯一检查为 `not-run`；不创建文件。

结果的 `scope: "invoking-node"` 只描述调用进程。自签名证书即使 SAN 和密钥匹配，也可能不被调用端 Node 信任；Node 成功同样不能证明手机或浏览器信任证书、能登录或已显示通知。这些项目直接按[实际验收清单](setup-lifecycle.md#实际验收)检查，无需另建人工证据文件。

输入复用安装计划的完整校验，不需要启动服务或具备 root 权限；Unix 私有输入须归当前身份所有且不允许其他身份读取，Windows 使用仅当前用户可读的私有位置。报告只输出固定状态与解释，不输出实际 origin、配置、口令、Cookie 或推送订阅。
