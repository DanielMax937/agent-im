# agent-im HTTP API 说明

本服务为 **Next.js 16** 应用：Kanban 平台、IM 桥接管理、Claude Code 会话桥接。生产环境默认 **`PORT=3300`**。

下文示例以 **`BASE=http://127.0.0.1:3300`** 为例；开发时若端口不同请替换。

---

## 1. 基础

| 用途 | 方法 | 路径 |
|------|------|------|
| 健康检查 | `GET` | `/health` |

**响应示例**：`{ "ok": true, "bridge": { ... }, "runningInstances": [ ... ] }`

---

## 2. 桥接目录与 `config.env`（`/api/local-config`）

桥接数据默认在 **`~/.claude-to-im/<桥接名>/`**（可用 **`CTI_BASE`** / **`CTI_HOME`** 覆盖）。Admin 与下列接口读写该目录下的 **`config.env`**。

### 2.1 拉取配置与桥列表

**`GET /api/local-config`**

**响应（节选）**：

| 字段 | 说明 |
|------|------|
| `bridges` | 已发现的桥接目录名列表 |
| `configsByBridge` | 每个 slug 对应的配置（已脱敏字段见 `secretFieldsByBridge`） |
| `daemonStatusByBridge` | 各桥磁盘上的 daemon 状态（`status.json`） |
| `canSwitchBridges` | 是否允许多桥切换（未设置固定 `CTI_HOME` 时为 `true`） |
| `config` / `configPath` / `ctiHome` | 当前「活动」桥的全局视图 |

### 2.2 新建桥接目录

**`POST /api/local-config`**  
**Body（JSON）**：`{ "newBridge": true }`

**说明**：在 `CTI_BASE` 下生成新目录与 slug，并写入 `.active_bridge`。**若进程环境已固定 `CTI_HOME`**，接口会拒绝（需用文件系统手动建目录）。

**成功响应**：`{ "ok": true, "configPath": "...", "botName": "<新 slug>" }`

### 2.3 切换当前默认桥接

**`POST /api/local-config`**  
**Body**：`{ "switchBridge": "<slug>" }`

### 2.4 删除桥接目录

**`POST /api/local-config`**  
**Body**：`{ "deleteBridge": "<slug>" }`

### 2.5 保存 `config.env`（含 Runner / IM Bot）

**`PUT /api/local-config`**

**Body**：`Partial<Config>` 与 Admin 表单一致，且：

| 字段 | 说明 |
|------|------|
| `targetBridge` | **可选**。若填写，则写入 **`$CTI_BASE/<targetBridge>/config.env`**；保存后会把该桥的 `imBot.id` 设为与 slug 一致。 |
| `saveSlaveEnv` | 若为 `true`，根据当前 `imBot.autoSlaveRunner` 生成 **`config.slave.env`**（需已配置 Auto 从机）。 |

**说明**：

- **Runner** 体现在配置里的 **`runners`**、**`imBot.runners`**、**`defaultRunnerId`**、**`CTI_DEFAULT_RUNNER`** 等字段，与 Admin「桥接」表单一致；具体合并规则见 `mergeConfigPatch`（`src/config.ts`）。
- 密钥类字段若传占位符，会保留磁盘上的旧值。

**仅触发重写当前磁盘配置（不改字段）**：可对目标桥发送最小 body，例如：

```bash
curl -sS -X PUT "$BASE/api/local-config" \
  -H "Content-Type: application/json" \
  -d '{"targetBridge":"kanban"}'
```

**成功**：`{ "ok": true, "configPath": "/path/to/.../config.env" }`

---

## 3. Runner 列表（与 `config.env` 一致）

平台 Kanban / 分配任务使用的 runner 来自 **当前进程** `loadConfig()` 解析出的 **`CTI_RUNNERS` / `imBot.runners`**（与 Admin、桥接使用同一套配置源）。

**`GET /api/platform/runners`**

**响应示例**：

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
| `GET` | `/api/bridge/status?slug=<桥接名>` | 可选 `slug`；省略时使用当前活动桥。 |
| `POST` | `/api/bridge/start` | 启动该桥 daemon（由 Next 子进程拉起或你本机已用 `daemon.sh`）。 |
| `POST` | `/api/bridge/stop` | 停止（若由本进程托管则杀子进程；否则按 PID 文件尝试 `SIGTERM`）。 |

**Body（JSON）**：

```json
{ "slug": "bridge-mndzhev9-b35729a5" }
```

`slug` 省略时行为与未传一致（依赖当前 `CTI_HOME` 解析）。

**说明**：若已用 **`scripts/daemon.sh`** 或外部方式启动同一 `CTI_HOME`，与 Admin 启停可能冲突，需先停外部 daemon。

---

## 5. 项目（创建 / 查询）

### 5.1 列出项目

**`GET /api/projects`**

### 5.2 创建或更新项目

**`POST /api/projects`**  
**Body**：`Project` JSON（与 `/projects` 页面保存一致）。必填字段包括 **`id`**、**`name`**、**`repository`**、**`agents`**（可为 `[]`）。

**`repository` 常用字段**：

| 字段 | 说明 |
|------|------|
| `remoteUrl` | 远程地址，如 `https://github.com/org/repo` |
| `localPath` | **本机已克隆的仓库根目录**（勿填 `git@` / `https` 到 localPath） |
| `baseBranch` | 默认分支，如 `main` |
| `sprintBranchPrefix` | Sprint 分支前缀，如 `feature/` |
| `taskBranchPrefix` | 任务分支前缀，如 `dev/` |
| `scmProvider` | `github` \| `gitlab` |
| `scmProject` | `owner/repo` |

**示例**：

```bash
curl -sS -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "dailywork",
    "name": "dailywork",
    "repository": {
      "remoteUrl": "https://github.com/DanielMax937/dailywork",
      "localPath": "/Users/you/Desktop/git/dailywork",
      "baseBranch": "main",
      "sprintBranchPrefix": "feature/",
      "taskBranchPrefix": "dev/",
      "scmProvider": "github",
      "scmProject": "DanielMax937/dailywork"
    },
    "agents": []
  }'
```

**成功**：HTTP `201`。

### 5.3 单个项目

**`GET /api/projects/:projectId`**

### 5.4 预览下一 issue 编号

**`GET /api/projects/:projectId/next-issue-id`**

---

## 6. Sprint（创建迭代）

**`POST /api/workflows/sprints/start`**

**Body**：

```json
{
  "projectId": "dailywork",
  "sprintName": "init",
  "baseBranch": "main"
}
```

`baseBranch` 可省略，默认使用项目 `repository.baseBranch`。

**行为摘要**：在 **`repository.localPath`** 下执行 Git 创建 sprint 分支（如 `feature/init`）、`fetch`/`pull`/`push` 等（需本机仓库可用、网络与凭据正常）。

**成功**：HTTP `201`，响应体为 `Sprint` 对象（含 **`id`**，后续创建任务需要）。

---

## 7. 角色与 Runner（Kanban lane 映射）

### 7.1 读取

**`GET /api/projects/:projectId/kanban-roles`**

**响应（节选）**：

| 字段 | 说明 |
|------|------|
| `kinds` | 固定四类 lane：`agent-dev`、`codex-senior`、`claude-review`、`copilot-test` |
| `runners` | 与 **`GET /api/platform/runners`** 同源 |
| `mapping` | 每 lane 的默认 runner id（`kanbanRoleRunners`） |
| `members` | 每 lane 多人员与 `runnerProfileId` |

### 7.2 保存

**`PUT /api/projects/:projectId/kanban-roles`**

**Body**：

```json
{
  "kanbanRoleRunners": {
    "agent-dev": "cursor",
    "codex-senior": "cursor",
    "claude-review": "cursor",
    "copilot-test": "cursor"
  },
  "kanbanRoleMembers": {
    "agent-dev": [],
    "codex-senior": [],
    "claude-review": [],
    "copilot-test": []
  },
  "kanbanLaneSkills": {
    "agent-dev": [],
    "codex-senior": [],
    "claude-review": [],
    "copilot-test": []
  }
}
```

三者至少传其一；runner id 必须存在于当前 **`GET /api/platform/runners`**。持久化在平台库 **`data/platform/platform.db`** 的 `projects` 表中（JSON `payload`）。

---

## 8. 任务：创建（待办）

**`POST /api/workflows/tasks/create`**

**Body**：

```json
{
  "projectId": "dailywork",
  "sprintId": "<sprint-uuid>",
  "title": "添加一个test.txt",
  "issueId": "可选，省略则自动生成"
}
```

**成功**：返回 `TaskSession`，初始 **`workflowState`: `todo`**。

---

## 9. 任务：分配（开发 lane / 从待办进入队列）

**`POST /api/workflows/tasks/assign`**

从 **待办** 卡片进入开发时，应传 **`taskSessionId`** + **`kanbanAgent`**（与看板「分配并启动 runner」一致）。

**Body**：

```json
{
  "projectId": "dailywork",
  "sprintId": "<sprint-uuid>",
  "issueId": "DAILYWORK-1",
  "taskSessionId": "<task-session-uuid>",
  "kanbanAgent": "agent-dev"
}
```

**说明**：

- **`kanbanAgent`** 从待办分配时支持 **`agent-dev`**、**`codex-senior`**（见 `assignFromTodo`）。
- 若任务仍在 **`todo`**，勿用「旧版」仅传 `issueId`+`title`+`runtime` 的路径创建重复卡；须带 **`taskSessionId`**。

**成功**：HTTP `201`，任务进入 **`pending_start` / `in_progress`**（视依赖与队列而定）。

---

## 10. 其它（索引）

业务路由由 `src/platform/app.ts` 注册，经 `src/app/api/[[...slug]]/route.ts` 进入平台容器。还可包含：

- **任务全生命周期**：`/api/workflows/tasks/:taskSessionId/submit-review`、`start-testing`、`reject-review` 等（见代码中 `matchPath`）。
- **桥接日志**：`GET /api/bridge/logs?source=app|daemon&lines=N`
- **技能目录**：`GET /api/skills/catalog`
- **实例**：`/api/instances` …

完整列表以 **`src/platform/app.ts`** 为准。

---

## 11. 环境变量（节选）

- **`CTI_HOME` / `CTI_BOT_NAME` / `CTI_BASE`**：桥接数据目录（见仓库说明与 `docs/LOGS.md`）。
- **Kanban 平台库**：默认 **`./data/platform/platform.db`**；可用 **`CTI_KANBAN_PLATFORM_DIR`** 覆盖（`cti-home` 表示 `$CTI_HOME/data/platform`）。
- **Kanban / Telegram**：见根目录 **`.env.example`** 与桥接 **`config.env.example`**。

## 12. 日志

运行时桥接日志目录：**`$CTI_HOME/logs/`**（`bridge.log`、`bridge-daemon.log`）。详见 **`docs/LOGS.md`**。

## 13. 运维脚本（仓库根目录）

- **构建 + PM2 启动**：`./start-bg.sh`
- **停止**：`./stop-bg.sh`
- **桥接**：`scripts/daemon.sh`、`scripts/start-bg-and-bridge-mndzhev9-b35729a5.sh` 等（见 `scripts/`）
