# Agent Runtime 与 IM Bot Bridge 分享文档

本文基于当前仓库代码，梳理 `agent-im` 如何把 Codex、Claude、Copilot、Cursor/Agent 等不同运行时包装成统一能力，并通过 Telegram、Discord 等 Bot 变成可协作、可审批、可观测的研发工作流入口。

## 一句话架构

`agent-im` 的核心不是“把聊天消息转发给大模型”，而是把 IM 消息、看板任务、运行时 CLI/SDK、审批、Git/PR/测试流程连接成一个统一的任务执行系统。

```text
Telegram / Discord / Feishu / QQ / Redis Agent
        │
        ▼
Channel Adapter
  - 拉取/接收消息
  - 鉴权与去重
  - 发送回复、预览流、审批按钮
        │
        ▼
Bridge Manager
  - 命令处理：/new /cwd /mode /runner /perm /stop
  - 会话绑定：channel + chat -> session
  - 权限请求转发
  - SSE 流消费与消息投递
        │
        ▼
LLMProvider 抽象
  - streamChat(params) -> ReadableStream<SSE>
        │
        ├── Claude Provider   -> @anthropic-ai/claude-agent-sdk
        ├── Codex Provider    -> @openai/codex-sdk + codex wrapper
        ├── Copilot Provider  -> copilot CLI JSON stream
        └── Cursor Provider   -> agent CLI stream-json
```

看板自动化走同一套运行时抽象，但入口不是 IM 聊天，而是 `WorkflowService` 和 `InstanceManager` 根据任务状态启动不同角色的 agent。

## 统一抽象：LLMProvider

所有运行时最终都被压平成同一个接口：

```ts
interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

`StreamChatParams` 承载统一上下文：

- `prompt`：本轮用户输入或任务指令。
- `sessionId` / `sdkSessionId`：平台会话与底层运行时会话，用于续聊。
- `model` / `systemPrompt` / `conversationHistory`：模型、系统提示词和上下文。
- `workingDirectory`：运行时操作的仓库目录。
- `permissionMode`：映射为 plan / ask / code 等权限策略。
- `files`：IM 图片等附件。
- `allowedTools`、`sandboxMode`、`networkAccessEnabled`：控制工具、沙箱和网络。

关键点是：上层只消费统一的 SSE 事件，不关心底层是 SDK 还是 CLI。

统一事件主要包括：

- `text`：模型文本输出。
- `tool_use` / `tool_result`：工具调用及结果。
- `permission_request`：需要人工审批的工具请求。
- `status`：底层 session id、模型等状态。
- `result`：token usage、最终状态。
- `error`：运行时错误。

这让 Telegram、Discord、看板 agent 都能用同一套消息消费逻辑处理不同模型后端。

## Runner：把“用哪个后端”变成配置

运行时选择不是硬编码在业务流里，而是通过 `RunnerConfig` 配置：

```json
{
  "id": "codex-senior",
  "runtime": "codex",
  "label": "高级开发",
  "defaultModel": "gpt-5.2",
  "autoApprove": true,
  "codexUseLogin": true
}
```

一个 runner 可以声明：

- `runtime`：`claude`、`codex`、`cursor`、`copilot`。
- `defaultModel`：该 runner 默认模型。
- `defaultMode`：默认聊天模式。
- `autoApprove`：是否自动放行工具权限。
- `claudeExecutable` / `codexExecutable` / `cursorExecutable` / `copilotExecutable`：指定 CLI 路径。
- `claudeUseLogin` / `codexUseLogin`：使用本机 CLI 登录态，而不是 API key。
- `subprocessEnv`：给该 runner 注入额外环境变量。

IM 场景下，每个 bot 可以有自己的 runner 列表；聊天里通过 `/runner` 查看或切换。切换 runner 时，系统会重新创建会话并清空旧的 `sdkSessionId`，避免把 Claude 会话拿去给 Codex/Copilot 续聊。

看板场景下，项目可以把 lane 映射到 runner，例如：

- `agent-dev` -> Claude 开发 runner。
- `codex-senior` -> Codex 高级开发 runner。
- `claude-review` -> Claude 评审 runner。
- `copilot-test` -> Copilot 测试 runner。

## Claude 包装方式

Claude 是默认运行时，走 `@anthropic-ai/claude-agent-sdk` 的 `query()`。

包装重点：

- 使用 Claude Agent SDK 拉起 Claude Code 流。
- 将 SDK 消息转换为 bridge 标准 SSE。
- 支持 `claudeUseLogin`，可以使用本机 `claude auth login` 登录态。
- 在 strict env 模式下只透传白名单、`CTI_*` 和 `ANTHROPIC_*`。
- 对鉴权错误做分类，区分 CLI 未登录和 API key / token 错误。
- 通过 `PendingPermissions` 把工具调用审批桥接到 IM。

Claude 适合默认开发、代码评审、需要 Claude Code 工具链兼容的场景。

## Codex 包装方式

Codex 使用 `@openai/codex-sdk`，但不直接裸跑默认 CLI，而是通过 wrapper 控制启动行为：

```sh
exec codex --dangerously-bypass-approvals-and-sandbox "$@"
```

Provider 初始化时：

- 懒加载 `@openai/codex-sdk`，缺依赖时给出明确错误。
- 构造 `Codex` 实例，并传入 `codexPathOverride` 指向 wrapper。
- 根据 `codexUseLogin` 决定使用本机 `codex login`，还是 `CTI_CODEX_API_KEY` / `CODEX_API_KEY` / `OPENAI_API_KEY`。
- 支持 `CTI_CODEX_BASE_URL`。
- 使用 `startThread()` / `resumeThread()` 管理底层线程。
- 将 Codex 事件转换成统一 SSE：
  - `agent_message` -> `text`
  - `command_execution` -> `tool_use` + `tool_result`
  - `file_change` -> `tool_use` + `tool_result`
  - `mcp_tool_call` -> `tool_use` + `tool_result`
  - `turn.completed` -> `result`
  - `turn.failed` / `error` -> `error`

Codex 的权限策略由 bridge 的 `permissionMode` 和 runner 的 `autoApprove` 映射：

- `autoApprove=true` -> `on-failure`
- `plan` / `default` -> `on-request`
- `acceptEdits` -> `on-failure`

Codex 还处理了几个工程化细节：

- 图片附件会先写入临时文件，再作为 `local_image` 传给 SDK。
- 如果 resume 失败或 session/model 不匹配，会重试 fresh thread。
- 如果遇到 Claude 形态的模型名，会避免传给 Codex，降低跨运行时迁移错误。

## Copilot 包装方式

Copilot 不是 SDK 集成，而是直接 spawn GitHub Copilot CLI：

```text
copilot --output-format json --stream on|off [--yolo] [--add-dir cwd] [--model model] [--resume=id] -p prompt
```

包装重点：

- 用 `child_process.spawn()` 启动 `copilot`。
- 逐行读取 stdout 中的 JSON event。
- 将 Copilot 事件映射为标准 SSE：
  - `assistant.message_delta` / `assistant.message` -> `text`
  - `tool.execution_start` -> `tool_use`
  - `tool.execution_complete` -> `tool_result`
  - `result` -> `result`
- `autoApprove=true` 时传 `--yolo`。
- `workingDirectory` 映射为 `--add-dir` 和进程 `cwd`。
- 使用 `CTI_COPILOT_START_TIMEOUT_MS` 防止 CLI 长时间无输出卡死。
- 图片附件目前以 data URL 文本形式附加到 prompt，属于兼容 fallback。

Copilot 适合测试、验证、轻量 CLI 协作等场景；看板默认把 `copilot-test` 作为测试 lane。

## Cursor / Agent 包装方式

Cursor Provider 包装的是 Cursor 的 `agent` CLI：

```text
agent --print --output-format stream-json [--stream-partial-output] [--workspace cwd] [--model model] [--resume session] [--mode plan|ask] -- prompt
```

包装重点：

- 也是 spawn CLI，然后逐行解析 `stream-json`。
- 将 shell、文件编辑、读取、搜索、MCP 调用等事件映射为标准 `tool_use` / `tool_result`。
- `permissionMode=plan` 映射为 `--mode plan`。
- `permissionMode=default` 映射为 `--mode ask`。
- `autoApprove=true` 时增加 `--yolo --trust -f`。
- 如果没有显式 Cursor API key，会主动删除继承来的 `OPENAI_API_KEY`，避免错误 key 污染 Cursor CLI。

这里的 “agent” 有两层含义：

1. Cursor 的 `agent` CLI，是一种可被包装的运行时。
2. 项目里的 `AgentAdapter`，是一个 Redis 驱动的自循环 IM channel，用于让 Claude 和 OpenAI 兼容接口模型互相对话。

## Redis Agent Adapter：非人类 IM 通道

`AgentAdapter` 不是 Telegram/Discord，而是一个内部自动对话通道：

```text
Redis input queue
     │
     ▼
AgentAdapter -> Bridge Manager -> Claude/Runner
     │                         │
     │                         ▼
     └──── OpenAI Chat API <- Claude response
              │
              └── 再写回 Redis input queue
```

流程：

1. 启动时把 `firstPrompt` 写入 Redis input queue。
2. 轮询 Redis input queue，构造一条 `InboundMessage`。
3. 走标准 bridge 流程，让当前 LLMProvider 生成回复。
4. `send()` 时把 Claude/Runner 回复转发给 OpenAI Chat Completions 兼容接口。
5. OpenAI 回复再写回 Redis input queue。
6. 循环直到 `maxTurns`。

它支持单实例、数字实例和命名实例：

- `CTI_AGENT_REDIS_URL`
- `CTI_AGENT_1_REDIS_URL`
- `CTI_AGENT_MAIN_REDIS_URL`

本质上，它把“另一个 agent”伪装成一个 IM 用户，因此不需要改 bridge manager。

## Telegram Bot 集成

Telegram Adapter 的职责是把 Telegram Bot API 变成统一的 channel：

- 使用 long polling 拉取 `getUpdates`。
- 持久化 offset，处理完成后才 acknowledge，避免进程崩溃丢消息。
- 支持文本、caption、图片、图片组和文档图片。
- 使用 `allowed users` 或 `telegram_chat_id` 做默认拒绝式鉴权。
- 支持 callback query，用于工具审批按钮。
- 发送消息时支持 HTML parse mode 和 inline keyboard。
- 支持 streaming preview，通过 Telegram draft API 增量更新预览；不可用时自动降级。

Telegram 还有一个特殊能力：Hybrid Auto mode。

Hybrid 模式下，Telegram 是人类可见的前台界面，Redis 是 master/slave agent 的调度队列：

```text
Telegram 用户消息
      │
      ▼
Redis master input
      │
      ▼
Master runner 规划/审核
      │
      ▼
Redis slave input
      │
      ▼
Slave runner 执行工具
      │
      ▼
结果回到 Redis / Telegram
```

这让 Telegram 不只是聊天入口，也可以作为自动化 agent pipeline 的观察和控制台。

## Discord Bot 集成

Discord Adapter 使用 `discord.js v14`：

- 动态 import `discord.js`，避免 Next.js build 时解析 native optional dependency。
- 通过 Gateway 监听消息和 interaction。
- 支持 DM 和 Guild 频道。
- 用 `allowed users`、`allowed channels`、`allowed guilds` 做鉴权。
- Guild 中可配置必须 @mention bot 才处理。
- 注册 slash commands，并把 slash command 转成同样的 `/cmd` 文本交给 bridge manager。
- 支持按钮 interaction，用于审批回调。
- 支持 typing indicator。
- 支持 streaming preview：先发一条预览消息，再 edit，最终回复发送后删除预览。

Discord 的消息限制是 2000 字符，因此回复会走 Discord markdown chunker，保留代码块结构并分片发送。

## Bridge Manager：Bot 与 Runtime 的中间层

Bridge Manager 是核心编排器：

1. 读取 enabled channel，创建 adapter。
2. 启动 adapter 并进入消费循环。
3. 对 callback、slash command、权限快捷回复做轻量处理。
4. 对普通消息按 session 串行处理，避免同一会话并发打乱上下文。
5. 通过 `ChannelRouter` 把 `channelType + chatId` 映射到平台 session。
6. 调用 `conversation-engine.processMessage()`。
7. 将流式 partial text 发给 adapter 做 preview。
8. 将最终文本按平台格式渲染并发送。

常用命令由 Bridge Manager 统一处理：

- `/new [path]`：新建会话。
- `/cwd /path`：切换当前聊天绑定的工作目录。
- `/mode plan|code|ask`：切换权限/工作模式。
- `/runner [id|default]`：查看或切换当前聊天使用的 runner。
- `/status`：查看会话、目录、模式、模型、runner。
- `/sessions`：列出最近会话。
- `/stop`：中止当前运行。
- `/perm allow|allow_session|deny <id>`：审批工具请求。

因为命令层与 adapter 解耦，所以 Telegram 和 Discord 可以共享同一组命令语义。

## Conversation Engine：统一消费运行时流

Conversation Engine 做几件关键事情：

- 取得当前 session 和 channel binding。
- 持久化用户消息。
- 解析有效工作目录，旧目录不存在时回退到默认目录。
- 解析当前 runner、模型、权限模式和历史上下文。
- 根据 master/slave auto mode 注入额外 system prompt 和工具限制。
- 调用有效的 `LLMProvider.streamChat()`。
- 消费 SSE 流：
  - 文本累积为最终回复。
  - 工具调用保存为结构化 assistant message。
  - 权限请求立即转发到 IM，避免流阻塞死锁。
  - `status/result` 中的底层 session id 写回，用于续聊。
- 运行结束后保存 assistant message 和 token usage。

这里最重要的设计是：权限请求必须在流消费过程中立刻发到 IM，而不是等流结束后处理。因为底层 runtime 往往会等待审批结果，等流结束再发审批会形成死锁。

## 看板 Agent：从聊天机器人升级为交付流程

IM bridge 解决“人和 agent 怎么说话”；Kanban 平台解决“agent 怎么按任务交付”。

看板侧核心对象：

- `WorkflowService`：状态机、分支、PR、测试、回流。
- `InstanceManager`：启动/停止任务级 agent runner。
- `TaskAgentRunner`：轮询任务消息队列，调用 LLMProvider。
- `JsonPlatformStore`：持久化项目、Sprint、任务、实例、审批、agent turn。

状态到角色的映射大致是：

- `in_progress` -> developer
- `pre_testing` -> tester
- `review` -> reviewer
- `testing` / `regression_testing` -> tester
- `pending_release` / `pending_uat` / `closed` -> 不启动 agent

Lane 到默认 runtime 的映射：

- `agent-dev` -> Claude developer
- `codex-senior` -> Codex developer
- `claude-review` -> Claude reviewer
- `copilot-test` -> Copilot tester
- `pre-tester` -> Copilot tester

但最终 runtime 仍可被项目 lane runner 配置覆盖。

每个 agent turn 会记录：

- source agent
- target agent
- source agent response
- target agent prompt
- stream error

这就是 `/board/monitor` 能展示“哪个 agent 把什么交给了哪个 agent”的原因。

## 审批模型

审批在 IM bridge 和 Kanban 两侧都存在，模式一致：

```text
Runtime tool request
      │
      ▼
permission_request SSE
      │
      ▼
PendingPermissions / PendingApproval
      │
      ▼
Telegram inline button / Discord button / /perm command
      │
      ▼
resolve allow|allow_session|deny
      │
      ▼
Runtime stream 继续
```

不同通道差异：

- Telegram：inline keyboard + callback query。
- Discord：button interaction。
- Feishu/QQ：支持数字快捷键 `1/2/3`。
- 文本 fallback：`/perm allow|allow_session|deny <id>`。

## 为什么这个设计能扩展

这个项目的扩展点清晰分成三层：

1. 新 runtime：实现 `LLMProvider.streamChat()`，把底层事件映射成标准 SSE。
2. 新 IM：实现 `BaseChannelAdapter`，负责 `start/stop/consumeOne/send/isAuthorized/validateConfig`。
3. 新工作流：复用 runner、provider、审批、store，新增状态机和 prompt 即可。

因此 Codex、Claude、Copilot 的差异被压在 provider 内；Telegram、Discord 的差异被压在 adapter 内；业务流程只依赖统一抽象。

## 分享时建议强调的工程经验

- 不要让业务层直接依赖某个 CLI/SDK；先抽象成稳定流协议。
- CLI 包装比 API 调用更脆弱，必须处理超时、stderr、非 JSON 行、session 失效和进程退出。
- `sdkSessionId` 只能在同 runtime 内复用，跨 runtime 切换必须重建会话。
- 工具审批必须流内转发，否则容易死锁。
- IM Bot 默认应拒绝未授权用户/频道。
- 长输出需要平台级 chunking：Telegram 4096、Discord 2000。
- streaming preview 是体验优化，失败时必须可降级。
- 看板自动化不要只保存最终结果，要保存每轮 agent handoff，便于排错和复盘。

## 关键代码索引

- 统一运行时接口：`src/lib/bridge/host.ts`
- 运行时选择：`src/runtime-provider.ts`
- Claude Provider：`src/llm-provider.ts`
- Codex Provider：`src/codex-provider.ts`
- Codex wrapper：`scripts/codex-wrapper.sh`
- Copilot Provider：`src/copilot-provider.ts`
- Cursor Provider：`src/cursor-provider.ts`
- Runner 配置类型：`src/config-shared.ts`
- IM LLM registry：`src/lib/bridge/llm-registry.ts`
- Bridge Manager：`src/lib/bridge/bridge-manager.ts`
- Conversation Engine：`src/lib/bridge/conversation-engine.ts`
- Telegram Adapter：`src/lib/bridge/adapters/telegram-adapter.ts`
- Discord Adapter：`src/lib/bridge/adapters/discord-adapter.ts`
- Redis Agent Adapter：`src/lib/bridge/adapters/agent-adapter.ts`
- 看板 InstanceManager：`src/platform/instance-manager.ts`
- 看板 WorkflowService：`src/platform/workflow-service.ts`
- 看板 Agent 映射：`src/platform/kanban-agents.ts`
- Agent turn 监控记录：`src/platform/kanban-agent-turn.ts`
