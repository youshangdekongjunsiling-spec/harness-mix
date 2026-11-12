# 原界面恢复验收约束（2026-11-12）

用户最新明确要求：保留原来的 Harness Mix UI、交互设计及所有既有功能；禁止新增替代入口。先前选择独立通信通道不代表授权改为独立会话面板。

## 修复边界

- 运行目标：harness-mix-attention；保留已有未提交的 Claude 与 Attention 修复。
- 新版 Codex 26.1106.6628.0 需要通信兼容层；独立通信实现必须复用原 UI。
- 官方 Codex 执行路径维持 stock app-server；不允许默认请求降级流入 Harness Host。
- 不把 independent-harness-panel 的后台连通、29 条记录或模拟测试通过当成原 UI 修复成功。
- 不在任务内重启 Codex，不绕过启动器保护。

## 必须保持的功能及验证状态

以下是验收范围，不代表当前已通过。各 Harness 具体支持以原 manifest 为准，不扩张原能力声明。

| 范围 | 必须保留 | 当前验证 |
| --- | --- | --- |
| 界面 | 原 Harness/模型/思考/权限选择器、原输入框、消息区、项目/最近历史 | 待新版适配 |
| 对话生命周期 | 新建、恢复、历史分页、改名、归档、Fork、消息级 Fork、接力 | 待新版适配 |
| 执行 | 流式文本、思考、工具状态、纠正、停止、队列、后台完成接续 | 待新版适配 |
| 审批 | 工具权限、真实多问题/多选反馈、断连恢复、确认交付 | 待新版适配 |
| 输入 | 文本、原有图片/文件附件、IME、草稿保存 | 待新版适配 |
| 协作 | # 菜单、多 Agent、Team、原生子代理及工作台 | 待新版适配 |
| 设置 | Harness 管理、Skills、MCP、皮肤、用量/健康中心 | 待新版适配 |
| 工作区 | cwd/项目映射、Git/worktree、diff、上下文压缩 | 待新版适配 |
| 隔离 | 外部 Harness 后新建/恢复官方 Codex，始终走官方线路 | 待真实窗口验证 |

验证层次：类型/单测 → 原通信端到端测试 → 重启后真实窗口 → 实际 Harness 回合。不得将前一层结果替代后一层。

来源：用户当前纠正；仓库 README.md 功能矩阵与 AGENTS.md。会话 01a11c97-b9c7-75b0-9293-0f2ffaa51b22。
## 2026-11-12 实测补充（尚未完成验收）

- 用户完成官方 Claude 登录后，专用测试会话实际返回 `HARNESS_NATIVE_OK`，没有工具调用；测试线程 `5cee9000-bb61-4737-8a86-0f8d6b8ef3dc`。
- 当前窗口原生 manager、RPC composite、原 Probe/adapter 已 ready，独立浮动面板已移除。原选择器及侧栏图标可见。
- 原生管理器独立验证可读取 29 条目录及含 5 个回合的真实历史；多问题答复在 Host ACK 前保留、ACK 后移除。
- 实际点击专用 Claude 历史仍提示“未找到对话”；运行时 ownsThread 为 true，但 manager 没有加载 conversation、loadedThreads 为 0。后台读取成功不等于导航加载通过。
- `npm run test:core-all` 已完整退出 0；日志 `output/repair-20261112/core-all-latest.log`。协作测试收尾耗时较长，先前的“挂起”观察不是已确认死锁。
- 真实 UI 发送、附件、审批、重启后官方隔离等仍待完整验收；不得据此宣称全功能恢复。

## 2026-11-12 22:05 实际验收更新（取代上述过期状态）

原 UI 专用 Claude 会话 b06f743a-791a-41b4-bb70-eb83c38659d9 已实际通过：
- 新聊天选择 Claude，实际 Claude 原生会话返回 HARNESS_CLAUDE_NEW_OK。
- 原附件入口上传文本和红色 PNG；正确读取标记和图片颜色。
- AskUserQuestion 原选项卡选择蓝色，正确回传并复述。
- Write 原审批卡允许一次，approval-proof.txt 实际写入 HARNESS_APPROVAL_OK。
- Bash 后台任务结束，无新用户输入，自动回复 BG_AUTO_RESUMED。
- 原生一次性 CronCreate，无新用户输入，自动回复 HARNESS_CRON_AUTO_OK；界面和后端均已确认。

修复：新版 Dgwo.p 执行注册表也必须按明确 Harness 选择分流；仅包装 M4 历史连接不足。创建请求冻结模型选择，并兼容原界面 legacy carrier。
Fable：升级私有 Claude CLI 至 2.1.318；原生 fable 别名实测仍解析 5.1。适配器按原生目录最高 Fable 版本解析，真实独立适配器测试实际使用 claude-fable-5-2，显式版本仍固定。

验证：20 个定向 UI 单测通过；类型检查、302 文件语法检查、core-all（core-all-final-claude.log，退出 0）、后台任务和子代理测试通过。
尚未完成：外部重启后 Fable 选择器及实际调用、先 Claude 后官方 Codex 新建与恢复隔离验收。不可据此宣称所有既有功能全部验收。

## 重启后最终定向验收（2026-11-12 22:39）

用户确认外部重启后，在原 UI 新建并选 Fable 5.2（最新版），实际返回 FABLE_RESTART_OK。Host 记录 647b10dc-31fd-4eed-8bcf-a131f2362349 的 harnessId=claude，model.id=claude-fable-5-2，nativeSessionId=cc515778-2dc1-439c-9343-ba84f352ef0a，status=ready。
随后新建官方 Codex 对话 01a1d1b2-625f-7630-8914-727654ebbf4b，回复 OFFICIAL_AFTER_CLAUDE_OK。切到 Claude 历史再返回，续聊正确回复验收词“青松”。官方 read_thread 确认两回合 completed、无错误；Host 没有该线程记录。Host traffic 中该 ID 仅出现 Harness 状态/team/usage 探测，无 thread/start、resume 或 turn 执行请求。
本轮用户明确要求的 Claude 新建、Fable 最新版、文件/图片、审批、反问、后台及定时自动续接，均完成真实验收，保留原界面。其他未逐项操作的历史功能不扩张为全面验收结论。

## 复现此版本

源码分支：codex/attention-workbench。安装项目依赖后执行 npm run build:native:ui；output/ 为可重建产物，不提交。保持官方 Codex CLI 不变。
本次真实验收的独立 Claude Code 版本为 @anthropic-ai/claude-code@2.1.318；它安装在 Harness 专用 claude-runtime，属于外部运行依赖，不在本仓库 node_modules 或提交中。复现时将 HARNESSMIX_CLAUDE_COMMAND 指向该独立安装的 Claude 可执行文件，沿用本人官方登录；勿提交或复制凭据。
检查：npm run check、npm run test:core-all、npm run test:claude-latest-fable，以及 native-composite-rpc、native-sidecar-request-client、native-manager-approval-gate 的 Vitest 定向测试。原生界面适配器对 Codex 26.1106 构建做哈希校验；后续 Desktop 升级需重新适配和验收。
