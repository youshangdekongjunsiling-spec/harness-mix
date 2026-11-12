> 2026-11-12 用户已否决本文的独立面板界面方案。独立通信通道仍可复用，但必须保留原 Harness Mix UI 与完整交互。本文仅记录已尝试的实现，不作为恢复成功或最终产品方案。验收以 native-ui-restoration-acceptance.md 为准。

# 新版 Codex 的独立 Harness 对话通道

## 背景与边界

Codex Desktop 26.1106.6628.0 的界面暴露 `{hostId, rpc}` 客户端，旧版 Harness Mix 依赖的界面 request manager、通知注入及审批回复钩子已不可用。单纯恢复 Harness 选择器不能恢复实际执行。

独立模式使用同一窗口中的 **Harness 对话** 面板。它的输入、历史、消息流和审批直接连接 Harness Mix Host；官方 Codex 原生输入框和 app-server 路径保持独立。Claude、DeepSeek 和 Codex（协作）会话从该面板操作。

现有 `trial-data/mix-core` 历史和工作区继续由原 HostRuntime 管理，不迁移或覆盖原始 Claude/Codex 记录。旧版原生侧栏中遗留的导入记录不代表已经接通 Harness 执行。

## 通信

```
Harness 对话面板
  → 独立请求客户端
  → 本机 CDP Runtime binding
  → Desktop controller
  → stdio Host sidecar
  → NativeProtocol / HostRuntime
  → 显式选定的原生 Harness
```

反向流包含消息事件和带 ID 的审批/提问。新会话必须携带规范化 Harness route；无路由的原生请求被拒绝。超时不会自动重发执行请求，界面保留草稿并要求核对历史。

审批通过 `harnessmix/interaction/respond` 等待后台确认。同一请求、同一答复重试去重；冲突答复拒绝；原生交付失败可以重试。多选问题明确携带 `harnessmixMultiple`，答复数组完整保留。重新读取活动会话会重现仍有效的待答请求。

## 验证与限制

- `npm run test:independent-channel`：客户端隔离、超时、确认去重，以及真实 HostRuntime/NativeProtocol 配合测试适配器的新建、流式回复、断线审批恢复、多选、纠正、停止和历史恢复。
- `npx electron scripts/independent-panel-smoke.cjs`：隐藏测试窗口中的实际 DOM 交互；不操作用户 Codex，不调用付费模型。
- 发布前还需语法、TypeScript、核心回归及实际窗口检查。模拟适配器通过不能替代真实 Claude/DeepSeek 推理验证。
- 首版独立面板仅支持文本输入，图片/文件附件尚未接入；不宣称与旧版原生界面完全等价。
- 运行中的 controller 缓存旧脚本，更新构建后需从桌面外部启动“重启 Harness Mix”。不能在 Codex 任务内部绕过启动保护。

本次实际启动工作树为 `harness-mix-attention`。旧 `harness-mix-source` 工作树与 npm 安装目录的构建不能替代该运行目标。
