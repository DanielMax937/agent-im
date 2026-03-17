# agent-im

Agentic Auto Kanban / DevOps platform built on top of the original IM bridge.

[中文文档](README_CN.md)

---

## What it is now

`agent-im` is no longer only a chat bridge for Claude Code / Codex. It now acts as a lightweight **agentic auto kanban system**:

- **Next.js web server** for APIs and UI entry pages
- **Pino logging** with secret masking
- **Sprint / Task / Session / Agent Instance** persistence
- **Agentic workflow orchestration** for `Todo -> In Progress -> Review -> Testing -> Closed`
- **Jira comment adapter** so issue comments can drive agent execution
- **Runtime abstraction** for Claude, Codex, and Cursor
- **Legacy IM bridge compatibility** for Telegram / Discord / Feishu / QQ

The result is a hybrid platform:

```text
Jira / Web UI / IM channels
        |
        v
Next.js platform server
  - workflow APIs
  - approval APIs
  - sprint/task queries
        |
        v
Platform services
  - WorkflowService
  - InstanceManager
  - JiraAdapter
  - GitService / SCM client
        |
        v
Claude / Codex / Cursor runtimes
```

## Core concepts

### Project

Defines the Git repository, branch rules, and available agent profiles.

Example fields:

- `remoteUrl`
- `localPath`
- `baseBranch`
- `sprintBranchPrefix`
- `taskBranchPrefix`
- `scmProvider`

### Sprint

Represents an iteration branch, usually:

- `master -> feature/<sprint-name>`

### Task Session

Maps one Jira issue to one persistent task context:

- workflow state
- runtime
- branch name
- conversation history
- approval queue
- task queue

### Agent Instance

Represents one runtime + role bound to one task:

- `runtime`: `claude` / `codex` / `cursor`
- `role`: `developer` / `reviewer` / `tester`
- `taskId`

## Agentic auto kanban flow

The platform implements an automated kanban pipeline:

1. **Sprint start**
   - API creates `feature/<sprint-name>` from `master`

2. **Task assignment**
   - API creates `dev/<task-id>` from the sprint branch
   - a developer agent instance starts for the Jira issue

3. **Review**
   - after task submission, the platform commits, pushes, and creates a PR / MR
   - a reviewer agent starts automatically

4. **Testing**
   - a tester agent runs after review

5. **Compensation**
   - if tests fail, logs are pushed back into the original developer queue
   - workflow returns to `in_progress`

6. **Close**
   - all related instances are stopped after the task closes

## Latest server architecture

### Next.js app router

The web surface now runs on **Next.js**:

- homepage: `/`
- health: `/health`
- API catch-all: `/api/[[...slug]]`

Important files:

| File | Role |
|---|---|
| `src/app/page.tsx` | Landing page for the platform |
| `src/app/health/route.ts` | Health endpoint |
| `src/app/api/[[...slug]]/route.ts` | Next.js API entrypoint |
| `src/platform/container.ts` | Lazy singleton bootstrap for stores, runtime, and workflow services |
| `src/platform/app.ts` | Native `Request -> Response` platform router shared by Next.js and tests |

### Pino logging

The logger now uses **Pino** and writes structured logs to:

```text
~/.claude-to-im/logs/bridge.log
```

Properties:

- secret masking for tokens / bearer headers
- `console.log / warn / error` forwarding into Pino
- shared logger for daemon and Next.js server

## Platform APIs

### Query APIs

- `GET /health`
- `GET /api/structure`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `GET /api/sprints`
- `GET /api/sprints/:sprintId`
- `GET /api/tasks`
- `GET /api/tasks/:taskSessionId`
- `GET /api/instances`
- `GET /api/instances/:instanceId`
- `GET /api/approvals`
- `GET /api/approvals/:approvalId`
- `GET /api/bridge/status`

### Mutation APIs

- `POST /api/projects`
- `POST /api/workflows/sprints/start`
- `POST /api/workflows/tasks/assign`
- `POST /api/workflows/tasks/:taskSessionId/submit-review`
- `POST /api/workflows/tasks/:taskSessionId/start-testing`
- `POST /api/workflows/tasks/:taskSessionId/testing/fail`
- `POST /api/workflows/tasks/:taskSessionId/close`
- `POST /api/approvals/:approvalId`
- `POST /api/instances/reconcile`
- `POST /api/instances/:instanceId/start`
- `POST /api/instances/:instanceId/stop`
- `POST /api/webhooks/jira`
- `POST /api/bridge/:action`

## Sprint walkthrough example

Create a project:

```bash
curl -s -X POST http://127.0.0.1:3001/api/projects \
  -H 'Content-Type: application/json' \
  --data '{
    "id":"demo-project",
    "name":"Demo Project",
    "repository":{
      "remoteUrl":"file:///tmp/demo/origin.git",
      "localPath":"/tmp/demo/repo",
      "baseBranch":"master",
      "sprintBranchPrefix":"feature/",
      "taskBranchPrefix":"dev/",
      "scmProvider":"github",
      "scmProject":"demo/agent-im",
      "scmTokenEnvVar":"GITHUB_TOKEN"
    },
    "agents":[],
    "createdAt":"2026-03-16T00:00:00.000Z",
    "updatedAt":"2026-03-16T00:00:00.000Z"
  }'
```

Start a sprint:

```bash
curl -s -X POST http://127.0.0.1:3001/api/workflows/sprints/start \
  -H 'Content-Type: application/json' \
  --data '{"projectId":"demo-project","sprintName":"Sprint Alpha"}'
```

Expected result:

- sprint record is persisted
- Git creates / checks out `feature/sprint-alpha`

## Jira-driven execution

The platform supports **Jira comment as transport**:

- Jira comments are polled as inbound task instructions
- agent replies are written back as Jira comments
- bot-authored comments are ignored to prevent loops

This allows a Jira issue to act as the task inbox for developer / reviewer / tester agents.

## IM bridge compatibility

The legacy bridge is still available and useful when you want direct chat-based access to the runtime:

- Telegram
- Discord
- Feishu / Lark
- QQ
- Agent loop / Redis-based autonomous channel

The bridge manager, channel adapters, permission flow, and session persistence remain part of the codebase.

## Data layout

```text
~/.claude-to-im/
├── config.env
├── data/
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   ├── platform/
│   │   ├── projects.json
│   │   ├── sprints.json
│   │   ├── task_sessions.json
│   │   ├── agent_instances.json
│   │   ├── queues.json
│   │   └── approvals.json
│   └── messages/
├── logs/
│   └── bridge.log
└── runtime/
    ├── bridge.pid
    └── status.json
```

## Development

### Install

```bash
npm install
```

### Run Next.js web server

```bash
npm run dev
```

### Run legacy daemon entrypoint

```bash
npm run dev:bridge
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
npm run typecheck
```

## Key files

| File | Role |
|---|---|
| `src/main.ts` | Legacy bridge daemon entrypoint |
| `src/platform/container.ts` | Shared platform bootstrap |
| `src/platform/workflow-service.ts` | Sprint/task state machine |
| `src/platform/instance-manager.ts` | Runtime instance lifecycle |
| `src/platform/jira-adapter.ts` | Jira comment adapter |
| `src/platform/json-platform-store.ts` | Platform persistence |
| `src/logger.ts` | Pino logger with secret masking |
| `src/app/page.tsx` | Next.js platform landing page |

## Security

- credentials stay under `~/.claude-to-im/config.env`
- logs are masked before writing
- approvals remain explicit
- task queues are isolated per task
- runtime abstraction keeps Claude / Codex / Cursor pluggable

## Related docs

- [API / host reference](references/api.md)
- [Bridge architecture notes](src/lib/bridge/ARCHITECTURE.md)
- [Multi-instance guide](docs/agent-multi-instance.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE)
