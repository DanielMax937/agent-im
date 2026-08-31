# agent-im

AI engineering workflow platform with Kanban orchestration, automated agent handoffs, and IM-native collaboration.

[中文文档](README_CN.md)

## Product positioning

`agent-im` is not just an IM bridge and not just a Kanban board.

It is a **task-driven AI delivery platform**:

- **Kanban is the execution layer**: task state changes trigger real work, not just UI updates
- **Auto mode is workflow automation**: developer, reviewer, and tester agents hand off work across the delivery pipeline
- **IM is the collaboration surface**: Telegram, Discord, Feishu/Lark, and QQ become operating consoles for approvals, follow-up, and visibility
- **Git and PR flow stay first-class**: branches, review, testing, merge, and release remain grounded in the existing repo workflow

One-line description:

> Let AI work like an engineering team member: pick up tasks from the board, execute in the repository, and collaborate through IM.

## What it does

The current product combines three subsystems into one platform:

1. **Kanban workflow engine**
   Moves tasks through `Todo -> In Progress -> Review -> Testing -> Closed`, with additional gates such as `pre_testing`, `regression_testing`, `pending_uat`, `pending_release`, and `blocked`.

2. **Agentic auto execution**
   Starts the right runtime and role for each task stage:
   - developer
   - reviewer
   - tester

3. **IM bridge and approvals**
   Connects Telegram, Discord, Feishu/Lark, and QQ so humans can assign work, approve tool usage, inspect progress, and intervene when needed.

## Core value

Traditional task tools only track work.

`agent-im` is built to **push work forward**.

Once a task is created and assigned, the platform can:

- create sprint and task branches
- start a developer agent on the task
- submit work into review
- start reviewer and tester lanes automatically
- push failed testing feedback back into the developer queue
- stop all related instances after the task is closed

## Architecture

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

Main platform surfaces:

- **Web UI**
  - `/admin`: bridge and runtime config
  - `/projects`: project management
  - `/board`: Kanban board
  - `/board/monitor`: lane / turn monitoring
- **HTTP APIs**
  - project, sprint, task, instance, approval, coverage, and bridge APIs
- **Standalone bridge daemon**
  - runs IM adapters and persistent chat sessions

## Product capabilities

### 1. Kanban as execution

Projects define:

- repository location
- branch strategy
- SCM provider
- lane-to-runner mapping
- optional deploy / coverage / UAT requirements

Sprints and tasks become durable execution records with:

- workflow state
- branch / worktree context
- conversation history
- approval queue
- per-task message queue
- active agent instances

### 2. Automated multi-agent workflow

The platform orchestrates role-specific execution:

- **Developer lane** starts from assignment and works on the task branch
- **Reviewer lane** takes over after review submission
- **Tester lane** validates the task branch and later the merged integration branch
- **Compensation / rework loop** routes failures back to development
- **Escalation lane** can hand repeated review pushback to a senior runner profile

### 3. IM-native operations

The bridge layer supports:

- Telegram
- Discord
- Feishu / Lark
- QQ
- Redis-based autonomous / hybrid channels

Humans can use IM to:

- talk directly to a runtime
- receive streaming output
- approve or deny tool usage
- inspect workflow progress
- receive review / test / failure updates

### 4. Runtime abstraction

The platform can run different providers behind the same workflow model:

- Claude
- Codex
- Cursor
- Copilot
- OpenCode

This makes runner selection a project / lane concern instead of a product fork.

## Typical workflow

1. Create a project pointing at a local Git repository.
2. Start a sprint from the base branch.
3. Create or assign a task.
4. The platform creates a task branch and starts the developer lane.
5. Submission moves the task into review and opens the review flow.
6. Testing and regression testing run in sequence.
7. Failures loop back into development; successful work moves toward release and close.

## API overview

Representative endpoints:

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

Detailed API documentation: [docs/API.md](docs/API.md)

## Quick start

### Requirements

- Node.js `>=22.5.0`
- a local Git repository you want the platform to operate on
- at least one runtime installed and authenticated when needed:
  - Claude CLI / Claude Agent SDK flow
  - Codex CLI / SDK
  - Cursor or Copilot runner setups if used

### Install

```bash
npm install
```

### Run the web platform

```bash
npm run dev
```

Default local surface:

- web UI: `http://127.0.0.1:3000`
- health: `http://127.0.0.1:3000/health`

### Run the standalone bridge daemon

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

## Data and persistence

Bridge data lives under `~/.claude-to-im/...` and stores:

- IM sessions
- bindings
- permissions
- messages
- logs
- runtime status

Platform data is stored separately and persists:

- projects
- sprints
- task sessions
- agent instances
- task queues
- approvals
- monitor rows

## Key files

| File | Role |
|---|---|
| `src/main.ts` | Standalone bridge daemon entrypoint |
| `src/platform/app.ts` | Shared HTTP router for the platform |
| `src/platform/container.ts` | Bootstrap for stores, runtime, and workflow services |
| `src/platform/workflow-service.ts` | Kanban workflow state machine |
| `src/platform/instance-manager.ts` | Runtime instance lifecycle |
| `src/platform/json-platform-store.ts` | Platform persistence |
| `src/lib/bridge/bridge-manager.ts` | IM bridge orchestration |
| `src/app/page.tsx` | Next.js landing page |

## Safety and reliability

The platform includes built-in safety features to ensure reliable, auditable AI agent execution:

### Safety features

- **Explicit approval flow**: tool usage requiring elevated privileges can be gated on human approval via IM channels
- **Task isolation**: each task session runs in its own branch and worktree with isolated message queues
- **Automatic rollback**: failed testing triggers compensation workflows that route tasks back to development
- **Runtime sandboxing**: agent instances run in controlled environments with configurable resource limits

### Grounding guarantees

- **Git-anchored execution**: all agent work happens on tracked branches with full commit history
- **Reproducible state**: workflow transitions are logged with task context, branch pointers, and instance metadata
- **Audit trail**: every state change, approval decision, and agent action is recorded in platform persistence

### Citation integrity

- **Source tracking**: review and testing agents reference specific commits, file paths, and line numbers
- **PR-native feedback**: agent comments tie directly to code diffs in the review flow
- **Structured evidence**: test failures include stack traces, coverage deltas, and reproduction steps

### Structured logging

- **Standardized formats**: logs use consistent schemas across bridge, workflow, and runtime layers
- **Secret masking**: credentials and tokens are redacted before writing to disk
- **Per-task streams**: each task session maintains isolated logs for debugging and replay

### Testing coverage

- **Unit tests**: core workflow state machine, instance lifecycle, and bridge routing
- **Integration tests**: end-to-end task flows including branch creation, agent handoffs, and PR submission
- **Type safety**: full TypeScript coverage with strict mode enabled

See [docs/TESTING.md](docs/TESTING.md) for test execution and coverage reports.

## Security

- credentials remain local
- logs mask secrets before writing
- approvals can stay explicit
- task queues are isolated per task
- runtime backends remain pluggable behind the same workflow layer

More: [SECURITY.md](SECURITY.md)

## Related docs

- [Product / codebase understanding](docs/PROJECT-UNDERSTANDING.md)
- [HTTP API](docs/API.md)
- [Log locations and inspection](docs/LOGS.md)
- [Testing guide](docs/TESTING.md)
- [Bridge architecture](src/lib/bridge/ARCHITECTURE.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE)
