# agent-im

面向研发团队的 AI 工程工作流平台，融合 Kanban 编排、自动化 agent 接力执行，以及 IM 原生协作。

[English](README.md)

## 产品定位

`agent-im` 不只是一个 IM bridge，也不只是一个 Kanban 面板。

它更准确的定位是一个 **以任务为单位运行的 AI 交付平台**：

- **Kanban 是执行层**：任务状态变化会触发真实的执行，而不是只改一列状态
- **Auto 是工作流自动推进**：开发、评审、测试 agent 会按阶段接力
- **IM 是协作界面**：Telegram、Discord、飞书/Lark、QQ 成为审批、跟进、追踪的操作台
- **Git / PR 流程仍是主干**：分支、评审、测试、合并、发布都围绕现有仓库流程展开

一句话描述：

> 让 AI 像工程团队成员一样，在看板里接任务、在代码仓库里执行、在 IM 里协作汇报。

## 它解决什么问题

传统任务工具大多只负责“记录工作”。

`agent-im` 的目标是把任务真正 **往前推进**。

当任务被创建并分配后，平台可以：

- 创建 Sprint 分支和任务分支
- 拉起开发 agent 开始执行
- 进入评审流并自动切换 reviewer
- 进入测试和回归测试
- 将失败反馈打回开发队列
- 在任务关闭后停止相关实例

## 当前能力

这个产品目前由三套能力组成，并且已经打通：

1. **Kanban 工作流引擎**
   支持 `Todo -> In Progress -> Review -> Testing -> Closed` 主流程，也支持 `pre_testing`、`regression_testing`、`pending_uat`、`pending_release`、`blocked` 等中间状态。

2. **Agent 自动执行层**
   按任务阶段调起不同角色的运行器：
   - developer
   - reviewer
   - tester

3. **IM bridge 与审批层**
   连接 Telegram、Discord、飞书/Lark、QQ，让人类在消息界面中分配工作、审批工具调用、查看进展、接收异常和结果。

## 核心价值

这个项目最重要的不是“能在 IM 里和 AI 聊天”，而是：

**把 AI 接进真实的软件交付流程。**

也就是说，它不是聊天机器人外壳，而是一层任务驱动的执行系统，连接：

- 任务
- Git 仓库
- 分支
- PR / MR
- 测试
- 人工审批
- IM 协作

## 整体架构

```text
Web UI / IM channels
        |
        v
Next.js platform server
  - workflow APIs
  - approval APIs
  - project / sprint / task queries
        |
        v
Platform services
  - WorkflowService
  - InstanceManager
  - GitService / SCM client
  - platform persistence
        |
        v
Claude / Codex / Cursor / Copilot runtimes
```

主要入口包括：

- **Web UI**
  - `/admin`：桥接与运行器配置
  - `/projects`：项目管理
  - `/board`：任务看板
  - `/board/monitor`：lane / turn 监控
- **HTTP API**
  - 项目、Sprint、任务、实例、审批、覆盖率、bridge 管理接口
- **独立 bridge daemon**
  - 负责 IM 适配器和持久化聊天会话

## 产品能力拆解

### 1. Kanban 不只是展示，而是执行

项目定义：

- 仓库位置
- 分支策略
- SCM 提供商
- lane 到 runner 的映射
- 可选部署、覆盖率、UAT 要求

每个 Sprint / Task 会形成可持久化的执行上下文，包含：

- workflow state
- branch / worktree
- conversation history
- approval queue
- per-task message queue
- active agent instances

### 2. 多 agent 自动接力

平台会根据状态驱动不同角色执行：

- **开发 lane**：从任务分配开始，在任务分支上工作
- **评审 lane**：提交 review 后接管
- **测试 lane**：先验证任务分支，再验证合并后的集成分支
- **补偿 / 回流机制**：测试失败或评审打回时，将问题重新送回开发
- **升级 lane**：多轮 review pushback 后，可切换到更高阶 runner

### 3. IM 原生协作

bridge 层当前支持：

- Telegram
- Discord
- 飞书 / Lark
- QQ
- 基于 Redis 的 autonomous / hybrid channel

人在 IM 中可以：

- 直接与运行中的 runtime 对话
- 接收流式输出
- 批准或拒绝工具调用
- 查看工作流进展
- 接收评审、测试、失败回流通知

### 4. 统一运行时抽象

平台可以在同一套任务模型下切换不同后端：

- Claude
- Codex
- Cursor
- Copilot

这意味着 runner 选择是项目配置问题，而不是产品分叉问题。

## 典型工作流

1. 创建一个项目，并指向本地 Git 仓库。
2. 从基础分支启动一个 Sprint。
3. 创建或分配一个任务。
4. 平台创建任务分支，并拉起开发 lane。
5. 提交后自动进入 review 流程。
6. 测试和回归测试按顺序推进。
7. 失败则回流开发；成功则进入发布/关闭。

## API 概览

代表性接口：

- `GET /health`
- `GET /api/projects`
- `GET /api/sprints`
- `GET /api/tasks`
- `GET /api/instances`
- `GET /api/approvals`
- `GET /api/bridge/status`
- `POST /api/projects`
- `POST /api/workflows/sprints/start`
- `POST /api/workflows/tasks/create`
- `POST /api/workflows/tasks/assign`
- `POST /api/workflows/tasks/:taskSessionId/submit-review`
- `POST /api/workflows/tasks/:taskSessionId/start-testing`
- `POST /api/workflows/tasks/:taskSessionId/testing/fail`
- `POST /api/workflows/tasks/:taskSessionId/close`
- `POST /api/bridge/start`
- `POST /api/bridge/stop`

完整接口文档见：[docs/API.md](docs/API.md)

## 快速开始

### 前置要求

- Node.js `>=22.5.0`
- 一个希望由平台操作的本地 Git 仓库
- 至少安装并配置一种 runtime：
  - Claude CLI / Claude Agent SDK 流程
  - Codex CLI / SDK
  - 如有使用，也可以接入 Cursor 或 Copilot runner

### 安装依赖

```bash
npm install
```

### 启动 Web 平台

```bash
npm run dev
```

默认本地入口：

- Web UI：`http://127.0.0.1:3000`
- 健康检查：`http://127.0.0.1:3000/health`

### 启动独立 bridge daemon

```bash
npm run dev:bridge
```

### 构建

```bash
npm run build
```

### 测试

```bash
npm test
npm run typecheck
```

## 数据与持久化

Bridge 数据保存在 `~/.claude-to-im/...` 下，主要包含：

- IM sessions
- bindings
- permissions
- messages
- logs
- runtime status

平台数据单独存储，主要持久化：

- projects
- sprints
- task sessions
- agent instances
- task queues
- approvals
- monitor rows

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/main.ts` | 独立 bridge daemon 入口 |
| `src/platform/app.ts` | 平台共享 HTTP 路由 |
| `src/platform/container.ts` | store、runtime、workflow 服务装配 |
| `src/platform/workflow-service.ts` | Kanban 工作流状态机 |
| `src/platform/instance-manager.ts` | runtime 实例生命周期管理 |
| `src/platform/json-platform-store.ts` | 平台持久化层 |
| `src/lib/bridge/bridge-manager.ts` | IM bridge 编排核心 |
| `src/app/page.tsx` | Next.js 首页 |

## 安全

- 凭据保留在本地
- 日志写入前会做密钥脱敏
- 工具权限可以保持显式审批
- 每个任务的队列相互隔离
- 不同 runtime 后端通过统一工作流层接入

详见：[SECURITY.md](SECURITY.md)

## 相关文档

- [项目理解 / 代码导览](docs/PROJECT-UNDERSTANDING.md)
- [HTTP API](docs/API.md)
- [日志位置与查看方式](docs/LOGS.md)
- [Bridge 架构](src/lib/bridge/ARCHITECTURE.md)
- [安全说明](SECURITY.md)

## 许可

[MIT](LICENSE)
