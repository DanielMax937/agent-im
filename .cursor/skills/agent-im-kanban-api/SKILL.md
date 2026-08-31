---
name: agent-im-kanban-api
description: >-
  Calls the local agent-im Kanban HTTP API (projects, sprints, tasks create/assign,
  kanban-roles, bridge, local-config). Use when the user wants to create or assign
  Kanban tasks via API, automate the board, or curl workflows against agent-im
  (default port 3300). Primary focus: POST /api/workflows/tasks/create and assign.
---

# agent-im Kanban HTTP API

Local **agent-im** exposes REST under **`AGENT_IM_BASE_URL`** (default **`http://127.0.0.1:3300`**). Canonical reference: repository **`docs/API.md`**.

## Prerequisites

- Next / PM2 process is running (`./start-bg.sh` or `npm run dev`).
- For **create sprint** / **assign**: Git repo at `repository.localPath` must exist and remotes must work when the API runs git commands.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_IM_BASE_URL` | `http://127.0.0.1:3300` | Base URL with no trailing slash |

## Primary flow: create task (and optionally assign to dev lane)

1. **`GET /health`** — optional sanity check.
2. **`GET /api/sprints?projectId=<id>`** — pick **`sprintId`** (often the first active sprint).
3. **`POST /api/workflows/tasks/create`** — body:
   ```json
   { "projectId": "<id>", "sprintId": "<uuid>", "title": "<title>" }
   ```
   Response includes **`id`** (task session id) and **`issueId`**.
4. **Optional — assign from todo** — **`POST /api/workflows/tasks/assign`**:
   ```json
   {
     "projectId": "<id>",
     "sprintId": "<uuid>",
     "issueId": "<from step 3>",
     "taskSessionId": "<from step 3>",
     "kanbanAgent": "agent-dev"
   }
   ```
   Use **`agent-dev`** or **`codex-senior`** when picking up a **todo** card (`assignFromTodo`).

## Helper script (repo)

From the **agent-im** repository root:

```bash
export AGENT_IM_BASE_URL=http://127.0.0.1:3300   # optional
bash .cursor/skills/agent-im-kanban-api/scripts/create-kanban-task.sh <projectId> "<title>" [agent-dev]
```

- Third argument **`agent-dev`** (or omit): if provided, calls **assign** after **create**.

## Related endpoints (quick index)

| Action | Method | Path |
|--------|--------|------|
| Projects list | GET | `/api/projects` |
| Create/update project | POST | `/api/projects` |
| Bridge + config | GET/PUT/POST | `/api/local-config` |
| Runners | GET | `/api/platform/runners` |
| Bridge start/stop | POST | `/api/bridge/start`, `/api/bridge/stop` body `{"slug":"..."}` |
| Start sprint | POST | `/api/workflows/sprints/start` |
| Kanban roles | GET/PUT | `/api/projects/:projectId/kanban-roles` |
| Create task | POST | `/api/workflows/tasks/create` |
| Assign task | POST | `/api/workflows/tasks/assign` |

Full request bodies and examples: **`docs/API.md`**.

## Agent behavior

- Prefer **`curl`** or the **helper script** to avoid inventing URLs.
- On non-2xx responses, surface the response body to the user.
- Do not log secrets; `config.env` and tokens may appear in API payloads—handle carefully.
