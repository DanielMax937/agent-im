# Claude-to-IM 接口文档

本文档描述 Claude-to-IM 技能的命令接口、配置项及桥接扩展接口。本项目为后台守护进程，不暴露 HTTP REST API。

---

## 一、技能命令接口

在 Claude Code 或 Codex 中通过 `/claude-to-im <subcommand>` 或自然语言调用。

| 子命令 | 说明 | 示例 |
|--------|------|------|
| `setup` | 交互式配置向导 | `claude-to-im setup`、`配置`、`帮我连接 Telegram` |
| `start` | 启动桥接守护进程 | `start bridge`、`启动桥接` |
| `stop` | 停止桥接守护进程 | `stop bridge`、`停止桥接` |
| `status` | 查看运行状态 | `bridge status`、`状态` |
| `logs [N]` | 查看最近 N 行日志（默认 50） | `查看日志`、`logs 200` |
| `reconfigure` | 修改配置 | `修改配置`、`换个 bot` |
| `doctor` | 诊断问题 | `诊断`、`没反应了`、`出问题了` |

### 命令行为

- **setup**：逐步收集 channel、token、working directory 等，生成 `~/.claude-to-im/config.env`
- **start**：执行 `scripts/daemon.sh start`，需先存在 config.env
- **stop**：执行 `scripts/daemon.sh stop`
- **status**：执行 `scripts/daemon.sh status`，返回 PID、runId、channels
- **logs**：执行 `scripts/daemon.sh logs N`
- **reconfigure**：读取当前配置，交互修改并写回
- **doctor**：执行 `scripts/doctor.sh`，检查 SDK、构建、config 等

---

## 二、配置 schema

配置文件路径：`~/.claude-to-im/config.env`。以下为所有支持的键及说明。

### 通用

| 变量 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `CTI_RUNTIME` | enum | 否 | `claude` \| `codex` \| `cursor` \| `auto`，默认 `claude` |
| `CTI_ENABLED_CHANNELS` | string | 是 | 逗号分隔：`telegram,discord,feishu,qq` |
| `CTI_DEFAULT_WORKDIR` | string | 否 | 默认工作目录 |
| `CTI_DEFAULT_MODE` | string | 否 | `code` \| `plan` \| `ask`，默认 `code` |
| `CTI_PROXY` | string | 否 | HTTP 代理，如 `http://127.0.0.1:7890` |

### Claude

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_CLAUDE_CODE_EXECUTABLE` | string | Claude CLI 可执行文件路径 |

### Codex

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_CODEX_API_KEY` | string | Codex API Key |
| `CTI_CODEX_BASE_URL` | string | 自定义 API 地址 |
| `CTI_CODEX_USE_LOGIN` | bool | 使用 `codex auth login` 的 token |

### Cursor

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_CURSOR_API_KEY` | string | Cursor API Key |
| `CTI_CURSOR_BASE_URL` | string | 自定义 API 地址 |
| `CTI_CURSOR_MODEL` | string | 模型，如 `composer-1.5` |
| `CTI_CURSOR_EXECUTABLE` | string | Cursor CLI 路径，默认 `agent` |

### Telegram

| 变量 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `CTI_TG_BOT_TOKEN` | string | 是 | Bot Token |
| `CTI_TG_CHAT_ID` | string | 条件 | 至少与 ALLOWED_USERS 之一 |
| `CTI_TG_ALLOWED_USERS` | string | 条件 | 逗号分隔 user_id |

### Discord

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_DISCORD_BOT_TOKEN` | string | Bot Token |
| `CTI_DISCORD_ALLOWED_USERS` | string | 逗号分隔 |
| `CTI_DISCORD_ALLOWED_CHANNELS` | string | 逗号分隔 |
| `CTI_DISCORD_ALLOWED_GUILDS` | string | 逗号分隔 |

### Feishu / Lark

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_FEISHU_APP_ID` | string | 应用 ID |
| `CTI_FEISHU_APP_SECRET` | string | 应用密钥 |
| `CTI_FEISHU_DOMAIN` | string | 如 `https://open.feishu.cn` |
| `CTI_FEISHU_ALLOWED_USERS` | string | 逗号分隔 |

### QQ

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_QQ_APP_ID` | string | QQ 机器人 App ID |
| `CTI_QQ_APP_SECRET` | string | App Secret |
| `CTI_QQ_ALLOWED_USERS` | string | 逗号分隔 user_openid |
| `CTI_QQ_IMAGE_ENABLED` | bool | 是否支持图片，默认 true |
| `CTI_QQ_MAX_IMAGE_SIZE` | number | 图片最大 MB，默认 20 |

### 权限

| 变量 | 类型 | 说明 |
|------|------|------|
| `CTI_AUTO_APPROVE` | bool | 自动批准所有工具权限（仅可信环境） |

---

## 三、桥接 Host 接口（扩展用）

桥接模块通过以下接口与宿主应用解耦。实现这些接口即可集成桥接能力。详见 `src/lib/bridge/host.ts`。

### BridgeStore

持久化层：会话、绑定、消息、设置等。

| 方法 | 说明 |
|------|------|
| `getSetting(key)` | 读取配置项 |
| `getChannelBinding(channelType, chatId)` | 获取频道绑定 |
| `upsertChannelBinding(data)` | 创建或更新频道绑定 |
| `getSession(id)` | 获取会话 |
| `createSession(...)` | 创建会话 |
| `addMessage(sessionId, role, content)` | 添加消息 |
| `getMessages(sessionId)` | 获取消息列表 |
| `acquireSessionLock(...)` | 获取会话锁 |
| `insertPermissionLink(link)` | 插入权限链接 |
| `resolvePermissionLink(...)` | 解析权限 |

### LLMProvider

LLM 流式调用。

| 方法 | 说明 |
|------|------|
| `streamChat(params)` | 返回 `ReadableStream<string>`（SSE 格式） |

参数包括：`prompt`、`sessionId`、`model`、`systemPrompt`、`workingDirectory`、`abortController`、`files` 等。

### PermissionGateway

权限决议。

| 方法 | 说明 |
|------|------|
| `resolvePendingPermission(id, resolution)` | 解析待决权限，`resolution: { behavior: 'allow'|'deny'; message? }` |

### LifecycleHooks

生命周期钩子。

| 钩子 | 说明 |
|------|------|
| `onBridgeStart?()` | 桥接启动时调用 |
| `onBridgeStop?()` | 桥接停止时调用 |

---

## 四、运行时状态

- **PID 文件**：`~/.claude-to-im/runtime/daemon.pid`
- **状态文件**：`~/.claude-to-im/runtime/status.json`（running、pid、runId、channels）
- **日志**：`~/.claude-to-im/logs/bridge.log`

---

## 五、相关文档

- [setup-guides.md](./setup-guides.md) — 各平台配置步骤
- [token-validation.md](./token-validation.md) — Token 校验命令
- [troubleshooting.md](./troubleshooting.md) — 故障排查
- [src/lib/bridge/ARCHITECTURE.md](../src/lib/bridge/ARCHITECTURE.md) — 架构说明
