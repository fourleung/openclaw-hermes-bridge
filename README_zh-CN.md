# openclaw-hermes-bridge

[English](./README.md)

一个基于 Node.js 的 [**ACP**](https://github.com/zed-industries/agent-client-protocol) (Agent Client Protocol) 桥接器，用于将 Hermes 代理功能无缝嵌入 OpenClaw 的工作流和插件中。通过 `bridge.delegate(workflowId, subtask)` 即可在宿主进程代码中调用 `hermes acp`，并获取经过 Schema 验证且具有超时保护的响应结果（`Envelope<T>`）。无需 HTTP、无需 WebSocket、无需注册中心 —— 仅通过标准输入输出（stdio）实现具有完善生命周期管理的 JSON-RPC 通信。

- **基于工作流的会话池** —— 相同的 `workflowId` 会复用同一个代理会话；冷启动后的热复用速度可提升约 6 倍。
- **单次尝试超时控制** —— 初始提示词和（必要的）修复提示词分别拥有独立的计时器，避免因整体耗时过长导致中途意外中断。
- **输出 Schema 验证** —— 内置 JSON Schema 7 契约验证（基于 Ajv 2020），在检测到 `schema_error` 时自动执行一次修复（Repair）尝试。
- **统一的关闭协议** —— 遵循 ACP `cancel` → ≤1s 应答等待 → 关闭会话 → SIGTERM → 2s → SIGKILL 的完整流程。该协议同样适用于超时强杀、显式关闭及进程停机场景。
- **可取消性** —— 支持通过 `AbortSignal` 在任何阶段（信号量排队、会话启动、提示词交互）取消操作。
- **可观测性** —— 提供 `BridgeEvent` 侧向通道，用于实时获取文本块（Chunks）、工具进度、状态迁移以及最终响应。

该工具已通过宿主进程扩展与生产环境 ACP 代理的端到端验证。首次冷启动约需 35 秒；在同一 OpenClaw 会话中，热复用的响应时间仅约 5 秒。



## 安装

macOS / Linux:

```bash
git clone https://github.com/fourleung/openclaw-hermes-bridge.git
cd openclaw-hermes-bridge
./setup.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/fourleung/openclaw-hermes-bridge.git
cd openclaw-hermes-bridge
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

依赖要求：Node.js ≥ 20.3。需确保 `hermes acp` 已安装且在 `PATH` 路径中（或通过 `hermesCommand` 参数手动指定）。

如果您的 PowerShell 执行策略已允许运行本地脚本，也可以直接运行 `.\setup.ps1`。

目前该包通过源码分发。`npm install openclaw-hermes-bridge` 和 `npx openclaw-hermes-bridge ...` 流程应被视为未来的发布目标，而非当前的安装方式。

`openclaw-hermes-bridge` 是一个供运行在 OpenClaw 宿主进程内的 Node.js 代码调用的库。它**不是**一个会自动注册的 OpenClaw 插件。

上述安装脚本会自动为您构建程序包并配置 OpenClaw 扩展的关联。

这会在您的用户目录下安装或更新本地 OpenClaw 扩展，典型路径如下：

- macOS / Linux: `~/.openclaw/workspace/.openclaw/extensions/hermes_bridge/`
- Windows: `%USERPROFILE%\.openclaw\workspace\.openclaw\extensions\hermes_bridge\`

当您从本地代码仓库运行脚本时，它会自动通过 `file:` 依赖将生成的扩展指向当前本地副本。这样在本地开发设置过程中无需执行 npm publish。

### 自定义 OpenClaw 工作区

macOS / Linux:

```bash
./setup.sh --workspace-root /path/to/openclaw/workspace
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 --workspace-root C:\path\to\openclaw\workspace
```

### 自定义程序包引用

macOS / Linux:

```bash
./setup.sh --package-ref file:/absolute/path/to/openclaw-hermes-bridge
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 --package-ref file:C:\absolute\path\to\openclaw-hermes-bridge
```



## Hermes 调用机制

本项目**不连接**固定的 HTTP、WebSocket 或 TCP 地址。它会启动一个本地 Hermes 子进程，并通过标准输入输出（stdio）进行 ACP 协议通信。

默认行为：

- 启动命令：`hermes acp`
- 传输协议：stdio JSON-RPC
- 寻址方式：除非手动覆盖，否则 `hermes` 可执行文件必须在系统的 `PATH` 中

您可以通过以下两种方式覆盖默认命令：

- 在调用 `createBridge()` 时传入 `hermesCommand`
- 设置环境变量 `OPENCLAW_HERMES_BRIDGE_HERMES_CMD`

示例：

```ts
const bridge = createBridge({
  hermesCommand: ['/absolute/path/to/hermes', 'acp'],
});
```



## 直接调用库 API（进阶）

```ts
import { createBridge } from './dist/index.js';
import type { JSONSchema7 } from 'json-schema';

const bridge = createBridge({
  // 以下为默认值
  hermesCommand: ['hermes', 'acp'],
  defaultTimeoutMs: 180_000,
  maxConcurrentSessions: 8,
});

const decomposeSchema: JSONSchema7 = {
  type: 'object',
  required: ['subtasks'],
  properties: {
    subtasks: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  additionalProperties: false,
};

const workflowId = 'run-2026-04-18-abc123';

const result = await bridge.delegate(workflowId, {
  prompt: '请将该目标分解为 3-5 个原子子任务：部署到生产环境。',
  outputSchema: decomposeSchema,
}, {
  onEvent: (evt) => {
    if (evt.type === 'message') console.log('收到数据块:', evt.text);
  },
});

if (result.status === 'ok') {
  console.log(result.output.subtasks);
}

// 工作流结束时请调用 close()；TTL 仅作为安全兜底，不能替代显式关闭。
await bridge.close(workflowId);

// 进程关闭时：
await bridge.shutdown();
```

该示例展示的是在当前仓库完成 `npm run build` 之后，直接从本地 `dist/` 目录调用库 API 的方式。

在常规的 OpenClaw 使用场景中，由 `./setup.sh` 或 `.\setup.ps1` 生成的扩展会自动为您调用 `createBridge()`，多数用户不需要手写这段代码。

### 生成的 `call_hermes` 工具语义

生成出的 OpenClaw 扩展会把**追踪 ID**和**会话复用键**分开：

- `task_id` —— 单次调用的追踪 / 审计 ID
- `workflow_id` —— Hermes 上下文连续性的复用键
- 未传 `workflow_id` —— 自动回落到当前 OpenClaw 的 `sessionKey`

同时，输出新增观测字段来表征底层进程实例的生命周期：
- `session_generation`: 进程被重新拉起的代次 (例如因空闲回收后重建会递增)
- `reused`: 本次调用是否复用了已存在的底层进程实例

这意味着：默认情况下，同一条 OpenClaw 会话里的多次 `call_hermes` 会复用同一个 Hermes 会话；与此同时，调用方仍然可以为每次子任务分配独立的 `task_id`。

## 系统架构

共分为四层，仅支持自顶向下的单向依赖：

```
                    ┌────────────────────────────┐
                    │  公开 API (Public API)      │  ← src/index.ts
                    │  createBridge, Bridge      │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  核心分发器 (Delegate Core) │  ← src/delegate-core.ts
                    │  提示词组合、验证、修复、     │
                    │  单次尝试计时、事件发射       │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │ 会话管理器 (Session Manager) │  ← src/session-manager.ts
                    │ 工作流与会话映射、互斥锁、     │
                    │ 信号量、空闲 TTL、生命周期控制 │
                    │ 以及会话回收管理             │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  传输层 (Transport)         │  ← src/transport/
                    │  ACP 客户端封装 +            │
                    │  子进程启动管理              │
                    └────────────────────────────┘
```

本仓库有意保持公开 API 和架构的精简：公开 API -> 核心分发器 -> 会话管理器 -> 传输层。如果您修改了行为，请在同一变更中同步更新本 README 和相关测试。



## 配置选项

| 选项 | 默认值 | 用途 |
|---|---|---|
| `hermesCommand` | `['hermes', 'acp']` | 覆盖二进制文件路径及参数 |
| `hermesEnv` | `{}` | 与 `process.env` 合并的环境变量 |
| `hermesCwd` | `undefined` | 子进程的工作目录 |
| `logger` | no-op | 兼容 pino 的结构化日志记录器 |
| `defaultTimeoutMs` | `180000` | **单次尝试**的实际用时超时（初始提示词和修复提示词分别拥有独立的计时器；不包含信号量排队或会话启动时间） |
| `idleTtlMs` | `600000` | 会话闲置超过该时长后自动关闭 |
| `maxSessionLifetimeMs` | `3600000` | 会话运行超过该时长后强制回收（Drain） |
| `maxConcurrentSessions` | `8` | 全局并发会话上限；超过限制的调用将阻塞排队 |
| `sessionBootTimeoutMs` | `60000` | 涵盖进程启动 + ACP `initialize` + `newSession` 的总时长。该值预留了典型 ACP 代理冷启动（实测约 35s）所需的缓冲空间 |

环境变量：`OPENCLAW_HERMES_BRIDGE_HERMES_CMD`（以空格分隔）可在未设置 `hermesCommand` 时覆盖默认命令。为保持本地兼容性，旧有的 `FLASH_BRIDGE_HERMES_CMD` 别名仍然有效。

当前版本仅支持本地 stdio 子进程传输方式，不支持基于 HTTP、WebSocket 或 TCP 的 Hermes 端点。



## 返回值

`delegate()` 在发生常规运行时错误时会返回一个结果包（Envelope）而非直接抛出异常。

核心状态值：

- `ok` —— 输出成功匹配 Schema
- `schema_error` —— 初始尝试和修复尝试均未能通过 Schema 验证
- `agent_error` —— 传输层或代理发生故障
- `timeout` —— 单次尝试计时器触发，且会话未被复用
- `cancelled` —— 调用方主动中止或桥接器正在关闭

`meta.attempt` 在常规成功路径下为 `1`，若使用了修复路径则为 `2`。



## 事件监听

可以在调用 `delegate()` 时传入 `onEvent` 以观察执行进度：

```ts
await bridge.delegate(workflowId, subtask, {
  onEvent: (evt) => {
    if (evt.type === 'message') {
      console.log(evt.text);
    }

    if (evt.type === 'status') {
      console.log('当前阶段:', evt.phase);
    }
  },
});
```

实用的事件类型包括：

- `status` —— 生命周期转换，如 `session_open`、`prompt_sent`、`repair_start`
- `message` —— 来自 Hermes 的流式文本块
- `tool_progress` —— 工具调用进度更新
- `final` —— 在返回最终结果包之前发射
- `error` —— 终端非 `ok` 状态的结果

事件采用“发射即忘”模式。返回的结果包（Envelope）仍是唯一权威的最终结果。



## 问题排查

**冷启动耗时超过 60 秒：** `sessionBootTimeoutMs` 将抛出 `SessionBootstrapTimeoutError`。请确认您的代理 ACP 二进制文件在独立运行时能否在合理时间内启动；启动成本包括子进程创建 + ACP `initialize` + `newSession`。如果您宿主环境的实际冷启动延迟超过 60s，请调大该参数 —— 这是一个独立于 `defaultTimeoutMs` 的计时器。

**重复出现 `schema_error`：** 修复流程仅在 Schema 验证失败时运行一次。如果两次尝试均失败，可能的原因包括：(a) 提示词对于所需格式的描述存在歧义；(b) `outputSchema` 要求的严苛程度超过了代理的生成能力；(c) 代理在 JSON 周围输出了过多提取器无法处理的废话。建议在提示词中明确写出 Schema 的具体要求。

**返回状态为 `timeout` 且 `rawText` 包含部分内容：** 这是符合预期的。当单次尝试计时器触发时，系统会发送 ACP `cancel` 并等待最多 1s 的应答，随后杀掉子进程。计时器触发前已接收到的数据块会保存在 `rawText` 中。此时会话**不会**被复用；针对同一 `workflowId` 的下一次 `delegate()` 调用将启动新会话。系统**不会自动重试**。

**在 `bridge.shutdown()` 期间发生 `cancelled`：** 如果在 `delegate()` 执行过程中调用 `shutdown()`，该调用将返回 `status: 'cancelled'` 且错误消息中会提及正在关机。此时会执行完整的统一关闭协议（cancel → 1s ack → close → SIGTERM → 2s → SIGKILL），确保不会发生子进程泄露。

**并发量达到 `maxConcurrentSessions` 上限：** 调用将进入 FIFO（先进先出）信号量排队阻塞。这**不会**报错。如果您需要在等待容量期间支持取消操作，请在 `DelegateOptions.signal` 中传入 `AbortSignal`。



## 开发相关

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run test:coverage           # 强制执行 85/80/85/85 的覆盖率阈值
OPENCLAW_HERMES_BRIDGE_E2E=1 npm run test:e2e   # 需要 PATH 中存在真实的 hermes 
```

参与贡献：请参阅 [`CONTRIBUTING.md`](CONTRIBUTING.md)。变更日志：[`CHANGELOG.md`](CHANGELOG.md)。



## 开源协议

MIT
