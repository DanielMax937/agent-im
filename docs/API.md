# agent-im HTTP API 说明

本服务为 **Next.js 16** 应用：Kanban 平台、IM 桥接管理、Claude Code 会话桥接。生产环境默认 **`PORT=3300`**。

下文示例以 **`BASE=http://127.0.0.1:3300`** 为例；开发时若端口不同请替换。

---

## 目录

1. [基础](#1-基础)
2. [桥接目录与 config.env](#2-桥接目录与-configenv)
3. [Runner 列表](#3-runner-列表)
4. [桥接状态与启停](#4-桥接状态与启停)
5. [项目](#5-项目)
6. [覆盖率](#6-覆盖率)
7. [Sprint](#7-sprint)
8. [角色与 Runner 映射](#8-角色与-runner-映射)
9. [任务（创建 / 分配）](#9-任务创建--分配)
10. [任务工作流操作](#10-任务工作流操作)
11. [批量任务](#11-批量任务)
12. [实例管理](#12-实例管理)
13. [审批](#13-审批)
14. [Kanban 监控](#14-kanban-监控)
15. [桥接日志与监控](#15-桥接日志与监控)
16. [其它](#16-其它)
17. [环境变量（节选）](#17-环境变量节选)

---

## 1. 基础

| 用途 | 方法 | 路径 |
|------|------|------|
| 健康检查 | `GET` | `/health` |

**响应示例**：

```json
{ "ok": true, "bridge": { "running": true }, "runningInstances": [] }
```

---

## 2. 桥接目录与 `config.env`

桥接数据默认在 **`~/.claude-to-im/<桥接名>/`**（可用 `CTI_BASE` / `CTI_HOME` 覆盖）。Admin 页面与以下接口读写该目录下的 `config.env`。

### 2.1 拉取配置与桥列表

**`GET /api/local-config`**

| 响应字段 | 说明 |
|---------|------|
| `bridges` | 已发现的桥接目录名列表 |
| `configsByBridge` | 每个 slug 对应的配置（密钥字段已脱敏） |
| `daemonStatusByBridge` | 各桥的 daemon 状态（读 `status.json`） |
| `canSwitchBridges` | 未固定 `CTI_HOME` 时为 `true` |
| `config` / `configPath` / `ctiHome` | 当前活动桥的全局视图 |

### 2.2 新建桥接目录

**`POST /api/local-config`** Body：`{ "newBridge": true }`

在 `CTI_BASE` 下生成新目录与 slug，并写入 `.active_bridge`。若进程环境已固定 `CTI_HOME` 则拒绝。

**响应**：`{ "ok": true, "configPath": "...", "botName": "<新 slug>" }`

### 2.3 切换当前默认桥接

**`POST /api/local-config`** Body：`{ "switchBridge": "<slug>" }`

### 2.4 删除桥接目录

**`POST /api/local-config`** Body：`{ "deleteBridge": "<slug>" }`

### 2.5 保存 `config.env`

**`PUT /api/local-config`** Body：`Partial<Config>`（与 Admin 表单一致）

| 字段 | 说明 |
|------|------|
| `targetBridge` | 可选；写入指定桥的 `config.env` |
| `saveSlaveEnv` | `true` 时根据 `imBot.autoSlaveRunner` 生成 `config.slave.env` |

密钥类字段若传占位符，会保留磁盘上的旧值。

```bash
curl -sS -X PUT "$BASE/api/local-config" \
  -H "Content-Type: application/json" \
  -d '{"targetBridge":"kanban"}'
```

---

## 3. Runner 列表

**`GET /api/platform/runners`**

```json
{
  "runners": [
    { "id": "cursor", "label": "cursor", "runtime": "cursor" }
  ]
}
```

---

## 4. 桥接状态与启停

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/bridge/status?slug=<桥接名>` | 省略 `slug` 时使用当前活动桥 |
| `POST` | `/api/bridge/start` | 启动 bridge daemon |
| `POST` | `/api/bridge/stop` | 停止 bridge daemon |
| `POST` | `/api/bridge/auto-start` | 触发自动启动逻辑 |

Body（JSON）：`{ "slug": "<桥接名>" }`（省略时使用当前活动桥）

> 若已用 `scripts/daemon.sh` 或外部方式启动同一 `CTI_HOME`，与 Admin 启停可能冲突，需先停外部 daemon。

---

## 5. 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/projects` | 列出所有项目 |
| `POST` | `/api/projects` | 创建 / 更新项目（HTTP 201） |
| `GET` | `/api/projects/:projectId` | 获取单个项目 |
| `PUT` | `/api/projects/:projectId` | 更新项目（含 kanban roles/members/skills） |
| `DELETE` | `/api/projects/:projectId` | 删除项目 |
| `GET` | `/api/projects/:projectId/next-issue-id` | 预览下一个 issue 编号 |

**创建项目 Body（关键字段）**：

| 字段 | 说明 |
|------|------|
| `id` | 必填，唯一标识 |
| `name` | 必填 |
| `repository.remoteUrl` | 远程地址，如 `https://github.com/org/repo` |
| `repository.localPath` | 本机已克隆的仓库根目录 |
| `repository.baseBranch` | 默认分支，如 `main` |
| `repository.sprintBranchPrefix` | Sprint 分支前缀，如 `feature/` |
| `repository.taskBranchPrefix` | 任务分支前缀，如 `dev/` |
| `repository.scmProvider` | `github` \| `gitlab` |
| `repository.scmProject` | `owner/repo` |
| `isPrivate` | `true` 时启用 self-hosted CI runner 模式（私有仓库） |
| `requiresUat` | `true` 时在 regression 后插入 `pending_uat` 人工验收门 |
| `agents` | 必填（可为 `[]`） |

```bash
curl -sS -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "myproject",
    "name": "My Project",
    "repository": {
      "remoteUrl": "https://github.com/org/myproject",
      "localPath": "/Users/you/git/myproject",
      "baseBranch": "main",
      "sprintBranchPrefix": "feature/",
      "taskBranchPrefix": "dev/",
      "scmProvider": "github",
      "scmProject": "org/myproject"
    },
    "agents": [],
    "isPrivate": false
  }'
```

---

## 6. 覆盖率

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/projects/:projectId/coverage` | 获取当前最新覆盖率（初始为 0） |
| `POST` | `/api/projects/:projectId/coverage` | 更新覆盖率（仅当新值 > 已存值时写入） |
| `GET` | `/api/projects/:projectId/coverage/history?limit=20` | 获取覆盖率历史记录（最多 100 条） |

**GET 覆盖率响应**：

```json
{ "projectId": "myproject", "coverage": 83.5, "updated_at": "2026-04-01T10:00:00Z" }
```

**POST 更新覆盖率 Body**：

```json
{ "coverage": 85.2, "context": "sprint-3 regression pass" }
```

**POST 响应**：

```json
{ "updated": true, "previous": 83.5, "current": 85.2 }
```

> `updated: false` 表示新值不高于旧值，未写入。

---

## 7. Sprint

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sprints?projectId=<id>` | 列出 Sprint（可按项目过滤） |
| `GET` | `/api/sprints/:sprintId` | 获取单个 Sprint |
| `POST` | `/api/workflows/sprints/start` | 创建新 Sprint（HTTP 201） |

**创建 Sprint Body**：

```json
{
  "projectId": "myproject",
  "sprintName": "v1.0",
  "baseBranch": "main"
}
```

`baseBranch` 可省略，默认使用项目 `repository.baseBranch`。

**行为**：在 `repository.localPath` 下执行 Git 创建 sprint 分支（如 `feature/v1.0`）、`fetch`/`pull`/`push`（需本机仓库可用、网络与凭据正常）。

**响应**：`Sprint` 对象（含 `id`，后续创建任务需要）。

---

## 8. 角色与 Runner 映射

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/projects/:projectId/kanban-roles` | 获取 lane 角色配置 |
| `PUT` | `/api/projects/:projectId/kanban-roles` | 保存 lane 角色配置 |

**GET 响应字段**：

| 字段 | 说明 |
|------|------|
| `kinds` | 所有 lane 类型：`agent-dev`、`codex-senior`、`claude-review`、`copilot-test`、`pre-tester`、`self-host-runner` |
| `runners` | 与 `GET /api/platform/runners` 同源 |
| `mapping` | 每 lane 的默认 runner id |
| `members` | 每 lane 多人员与 runnerProfileId |

**PUT Body**（三者至少传其一）：

```json
{
  "kanbanRoleRunners": {
    "agent-dev": "cursor",
    "codex-senior": "cursor",
    "claude-review": "cursor",
    "copilot-test": "cursor",
    "pre-tester": "cursor",
    "self-host-runner": "cursor"
  },
  "kanbanRoleMembers": {
    "agent-dev": [],
    "codex-senior": [],
    "claude-review": [],
    "copilot-test": [],
    "pre-tester": [],
    "self-host-runner": []
  },
  "kanbanLaneSkills": {
    "agent-dev": [],
    "codex-senior": [],
    "claude-review": [],
    "copilot-test": [],
    "pre-tester": [],
    "self-host-runner": []
  }
}
```

---

## 9. 任务（创建 / 分配）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tasks?projectId=<id>` | 列出任务（可按项目过滤） |
| `GET` | `/api/tasks/:taskSessionId` | 获取单个任务 |
| `POST` | `/api/workflows/tasks/create` | 创建任务（HTTP 201，初始 `workflowState: todo`） |
| `POST` | `/api/workflows/tasks/assign` | 分配任务（从 todo 进入开发队列，HTTP 201） |
| `DELETE` | `/api/workflows/tasks/:taskSessionId` | 删除任务 |

**创建任务 Body**：

```json
{
  "projectId": "myproject",
  "sprintId": "<sprint-uuid>",
  "title": "实现用户登录功能",
  "issueId": "可选，省略则自动生成",
  "dependsOnIssueIds": [],
  "isHotfix": false
}
```

**分配任务 Body**：

```json
{
  "projectId": "myproject",
  "sprintId": "<sprint-uuid>",
  "issueId": "MYPROJECT-1",
  "taskSessionId": "<task-session-uuid>",
  "kanbanAgent": "agent-dev"
}
```

`kanbanAgent` 可选值：`agent-dev`、`codex-senior`。

---

## 10. 任务工作流操作

所有操作均为 `POST`，路径为 `/api/workflows/tasks/:taskSessionId/<action>`。

| Action | 说明 | Body |
|--------|------|------|
| `queue-message` | 手动向任务队列推送消息 | `{ "content": "..." }` |
| `comments` | 添加历史备注 | `{ "content": "...", "role": "developer" }` |
| `start-testing` | 开发完毕 → 进入预测试 (`in_progress → pre_testing`) | — |
| `start-feature-testing` | 预测试通过 → 进入功能测试 (`pre_testing → testing`) | — |
| `submit-review` | 测试通过 → 提交 PR 并进入 Review | `{ "commitMessage": "...", "prTitle": "...", "prBody": "..." }` |
| `reject-review` | Reviewer 打回 → 回开发 (`review → in_progress`) | `{ "comment": "..." }` |
| `sync-review-comment` | 同步 review 评论到 PR 和任务 | `{ "body": "..." }` |
| `start-regression` | 直接触发回归测试 | — |
| `regression/refresh` | 主分支有新合并时，重新拉取并刷新回归 | — |
| `testing/fail` | 测试失败上报 | `{ "summary": "...", "log": "..." }` |
| `proceed-to-release` | 回归通过 → `pending_release`（或 `pending_uat`） | — |
| `uat-approve` | UAT 通过 → `pending_release` | — |
| `uat-reject` | UAT 拒绝 → 回回归 | `{ "reason": "..." }` |
| `ci-result` | CI 回调（私有仓库 self-host-runner 专用） | `{ "status": "success"\|"failure", "reason": "...", "coverage": 85.2 }` |
| `block` | 阻塞任务 | `{ "reason": "..." }` |
| `unblock` | 解除阻塞 | — |
| `close` | 直接关闭任务 | — |
| `close-async` | 异步关闭（检查 PR 合并状态 + 覆盖率） | — |

### 任务状态流转

```
todo → pending_start → in_progress → pre_testing → testing → review
     → regression_testing → [pending_uat →] pending_release → closing → closed
```

所有节点均可 → `blocked`（人工干预后 `unblock` 回原状态）。

### CI 回调（私有仓库）

私有仓库（`isPrivate: true`）在 regression 阶段不启动 AI agent，而是等待 GitHub Actions 通过 webhook 回调：

```bash
curl -sS -X POST "$BASE/api/workflows/tasks/<taskSessionId>/ci-result" \
  -H "Content-Type: application/json" \
  -d '{ "status": "success", "coverage": 88.5 }'
```

- `status: "success"` → 任务进入 `pending_release`
- `status: "failure"` → 任务回到 `in_progress`（附 `reason`）
- `coverage` 可选；若提供，会更新项目覆盖率

---

## 11. 批量任务

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/workflows/tasks/batch-spec/preview` | 预览 LLM 规划的批量任务列表（不写库） |
| `POST` | `/api/workflows/tasks/batch-spec/create` | 根据批量计划创建所有任务（HTTP 201） |
| `POST` | `/api/workflows/board-brainstorm/chat` | 高级开发 brainstorm 对话（SSE 流式响应） |

**batch-spec Body 示例**：

```json
{
  "projectId": "myproject",
  "sprintId": "<sprint-uuid>",
  "spec": "实现完整的用户认证系统，包含注册、登录、JWT refresh"
}
```

---

## 12. 实例管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/instances` | 列出所有 agent 实例 |
| `POST` | `/api/instances` | 创建实例 |
| `GET` | `/api/instances/:instanceId` | 获取实例 |
| `POST` | `/api/instances/:instanceId/start` | 启动实例 |
| `POST` | `/api/instances/:instanceId/stop` | 停止实例 |
| `DELETE` | `/api/instances/:instanceId` | 删除实例 |
| `POST` | `/api/instances/reconcile` | 对账：确保运行中的实例与数据库一致 |

**创建实例 Body**：

```json
{
  "taskSessionId": "<uuid>",
  "role": "developer",
  "runtimeProfileId": "cursor"
}
```

---

## 13. 审批

当 agent 执行需要权限确认的操作时，会挂起并创建审批请求。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/approvals?taskSessionId=<id>` | 列出待审批（可按任务过滤） |
| `GET` | `/api/approvals/:approvalId` | 获取审批详情 |
| `POST` | `/api/approvals/:approvalId` | 解析审批（通过/拒绝） |

---

## 14. Kanban 监控

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/kanban/monitor` | 列出 agent turn 记录 |
| `GET` | `/api/kanban/monitor/:turnId` | 获取单条 turn 详情（含完整 prompt/response） |
| `GET` | `/api/kanban/status` | 当前运行中的 Kanban 任务状态汇总 |

**monitor 查询参数**：`projectId`、`taskId`、`taskSessionId`、`limit`、`offset`

---

## 15. 桥接日志与监控

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/bridge/logs?source=daemon&lines=200` | 读取 bridge 日志尾部 |
| `GET` | `/api/monitor/responses?bridge=<slug>` | 读取 master/slave 监控消息（省略 slug 则合并所有桥） |
| `GET` | `/api/structure` | 目录结构规划（DIRECTORY_STRUCTURE_PLAN） |
| `GET` | `/api/skills/catalog` | 技能目录列表 |

`source` 可选 `daemon`（默认）或 `app`。

---

## 16. 其它

### 本地配置（Bridge Admin 专用）

`GET|PUT|POST /api/local-config` 由 `src/app/api/local-config/route.ts` 独立处理，不经过平台容器。

### 所有路由注册位置

- **平台路由**：`src/platform/app.ts`（经 `src/app/api/[[...slug]]/route.ts` 进入）
- **本地配置**：`src/app/api/local-config/route.ts`
- **健康检查**：`src/app/health/route.ts`

---

## 17. 环境变量（节选）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CTI_HOME` | 桥接数据目录（覆盖 CTI_BASE+CTI_BOT_NAME） | — |
| `CTI_BOT_NAME` | 桥接 slug | — |
| `CTI_BASE` | 桥接根目录 | `~/.claude-to-im` |
| `CTI_KANBAN_PLATFORM_DIR` | SQLite 数据库目录；`cti-home` 表示 `$CTI_HOME/data/platform` | `./data/platform` |
| `CTI_KANBAN_WORKFLOW_AUTO` | 设为 `0` 禁用 KANBAN_ACTION 自动推进 | 启用 |
| `CTI_KANBAN_USE_WORKTREE` | 设为 `0` 禁用 git worktree | 启用 |
| `CTI_KANBAN_TELEGRAM_BOT_TOKEN` | Kanban 通知 bot token | — |
| `CTI_KANBAN_TELEGRAM_CHAT_ID` | Kanban 通知 chat ID | — |
| `PORT` | HTTP 服务端口 | `3300` |
| `CTI_AUTO_REVIEW_MAX_LOOPS` | Auto 模式最大 master→slave 评审轮次 | `5` |
| `CTI_AUTO_COVERAGE_COMMAND` | 覆盖率运行命令（Auto 模式覆盖率门） | — |
| `CTI_AUTO_COVERAGE_MIN_PCT` | 最低覆盖率百分比 | — |

完整变量列表见 `.env.example`、`config.env.example` 及 `docs/codebase.md`。

## 18. 日志与运维

- 运行时桥接日志：**`$CTI_HOME/logs/`**（`bridge.log`、`bridge-daemon.log`）—— 详见 `docs/LOGS.md`
- 构建 + PM2 启动：`./start-bg.sh`
- 停止：`./stop-bg.sh`
- 桥接 daemon：`scripts/daemon.sh`
