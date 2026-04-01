# agent-im HTTP API 说明

本服务为 **Next.js 16** 应用：Kanban 平台、IM 桥接管理、Claude Code 会话桥接。生产环境默认 **`PORT=3300`**。

## 基础地址

| 用途 | 路径 |
|------|------|
| 健康检查 | `GET /health` |
| 本机桥接与配置（读写 `config.env`） | `GET` / `PUT` / `POST` → `/api/local-config` |
| 桥接日志 tail | `GET /api/bridge/logs?source=app\|daemon&lines=N` |
| 桥接状态 | `GET /api/bridge/status`（可选 `?slug=<桥接目录名>`） |
| 桥接启停 | `POST /api/bridge/start`、`POST /api/bridge/stop`（JSON body: `{ "slug": "<桥接名>" }`） |

## 平台与看板（经 `/api/*` 转发）

业务路由由 `src/platform/app.ts` 注册，经 `src/app/api/[[...slug]]/route.ts` 进入平台容器。常见前缀：

- **项目 / 任务**：`/api/projects`、`/api/projects/:projectId`、`/api/tasks`、`/api/sprints` …
- **工作流**：`/api/workflows/tasks/*`、`/api/workflows/sprints/start` …
- **Kanban 监控**：`/api/kanban/monitor`、`/api/kanban/status`
- **实例**：`/api/instances`、`/api/instances/:id/start|stop`
- **Runner / 技能**：`/api/platform/runners`、`/api/skills/catalog`

完整列表以代码为准；开发时可结合 `npm run dev` 与浏览器 Network 面板查看。

## 环境变量（节选）

- **`CTI_HOME` / `CTI_BOT_NAME`**：桥接数据目录（见仓库说明与 `docs/LOGS.md`）。
- **Kanban / Telegram**：见根目录 `.env.example` 与 `config.env.example`。

## 日志

运行时日志目录：`$CTI_HOME/logs/`（`bridge.log`、`bridge-daemon.log`）。详见 `docs/LOGS.md`。

## 相关脚本（local-service）

- **启动**：`./start-bg.sh`（`npm run build` + PM2 `agent-im`）
- **停止**：`./stop-bg.sh`
