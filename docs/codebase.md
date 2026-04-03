# Codebase Reference — `agent-im` (Claude-to-IM-Skill)

> Quick-reference for understanding this project. Updated: 2026-04-03.

---

## 1. What This Project Does

**Claude-to-IM-Skill** is a full-stack AI DevOps orchestration platform with two integrated pillars:

1. **IM Bridge** — Lets users chat with Claude Code, Codex, Cursor, or GitHub Copilot from Telegram, Discord, Feishu/Lark, or QQ. Messages arrive from IM, route to an LLM agent session, and replies stream back with platform-appropriate Markdown rendering.

2. **AI Kanban Platform** — A full autonomous software-delivery pipeline. Tasks move through a structured Kanban board (backlog → dev → test → review → regression → release) with dedicated AI agents (developer, reviewer, tester) driving each lane, coordinating via Git, GitHub/GitLab PRs, and test coverage gates.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, Node ≥22.5.0) |
| Framework | Next.js 16 App Router (`output: 'standalone'`) |
| UI | React 19 |
| Database | Node.js built-in SQLite (`node:sqlite`, `DatabaseSync`, WAL mode) |
| IM Bridge Store | JSON flat-file store (`src/store.ts`) |
| Auto-mode queues | Redis (optional, `redis ^4.7.0`) |
| LLM SDKs | `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`; custom Cursor & Copilot adapters |
| IM SDKs | `discord.js ^14`, `@larksuiteoapi/node-sdk`, Telegram raw Bot API, QQ Open Platform |
| Build | `esbuild` (daemon bundle), `tsx` (dev/tests), PM2 (production) |
| Key libs | `markdown-it`, `undici` (proxy), `ws` (Discord/QQ), `pino` (logging), `patch-package` |

---

## 3. Directory Structure

```
/
├── src/
│   ├── main.ts                        # Standalone bridge daemon entrypoint
│   ├── config.ts                      # CTI_HOME/CTI_BOT_NAME resolution; config.env load/save
│   ├── config-shared.ts               # Client-safe types: Config, RunnerConfig, ImInstanceSpec
│   ├── store.ts                       # JSON flat-file store (bindings, settings, audit)
│   ├── llm-provider.ts                # LLM runtime factory dispatcher
│   ├── runtime-provider.ts            # resolveProvider() — returns LLM instance from config
│   ├── instrumentation.ts             # Next.js instrumentation hook
│   ├── permission-gateway.ts          # PendingPermissions in-memory queue
│   ├── logger.ts                      # Pino logger + secret masking
│   │
│   ├── app/                           # Next.js App Router
│   │   ├── api/[[...slug]]/route.ts   # Catch-all → all /api/* routes via platform app.ts
│   │   ├── api/local-config/route.ts  # GET|PUT|POST /api/local-config (bridge admin)
│   │   ├── health/route.ts            # GET /health
│   │   ├── admin/page.tsx             # Admin UI (config, runners, auto-mode settings)
│   │   ├── board/page.tsx             # Kanban board UI
│   │   ├── board/roles/page.tsx       # Kanban role assignment UI
│   │   ├── board/monitor/page.tsx     # Board activity monitor
│   │   ├── projects/page.tsx          # Project list UI
│   │   └── monitor/page.tsx           # Bridge monitor UI
│   │
│   ├── platform/                      # Core domain business logic
│   │   ├── types.ts                   # ALL domain types — read first
│   │   ├── workflow-service.ts        # State machine + Git/PR automation (★ largest file)
│   │   ├── app.ts                     # HTTP platform router — all /api/* handlers
│   │   ├── json-platform-store.ts     # SQLite persistence (schema + all CRUD)
│   │   ├── instance-manager.ts        # Agent instance lifecycle, queue polling
│   │   ├── prompts.ts                 # System prompt assembly (buildRolePrompt)
│   │   ├── kanban-agents.ts           # KanbanAgentKind → role/runtime resolution
│   │   ├── kanban-workflow-parser.ts  # parseKanbanAction() — reads KANBAN_ACTION: markers
│   │   ├── kanban-role-assign.ts      # Sticky/least-load assignee selection
│   │   ├── kanban-notify.ts           # Telegram notifications on transitions
│   │   ├── kanban-confirmation.ts     # System-check prompt loops
│   │   ├── compensation-service.ts    # Retry/compensation for failed workflow steps
│   │   ├── git-service.ts             # Git commands (branch, worktree, push, fetch)
│   │   ├── scm-client.ts              # GitHub/GitLab PR/MR API client
│   │   ├── batch-task-spec.ts         # Batch task planning via LLM
│   │   └── container.ts               # PlatformContainer DI singleton
│   │
│   ├── lib/
│   │   ├── bridge-app-child.ts        # Bridge child process (spawn/stop from Next.js)
│   │   ├── bridge-daemon-status.ts    # Read $CTI_HOME/runtime/status.json
│   │   └── bridge/                    # IM bridge system
│   │       ├── bridge-manager.ts      # Singleton orchestrator, adapter lifecycle (★)
│   │       ├── conversation-engine.ts # LLM stream processing
│   │       ├── channel-adapter.ts     # Abstract BaseChannelAdapter + registry
│   │       ├── channel-router.ts      # ChannelAddress → ChannelBinding resolution
│   │       ├── delivery-layer.ts      # Reliable outbound delivery (chunking, retry, dedup)
│   │       ├── redis-local-transport.ts  # Auto-mode Redis pipeline (master/slave)
│   │       ├── auto-redis-keys.ts     # Redis key layout for auto-mode
│   │       ├── master-verification-walkthrough.ts  # Coverage gate + verification logic
│   │       ├── kanban-redis-supplement.ts  # Rolling summary Kanban context injection
│   │       ├── slave-process.ts       # Slave child process spawn/stop
│   │       ├── slave-report-goal.ts   # Resolve slave report goal from session/Redis
│   │       ├── markdown/              # Platform-specific Markdown rendering
│   │       ├── security/              # validators.ts, rate-limiter.ts
│   │       └── adapters/
│   │           ├── telegram-adapter.ts  # Telegram + full auto-mode pipeline (★ largest)
│   │           ├── discord-adapter.ts
│   │           ├── feishu-adapter.ts
│   │           └── qq-adapter.ts
│   │
│   ├── prompts/                       # All prompt templates (.md, {{var}} syntax)
│   │   ├── loader.ts                  # renderPrompt(name, vars?) + in-memory cache
│   │   ├── system/master-coordinator.md
│   │   ├── bridge/                    # Auto-mode handoffs + review/verification templates
│   │   └── kanban/                    # Role prompts + workflow block prompts
│   │
│   └── __tests__/                     # Node built-in test runner test files (~30 files)
│
├── docs/                              # Markdown docs (API, LOGS, KANBAN-TESTCASES, etc.)
├── scripts/                           # Build, deploy, daemon setup scripts
├── dist/                              # esbuild daemon bundle output
├── plugin/                            # Packaged Cursor skill
├── ecosystem.config.cjs               # PM2 config (name: agent-im, port 3300)
├── next.config.mjs                    # Next.js config
└── start-bg.sh / stop-bg.sh          # Background start/stop scripts
```

---

## 4. Core Domain Types (`src/platform/types.ts`)

### `Project`
Top-level entity. Key fields:
- `id`, `name`, `owner`, `issueIdPrefix`
- `repository` — `remoteUrl`, `localPath`, `baseBranch`, `sprintBranchPrefix`, `taskBranchPrefix`, `scmProvider` (`github`|`gitlab`), `scmProject`, `scmApiBaseUrl`, `scmTokenEnvVar`
- `agents: ProjectAgentProfile[]` — runtime/role assignments
- `kanbanRoleRunners` — per-lane runner profile ID overrides
- `kanbanRoleMembers` — multi-assignee per lane with sticky routing
- `kanbanLaneSkills` — per-lane skill overrides
- `coverageCommand`, `coverageSummaryPath`
- `requiresUat` — inserts `pending_uat` gate before release
- `isPrivate` — enables self-hosted CI runner mode (no AI in regression)

### `Sprint`
Scoped development iteration.
- `id`, `projectId`, `name`, `branchName`, `baseBranch`
- `status: SprintStatus` — `'planned' | 'active' | 'closed'`
- `pendingDeveloperAssignmentQueue` — ordered task IDs waiting for dependencies

### `TaskSession`
The central work unit — one per task per lane lifecycle.
- `id`, `projectId`, `sprintId`, `taskId`, `issueId`, `title`
- `workflowState: TaskWorkflowState` — current Kanban column (see §5)
- `role: AgentRole`, `kanbanAgent?: KanbanAgentKind`
- `kanbanAssignees` — sticky assignee map per lane
- `reviewRejectionCount` — escalates to `codex-senior` after >2 rejects
- `dependsOnIssueIds` — blocks `pending_start → in_progress` until dependencies close
- `isHotfix` — skips `pre_testing` lane
- `worktreePath` — isolated git worktree
- `pullRequestUrl/Number`, `releasePullRequestUrl/Number`
- `branchName`, `reviewBranchName`
- `conversationHistory: TaskConversationEntry[]` — full LLM chat log
- `historyComments: TaskHistoryComment[]` — per-transition summaries
- `lastTestResult` — latest structured test result
- `blockedFromState` — restore state when unblocked
- `confirmationLoopCount` — loop guard for system_check prompts

### `AgentRole`
`'developer' | 'reviewer' | 'tester'`

### `KanbanAgentKind`
```
'agent-dev'        → developer, claude       (default dev lane)
'pre-tester'       → tester,    copilot      (pre-testing lane)
'claude-review'    → reviewer,  claude       (review lane)
'copilot-test'     → tester,    copilot      (testing lane)
'codex-senior'     → developer, codex        (escalation after >2 rejects)
'self-host-runner' → no AI agent             (private repo: waits for CI webhook)
```

### `TaskWorkflowState`
```
todo | pending_start | in_progress | pre_testing | testing | review |
regression_testing | pending_uat | pending_release | closing | blocked | closed
```

---

## 5. Kanban State Machine (`src/platform/workflow-service.ts`)

### Full Transition Table

| From | To | Trigger |
|---|---|---|
| `todo` | `pending_start` | `assignTask()` — card picked up |
| `pending_start` | `in_progress` | Queue scan + dependency check passes; developer runner started |
| `in_progress` | `pre_testing` | Developer → `KANBAN_ACTION:START_TESTING` |
| `in_progress` | `testing` | Hotfix: developer → `KANBAN_ACTION:START_TESTING` (skips pre-test) |
| `pre_testing` | `testing` | Pre-tester → `KANBAN_ACTION:START_FEATURE_TESTING` |
| `testing` | `review` | Tester → `KANBAN_ACTION:SUBMIT_REVIEW` (commits, creates PR) |
| `testing` | `in_progress` | Tester → `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` |
| `review` | `in_progress` | Reviewer → `KANBAN_ACTION:REJECT_REVIEW` |
| `review` | `regression_testing` | Reviewer → `KANBAN_ACTION:APPROVE_MERGE` (PR merged, regression starts) |
| `regression_testing` | `pending_uat` | Tester → `KANBAN_ACTION:PROCEED_TO_RELEASE` + `requiresUat=true` |
| `regression_testing` | `pending_release` | Tester → `KANBAN_ACTION:PROCEED_TO_RELEASE` (no UAT) |
| `regression_testing` | `in_progress` | Regression fail / CI failure (private repo) |
| `pending_uat` | `pending_release` | Human → `POST /api/workflows/tasks/:id/uat-approve` |
| `pending_uat` | `regression_testing` | Human → `POST /api/workflows/tasks/:id/uat-reject` |
| `pending_release` | `closing` | `initiateCloseAsync()` — verifies PR merge + coverage |
| `pending_release` | `closed` | `closeTask()` direct (legacy) |
| `closing` | `closed` | Coverage passes + PR merged |
| `closing` | `pending_release` | Coverage fails or PR not merged (blocks with popup) |
| `blocked` | any active | `unblockTask()` — restores `blockedFromState` |

### Auto-advance
`CTI_KANBAN_WORKFLOW_AUTO ≠ '0'`: After each agent turn, `WorkflowService.afterAgentTurn()` calls `parseKanbanAction()` on the last assistant message and dispatches the corresponding workflow method.

### Pending Release → Close (async)
`initiateCloseAsync()` checks:
1. Sprint → master PR exists and is merged (if not, blocks + popup)
2. Checks out base branch in temp worktree, runs tests + coverage
3. Calls `updateProjectCoverage()` to update DB if coverage improved
4. On failure: returns task to `pending_release` with popup

---

## 6. Agent Roles & Prompts

### Developer (`agent-dev`)
- **Prompt:** `src/prompts/kanban/role-developer.md`
- Writes code + unit tests; runs coverage; ends with `KANBAN_ACTION:START_TESTING`
- After >2 review rejects: escalated to `codex-senior` (Codex runtime)
- On rework: receives `block-developer-rework-base.md` + optional `block-developer-rework-coverage.md` + `block-developer-rework-merge.md`

### Reviewer (`claude-review`)
- **Prompt:** `src/prompts/kanban/role-reviewer.md`
- Two-step: code review + host PR mergeability check
- Posts findings as PR discussion comments; mirrors to task
- `APPROVE_MERGE` only when code OK **and** PR is merge-ready on host
- Receives `block-review-pr.md` with PR URL + sprint branch

### Tester (`pre-tester` / `copilot-test`)
- **Prompt:** `src/prompts/kanban/role-tester.md`
- **Read-only**: never modifies code
- `pre-tester`: validates env prerequisites → `KANBAN_ACTION:START_FEATURE_TESTING`
- `copilot-test`: validates task acceptance criteria → `SUBMIT_REVIEW` or `RETURN_TO_DEVELOPMENT`
- Regression: checks coverage gate via API → `PROCEED_TO_RELEASE`
- Receives `block-regression.md` (includes coverage gate instructions)

### System Prompt Assembly (`src/platform/prompts.ts` → `buildRolePrompt()`)
Order: role prompt → skill block → handoff block → history log → workflow notes → (state-specific block) → rework block → execution context → platform guardrails → workflow automation

---

## 7. IM Bridge System

### Architecture
`bridge-manager.ts` (singleton on `globalThis`) manages adapter lifecycles, session locks, streaming previews, and permission flows.

**Inbound flow:**
1. Adapter polls/listens → `InboundMessage`
2. Bridge Manager → `handleMessage()` with session lock
3. Channel Router: `ChannelAddress → ChannelBinding` (creates session if new)
4. Conversation Engine → LLM `streamChat()` via SSE
5. `text` events → streaming preview (throttled: 700ms Telegram, 1500ms Discord)
6. `permission_request` → Permission Broker → inline IM buttons
7. Full response saved → `deliverResponse()` → platform Markdown rendering → Delivery Layer (chunking, retry, dedup)

### Adapters
- `telegram-adapter.ts` — long-polling, streaming previews, **full auto-mode** logic
- `discord-adapter.ts` — discord.js v14
- `feishu-adapter.ts` — Feishu/Lark card messages
- `qq-adapter.ts` — QQ Open Platform

---

## 8. Auto-Mode (Master/Slave)

### Concept
One Telegram bot = **Master** (coordinator/reviewer); separate bridge process = **Slave** (code execution agent). They communicate via Redis queues.

### Redis Key Layout (`src/lib/bridge/auto-redis-keys.ts`)
```
cti:auto:{bridgeSlug}:{channelType}:master:input|out|turns|resp|summary|busy|last_user|reverify|review_loops|coverage_baseline
cti:auto:{bridgeSlug}:{channelType}:slave:input|out|turns|resp
```

### Master Flow
1. Telegram user message → Master LLM runs with `system/master-coordinator.md`
2. **Static review phase**: sends slave's `## Slave Execution Report` + `bridge/static-review.md`
3. Parses `REVIEW_RESULT_JSON: {"pass": bool}`
4. **Verification phase**: sends `buildMasterVerificationWalkthroughPrompt()` (infers mode from task context)
5. Mode: `api_only` (curl/terminal checks) or `ui_and_api` (Playwright + Chrome + curl)
6. Parses `VERIFICATION_RESULT_JSON: {"pass": bool}`
7. **Coverage gate** (if `autoCoverageCommand` set + task involves code): runs command, checks vs `coverage_baseline`
8. **Pass**: updates `coverage_baseline`, resets `review_loops`, `reverify`; sends task-finished notice
9. **Fail**: increments `review_loops`; if < `autoReviewMaxLoops` (default 5) → sends followup to slave; else alert

### Slave
- Child process spawned by master adapter; Telegram token stripped
- Config from `$CTI_HOME/config.slave.env`
- Reads `slave:input`, runs LLM, produces `## Slave Execution Report`
- Mandatory: unit tests + coverage for any code changes

### Handoff Templates
| Template | Used when |
|---|---|
| `bridge/handoff-user-task.md` | New user request forwarded to slave |
| `bridge/handoff-master-followup.md` | Master rejected slave's work (review) |
| `bridge/handoff-verification-followup.md` | Verification found issues |

---

## 9. API Routes (`src/platform/app.ts`)

All handled via `src/app/api/[[...slug]]/route.ts` catch-all.

**Projects & Coverage**
- `GET/POST /api/projects` — list / create
- `GET/PUT/DELETE /api/projects/:id` — read / update / delete
- `GET /api/projects/:id/coverage` — get latest coverage
- `GET /api/projects/:id/coverage/history` — coverage history
- `GET/PUT /api/projects/:id/kanban-roles` — role/runner/member config

**Sprints & Tasks**
- `GET /api/sprints`, `GET /api/sprints/:id`
- `GET /api/tasks`, `GET /api/tasks/:id`

**Workflow Actions**
- `POST /api/workflows/sprints/start`
- `POST /api/workflows/tasks/create`
- `POST /api/workflows/tasks/assign`
- `POST /api/workflows/tasks/:id/queue-message`
- `POST /api/workflows/tasks/:id/start-testing`
- `POST /api/workflows/tasks/:id/start-feature-testing`
- `POST /api/workflows/tasks/:id/submit-review`
- `POST /api/workflows/tasks/:id/reject-review`
- `POST /api/workflows/tasks/:id/start-regression`
- `POST /api/workflows/tasks/:id/proceed-to-release`
- `POST /api/workflows/tasks/:id/close` / `close-async`
- `POST /api/workflows/tasks/:id/block` / `unblock`
- `POST /api/workflows/tasks/:id/uat-approve` / `uat-reject`
- `POST /api/workflows/tasks/:id/ci-result` — CI callback (private repos)
- `POST /api/workflows/tasks/:id/sync-review-comment`
- `POST /api/workflows/tasks/:id/regression/refresh`
- `DELETE /api/workflows/tasks/:id`

**Agent Instances**
- `GET/POST /api/instances`
- `GET/POST :id/start`, `:id/stop`
- `POST /api/instances/reconcile`

**Kanban Monitor**
- `GET /api/kanban/monitor` — agent turn list
- `GET /api/kanban/status`

**Bridge / Admin**
- `GET /api/bridge/status`, `GET /api/bridge/logs`
- `POST /api/bridge/:action` (start/stop/restart)
- `GET|PUT|POST /api/local-config`

---

## 10. Database Schema (`src/platform/json-platform-store.ts`)

File: `<cwd>/data/platform/platform.db` (override: `CTI_KANBAN_PLATFORM_DIR`)

| Table | Primary Key | Notes |
|---|---|---|
| `projects` | `id TEXT` | Full `Project` JSON in `payload` |
| `sprints` | `id TEXT` | Indexed on `project_id` |
| `task_sessions` | `id TEXT` | Indexed on `project_id` |
| `agent_instances` | `id TEXT` | Indexed on `task_session_id` |
| `queues` | `queue_key TEXT` | Message queues (inbox + approvals) |
| `approvals` | `id TEXT` | Indexed on session + status |
| `kanban_agent_turns` | `id TEXT` | Turn-by-turn agent I/O log; indexed on project, session, created_at |
| `project_coverage` | `project_id TEXT` | Latest coverage `REAL` per project; initialized at 0 |
| `project_coverage_history` | `id TEXT` | Immutable coverage history with context |

All entities stored as JSON blobs; in-memory `Map<string, T>` caches loaded at startup. Schema is auto-migrated via `initSchema()` (called at startup — new tables are created automatically).

---

## 11. Prompt Templates (`src/prompts/`)

Loader: `renderPrompt(name, vars?)` — loads `.md` file relative to `process.cwd()/src/prompts/`, substitutes `{{varName}}` placeholders, caches in-memory.

### `system/`
| File | Variables | Purpose |
|---|---|---|
| `master-coordinator.md` | `{{reviewResultJsonPrefix}}`, `{{verificationResultJsonPrefix}}` | Master coordinator identity; judge slave work, never execute |

### `bridge/`
| File | Variables | Purpose |
|---|---|---|
| `static-review.md` | none | First-phase static code review rubric (blocking vs non-blocking) |
| `handoff-user-task.md` | `{{userRequest}}` | Initial task forwarded to slave |
| `handoff-master-followup.md` | `{{sessionContext}}`, `{{masterFeedback}}` | After master rejects |
| `handoff-verification-followup.md` | `{{sessionContext}}`, `{{unknownNote}}`, `{{verificationFindings}}` | After verification issues |
| `verification-api-only.md` | none | Verification instructions: curl/terminal only |
| `verification-ui-api.md` | none | Verification instructions: Playwright + curl |
| `verification-coverage-gate.md` | `{{coverageCommand}}`, `{{baselineNote}}`, `{{minLine}}`, `{{reportLine}}` | Coverage gate step |
| `verification-reverify.md` | none | Re-verification block (strict loop) |
| `verification-if-fail.md` | none | What to do on first fail |

### `kanban/`
| File | Variables | Purpose |
|---|---|---|
| `role-developer.md` | none | Developer agent identity + rules |
| `role-reviewer.md` | none | Reviewer agent identity + rules |
| `role-tester.md` | none | Tester agent identity + rules |
| `block-execution-context.md` | `{{projectName}}`, `{{repoUrl}}`, `{{localPath}}`, `{{sprintBranch}}`, `{{taskBranch}}`, `{{workflowState}}`, `{{issueId}}`, `{{taskTitle}}` | Per-task context injected into every prompt |
| `block-platform-guardrails.md` | none | Context isolation, permission control |
| `block-workflow-automation.md` | none | All `KANBAN_ACTION:…` tokens + conditions |
| `block-pre-testing.md` | none | Pre-tester lane instructions |
| `block-testing-scope.md` | none | Feature testing scope |
| `block-regression.md` | `{{sprintBranchName}}`, `{{platformPort}}`, `{{projectId}}` | Regression + coverage gate for tester |
| `block-review-pr.md` | `{{prUrl}}`, `{{prNumber}}`, `{{sprintBranchName}}` | PR context for reviewer |
| `block-developer-rework-base.md` | none | Base rework rules after review reject |
| `block-developer-rework-coverage.md` | none | Coverage-specific rework steps |
| `block-developer-rework-merge.md` | `{{sprintBranchName}}` | Merge conflict resolution steps |

---

## 12. Key Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `CTI_HOME` | Explicit bot data directory | — |
| `CTI_BOT_NAME` | Slug under `CTI_BASE` | — |
| `CTI_BASE` | Base directory | `~/.claude-to-im` |
| `CTI_RUNTIME` | Default AI runtime (`claude`/`codex`/`cursor`/`copilot`) | `claude` |
| `CTI_RUNNERS` | JSON array of `RunnerConfig` | — |
| `CTI_AUTO_APPROVE` | Auto-approve all tool permissions | — |
| `CTI_AUTO_REDIS_URL` | Redis URL for auto-mode | — |
| `CTI_AUTO_REDIS_NAMESPACE` | Shared Redis namespace (multi-bridge) | — |
| `CTI_AUTO_MAX_TURNS` | Max auto-mode turns | — |
| `CTI_AUTO_REVIEW_MAX_LOOPS` | Max master→slave review loops | `5` |
| `CTI_AUTO_COVERAGE_COMMAND` | Shell command for coverage gate | — |
| `CTI_AUTO_COVERAGE_MIN_PCT` | Min coverage % | — |
| `CTI_KANBAN_PLATFORM_DIR` | SQLite data dir override | `cti-home` |
| `CTI_KANBAN_WORKFLOW_AUTO` | Set `0` to disable auto-advance | enabled |
| `CTI_KANBAN_USE_WORKTREE` | Set `0` to disable git worktrees | enabled |
| `CTI_KANBAN_TELEGRAM_BOT_TOKEN` | Kanban notification bot token | — |
| `CTI_KANBAN_TELEGRAM_CHAT_ID` | Kanban notification chat ID | — |
| `CTI_PROXY` | HTTP(S) proxy | — |
| `CTI_LOG_LEVEL` | Pino log level | `info` |
| `CTI_SLAVE_BRIDGE` | `1` when running as slave process | — |
| `PORT` | HTTP server port | `3300` |

Config stored in `$CTI_HOME/config.env` (`KEY=VALUE`). Admin UI reads/writes via `/api/local-config`. `syncConfigFileToProcessEnv()` merges into `process.env` at startup.

**Data layout under `$CTI_HOME/`:**
```
config.env            # Main config
config.slave.env      # Slave runner config
data/platform/        # SQLite DB
logs/                 # bridge-*.log
runtime/status.json   # Running status + PID
```

---

## 13. Build & Deploy

```bash
# Development
npm run dev            # Next.js dev server on port 3300
npm run dev:bridge     # Standalone bridge daemon (tsx src/main.ts)

# Build
npm run build          # Both daemon + Next.js web
npm run build:daemon   # esbuild → dist/
npm run build:web      # next build

# Tests
npm test               # Node built-in runner, src/__tests__/*.test.ts, concurrency=1

# Production
pm2 start ecosystem.config.cjs   # name: agent-im, port 3300
./start-bg.sh / ./stop-bg.sh     # Quick start/stop
```

PM2: `autorestart: true`, `max_restarts: 10`, `min_uptime: 5s`.
Standalone Next.js: `output: 'standalone'`; prompt `.md` files traced via `outputFileTracingIncludes`.

---

## 14. Testing

- **Runner:** Node.js built-in `node:test`, `tsx` for TypeScript, `--test-concurrency=1`
- **Setup:** fresh `CTI_HOME=$(mktemp -d)` per run; `CTI_KANBAN_PLATFORM_DIR=cti-home`
- **Count:** 325 tests across ~30 files

Key test files:
| File | What it covers |
|---|---|
| `workflow-service.test.ts` | State machine transitions, private repo CI, coverage gate |
| `platform-app.integration.test.ts` | Full HTTP API integration |
| `master-verification-walkthrough.test.ts` | Coverage gate, verification parsing |
| `kanban-prompts.test.ts` | System prompt assembly |
| `telegram-auto-mode-session-reset.test.ts` | Auto-mode session lifecycle |
| `auto-mode-redis.test.ts` | Redis queue semantics |
| `kanban-workflow-parser.test.ts` | KANBAN_ACTION: parsing |
| `scm-client.test.ts` | GitHub/GitLab PR API |

---

## 15. Most Important Files

| File | Why |
|---|---|
| `src/platform/types.ts` | **All domain types** — start here |
| `src/platform/workflow-service.ts` | **Heart of the platform**: state machine, Git/PR, KANBAN_ACTION dispatch |
| `src/platform/app.ts` | **All HTTP routes** |
| `src/platform/json-platform-store.ts` | **SQLite schema + CRUD** |
| `src/platform/prompts.ts` | **Prompt assembly** (`buildRolePrompt`) |
| `src/platform/kanban-agents.ts` | **Lane → runtime mapping** |
| `src/lib/bridge/bridge-manager.ts` | **IM bridge orchestrator** |
| `src/lib/bridge/adapters/telegram-adapter.ts` | **Telegram + auto-mode pipeline** |
| `src/lib/bridge/redis-local-transport.ts` | **Auto-mode Redis queues** |
| `src/lib/bridge/master-verification-walkthrough.ts` | **Verification + coverage gate** |
| `src/prompts/kanban/block-workflow-automation.md` | **All KANBAN_ACTION tokens** agents must emit |
| `src/config.ts` | **Config resolution**: CTI_HOME, loadConfig, saveConfig |
| `src/config-shared.ts` | **Shared interfaces**: Config, RunnerConfig, ImInstanceSpec |
