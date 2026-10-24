# MetaCubeXD 适配记录

状态：固定源码已审查，尚未安装、构建或集成，不是已验证运行组合。机器可读的候选引用见 review.json。

审查入口为 v1.273.1，其 Git 引用核对为 8bbc8f58fef71148a94fb5c0ff808f79b057337d。后续构建应核对提交，不只信任可移动 tag。上游是 pnpm 工作区；Agent 包是 private workspace 包，不能假定可从 npm 独立安装。根配置指定 pnpm 10.34.1。[根配置](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/package.json)、[Agent 包](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/package.json)

## 已核对的适配点

| 上游入口 | 源码事实 | Coproxy 接入要求 |
| --- | --- | --- |
| packages/agent/src/index.ts | createAgent 直接创建 supervisor，默认创建脚本执行器，并连接订阅刷新任务 | 不原样实例化后再叠加监管；组合受控模块或增加有界适配点，禁止来源脚本 |
| packages/agent/src/types.ts | 导出 supervisor 与 profile store 接口 | 对接实际生命周期和配置事务；不把接口存在当成适配已完成 |
| packages/agent/src/refresh-apply.ts | 活跃订阅刷新可写入活跃配置并重启 | 手动与自动刷新都必须进入统一暂存、校验与应用事务 |
| packages/agent/src/http.ts | 路由包括生命周期、配置及能力入口 | 审查所有修改入口；外层独立认证和访问限制；不能直接公开核心凭据 |
| packages/agent/src/profile-editor.ts | 编辑器有独立的应用逻辑 | 将编辑结果送入受保护编译器，不绕过部署边界 |

上述源码见固定提交的 [Agent 入口](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/index.ts)、[类型](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/types.ts)、[订阅应用](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/refresh-apply.ts)、[控制路由](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/http.ts)、[编辑器](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/profile-editor.ts)。

该版本上游默认核心引用为 v1.19.27，与项目调研候选 v1.19.33 不同；不能自动认为二者兼容，也不能将候选组合命名为生产版本锁。[核心资产定义](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/packages/agent/src/kernel/assets.ts)

## 构建与验收边界

获准准备依赖后，在项目专用构建目录获取固定提交并使用上游锁文件冻结依赖；先审查安装生命周期脚本，不自动运行任意准备脚本。优先只构建 Server/UI 相关依赖，不安装桌面应用或浏览器资产。上游完整源码、node_modules、缓存和构建输出不进入本仓库源文件或发布源码附件。

上游代码使用 MIT 许可证；候选 Mihomo 的 LICENSE 为 GNU GPL v3。实际分发时核对具体资产和组合，保留对应许可与来源要求；本记录不表示已制作包含这些资产的发行包。[MetaCubeXD LICENSE](https://github.com/MetaCubeX/metacubexd/blob/8bbc8f58fef71148a94fb5c0ff808f79b057337d/LICENSE)、[Mihomo LICENSE](https://github.com/MetaCubeX/mihomo/blob/3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8/LICENSE)

下一关卡：固定资产校验、真实核心语法与协议输入、受控管理服务、订阅/编辑事务接入和唯一监管。通过前不得报告网关、节点或 LAN 已可用。
