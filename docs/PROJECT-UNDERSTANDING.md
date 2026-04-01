# Project Understanding

This document records what the codebase currently does, how the major pieces fit together, and which files carry the important behavior.

It is based on a code pass across the runtime entrypoints, platform services, bridge internals, UI entrypoints, and tests.

## One-sentence summary

This repo is a hybrid of:

- a standalone IM bridge that connects Telegram / Discord / Feishu / QQ to persistent AI chat sessions
- a Next.js-based local agentic kanban platform that orchestrates developer / reviewer / tester agents across Git branches, PRs, and testing flow

## High-level architecture

There are two primary subsystems.

### 1. IM bridge subsystem

Main files:

- `src/main.ts`
- `src/lib/bridge/*`
- `src/store.ts`
- `src/runtime-provider.ts`
- `src/llm-provider.ts`
- `src/codex-provider.ts`
- `src/cursor-provider.ts`
- `src/copilot-provider.ts`

Responsibilities:

- start channel adapters
- bind each IM chat to a persistent session
- route inbound messages to a runtime provider
- stream partial/final output back to the IM platform
- surface tool approval requests back to the user in chat
- persist bridge sessions, bindings, messages, permission links, dedup keys, offsets, and audit logs

### 2. Platform / kanban subsystem

Main files:

- `src/platform/app.ts`
- `src/platform/container.ts`
- `src/platform/json-platform-store.ts`
- `src/platform/workflow-service.ts`
- `src/platform/instance-manager.ts`
- `src/platform/git-service.ts`
- `src/platform/scm-client.ts`
- `src/app/*`

Responsibilities:

- expose HTTP APIs through Next.js
- persist projects, sprints, tasks, instances, queues, approvals, and monitor rows
- run a task state machine
- create task branches or worktrees
- start agent instances for developer / reviewer / tester roles
- create and merge PRs
- send failed testing feedback back to the development lane

## Boot flow

### Standalone bridge daemon

Entry: `src/main.ts`

Boot sequence:

1. Load config and sync `config.env` into process env.
2. Initialize logging.
3. Configure outbound proxy if present.
4. Build the LLM stack with `buildImBridgeLlmStack(...)`.
5. Create the bridge store with `JsonFileStore`.
6. Initialize bridge DI context with store, LLM resolver, runner config accessors, permissions gateway, and lifecycle hooks.
7. Start `bridge-manager`.
8. Write runtime PID/status files and handle graceful shutdown.

Important detail:

- the daemon writes status under `$CTI_HOME/runtime/status.json`
- master and slave status are kept separate when `CTI_SLAVE_BRIDGE=1`

### Next.js platform server

Entry path:

- `src/app/api/[[...slug]]/route.ts`
- `src/platform/container.ts`
- `src/platform/app.ts`

Boot sequence:

1. Load config.
2. Set up logging and proxy.
3. Build the same bridge context used by the daemon.
4. Create platform persistence with `JsonPlatformStore`.
5. Create singleton `InstanceManager`.
6. Create `WorkflowService`.
7. Call `resumeKanbanAfterRestart()`.
8. Expose the platform HTTP router through the Next.js App Router.

Important detail:

- the Next.js app and the bridge share config/runtime abstractions, but the platform task store is separate from the bridge JSON store

## Persistence model

There are two distinct storage layers.

### Bridge storage

File: `src/store.ts`

Storage type:

- JSON files under `$CTI_HOME/data`

Persists:

- bridge sessions
- channel bindings
- session messages
- permission link records
- adapter offsets
- dedup keys
- audit logs

Behavior notes:

- messages are stored per session under `$CTI_HOME/data/messages/<sessionId>.json`
- session locking is implemented inside this store to prevent concurrent processing

### Platform storage

File: `src/platform/json-platform-store.ts`

Storage type:

- SQLite via `node:sqlite`

Default location:

- `<cwd>/data/platform/platform.db`

Override:

- `CTI_KANBAN_PLATFORM_DIR`

Persists:

- projects
- sprints
- task sessions
- agent instances
- task queues
- approvals
- kanban agent monitor turns

Behavior notes:

- legacy JSON data in the same directory can be migrated into SQLite
- the store maintains in-memory maps backed by SQLite writes

## Core domain model

Main types live in `src/platform/types.ts` and bridge host/types files.

### Project

Represents:

- repository location and SCM metadata
- base branch, sprint branch prefix, task branch prefix
- runner mappings and optional lane/member assignments

### Sprint

Represents:

- one integration branch for a batch of work
- usually created from the repository base branch
- a queue of pending developer assignments may be attached

### TaskSession

Represents:

- one issue/task moving through the kanban system
- workflow state
- branch/worktree info
- runtime and lane assignment
- conversation history
- queue keys
- approval queue key

### AgentInstanceRecord

Represents:

- one running agent for a task and role
- runtime
- working directory
- status
- generation state

## Workflow state machine

File: `src/platform/workflow-service.ts`

The task pipeline is:

- `todo`
- `pending_start`
- `in_progress`
- `testing`
- `review`
- `regression_testing`
- `closed`

Allowed transitions are enforced in code.

### Practical meaning of each state

- `todo`: task exists, but no branch and no runner yet
- `pending_start`: assigned from todo, but waiting on dependency closure and sprint FIFO
- `in_progress`: developer lane is active on a task branch/worktree
- `testing`: feature testing on the task branch
- `review`: PR is open and reviewer lane is active
- `regression_testing`: PR already merged to sprint/integration branch, tester now validates the merged target
- `closed`: work is done and instances are stopped

### Key workflow methods

- `startSprint(...)`
- `createTask(...)`
- `assignTask(...)`
- `startTesting(...)`
- `submitTaskForReview(...)`
- `rejectReview(...)`
- `mergeApprovedPullRequestAndStartRegression(...)`
- `refreshRegressionIfMasterAdvanced(...)`
- `handleTestFailure(...)`
- `closeTask(...)`
- `resumeKanbanAfterRestart(...)`

## Queue-driven execution model

The platform is not event-bus-heavy. It is mostly queue-driven per task.

Relevant files:

- `src/platform/instance-manager.ts`
- `src/platform/json-platform-store.ts`

How it works:

1. Each task has a message queue key and approval queue key.
2. `InstanceManager` runs a `TaskAgentRunner` per active instance.
3. The runner polls and drains the task queue.
4. Each queue item becomes a prompt to the selected runtime provider.
5. The assistant response is persisted into task conversation history.
6. After a successful assistant turn, workflow auto-advance logic may run.

Important detail:

- the loop is intentionally simple: drain queue, process each message, sleep, repeat

## Auto-advance via assistant output

File: `src/platform/workflow-service.ts`

The platform can parse workflow directives embedded in assistant output:

- `KANBAN_ACTION:SUBMIT_REVIEW`
- `KANBAN_ACTION:START_TESTING`
- `KANBAN_ACTION:APPROVE_MERGE`
- `KANBAN_ACTION:REJECT_REVIEW`
- `KANBAN_ACTION:CLOSE`

Meaning:

- agent output is not just text for humans
- it can directly drive state transitions when auto mode is enabled

Fallback behavior:

- if no transition occurs after a turn, the workflow may enqueue a bounded `system_check` follow-up prompt

## Runtime abstraction

File: `src/runtime-provider.ts`

The system hides runtime differences behind a common `LLMProvider` interface.

Supported runtimes:

- Claude
- Codex
- Cursor
- Copilot

Provider implementations:

- `src/llm-provider.ts`: Claude Agent SDK backed provider
- `src/codex-provider.ts`: `@openai/codex-sdk` backed provider
- `src/cursor-provider.ts`: Cursor `agent` CLI backed provider
- `src/copilot-provider.ts`: GitHub Copilot CLI backed provider

What all providers do:

- accept a common `streamChat(...)` call
- emit a normalized SSE-like stream consumed by the bridge or platform
- support session resume where available
- surface tool activity and permission requests

Important detail:

- the code actively guards against cross-runtime stale session reuse, especially when a Claude session ID leaks into Codex/Cursor flows

## IM bridge request flow

Key files:

- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/channel-router.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/delivery-layer.ts`
- `src/lib/bridge/permission-broker.ts`

Flow:

1. An adapter receives an inbound platform message.
2. `channel-router` resolves or creates a binding for that chat.
3. `conversation-engine` acquires a session lock and stores the user message.
4. The effective runtime/provider is selected from binding, session, runner, and defaults.
5. The provider stream is consumed server-side.
6. Partial text can be pushed as previews.
7. Final output is rendered per platform and delivered.
8. Permission requests are forwarded immediately through the broker.

Important detail:

- permission forwarding happens during stream consumption, not after, because the stream may block until a decision is returned

## Session binding model

File: `src/lib/bridge/channel-router.ts`

Each IM chat maps to one persistent session through a `ChannelBinding`.

Binding data includes:

- channel type
- chat id
- codepilot session id
- working directory
- model
- runner profile id
- mode

Important behavior:

- if a session referenced by a binding no longer exists, a new one is created automatically
- changing runner backends can recreate a binding session to avoid invalid resume state

## Delivery behavior

File: `src/lib/bridge/delivery-layer.ts`

The delivery layer handles:

- chunking by platform limits
- rate limiting per chat
- retry with backoff
- parse error fallback from HTML to plain text
- outbound reference tracking
- dedup

Platform-specific rendering:

- Telegram: markdown -> HTML chunks
- Discord: markdown chunking
- Feishu: markdown handed to adapter formatting
- others: plain text fallback

## Permission flow

Relevant files:

- `src/lib/bridge/permission-broker.ts`
- `src/permission-gateway.ts`
- `src/platform/instance-manager.ts`

Bridge-side:

- a permission request is formatted and sent back to the IM channel
- Telegram/Discord-like channels use inline buttons
- QQ falls back to textual commands / numeric shortcuts

Platform-side:

- approvals are also saved in platform storage for task runners
- resolving an approval routes the result back into the pending runtime stream

Important detail:

- the code includes dedup and same-chat/same-message validation to avoid double resolution or spoofed callbacks

## Git and SCM behavior

Main files:

- `src/platform/git-service.ts`
- `src/platform/scm-client.ts`
- `src/platform/workflow-service.ts`

Behavior:

- sprint start creates a sprint branch
- task assignment creates a task branch or worktree from the sprint branch
- submit-for-review commits, pushes, and opens a PR
- reviewer approval merges the PR and moves to regression testing
- close from regression may create a release PR from sprint branch to base branch

Important detail:

- worktrees are used by default unless `CTI_KANBAN_USE_WORKTREE=0`

## Restart behavior and resilience

The project is designed to resume state after restarts.

Important mechanisms:

- daemon status file for bridge process tracking
- `resumeKanbanAfterRestart()` for the platform
- persisted task queues and agent instances
- re-enqueueing kickoff/resume prompts when needed
- `InstanceManager.reconcile()` to restore running instances

Special case handled:

- if a regression tester already emitted `KANBAN_ACTION:CLOSE` before restart, resume logic can close the task on startup

## UI surfaces

Main pages:

- `src/app/page.tsx`
- `src/app/admin/page.tsx`
- `src/app/projects/page.tsx`
- `src/app/board/page.tsx`
- `src/app/monitor/page.tsx`

### Admin UI

Purpose:

- manage bridge config
- inspect runner/env requirements
- start/stop bridge instances
- work with per-bot bridge slugs and daemon state

### Board UI

Purpose:

- create sprints and tasks
- assign todo tasks into lanes
- monitor tasks by column
- enqueue manual follow-up prompts for in-flight work

## API surface

Platform routing is implemented directly in `src/platform/app.ts`.

Major endpoint groups:

- health and structure
- projects
- sprints
- tasks
- instances
- approvals
- kanban monitor/status
- workflow actions
- bridge status/start/stop
- monitor responses

Design note:

- the platform router is intentionally explicit rather than controller-heavy
- it doubles as the reusable request handler for tests

## Notable configuration concepts

Files:

- `src/config.ts`
- `src/config-shared.ts`
- `config.env.example`

Important concepts:

- `CTI_HOME` or `CTI_BOT_NAME` determine bridge home
- bridge homes can be multiplexed under `~/.claude-to-im`
- runners can be global or per-bot
- IM bots can have per-channel runtime mappings
- auto mode / hybrid Telegram + Redis behavior is configurable
- the platform database path is independently configurable

## What the tests say about intended behavior

The test suite is broad and gives a good picture of intended system behavior.

Covered areas include:

- config loading and masking
- runtime provider stream mapping
- bridge admin status and daemon resolution
- store semantics
- permission resolution
- instance manager behavior
- workflow service transitions
- platform API integration
- kanban parsing, assignment, and monitor records

Observed repo status during this pass:

- `npm test`: passed
- `npm run typecheck`: passed

## Mental model for future tasks

When changing this repo, it helps to think in these layers:

1. Config and bootstrap
2. Persistence
3. Runtime/provider abstraction
4. Bridge session flow
5. Platform task/workflow flow
6. UI/API wrappers around those internals

In practice:

- IM chat bugs usually live in `src/lib/bridge/*`, `src/store.ts`, or a provider
- task lifecycle bugs usually live in `src/platform/workflow-service.ts` or `src/platform/instance-manager.ts`
- config/bootstrap issues usually live in `src/config.ts`, `src/platform/container.ts`, or `src/main.ts`
- UI problems tend to be fairly thin wrappers over platform APIs

## Files most worth reading first

If someone needs to understand the system quickly, start here:

- `README.md`
- `src/main.ts`
- `src/platform/container.ts`
- `src/platform/app.ts`
- `src/platform/workflow-service.ts`
- `src/platform/instance-manager.ts`
- `src/platform/json-platform-store.ts`
- `src/runtime-provider.ts`
- `src/lib/bridge/bridge-manager.ts`
- `src/lib/bridge/conversation-engine.ts`
- `src/lib/bridge/channel-router.ts`

## Bottom line

This is no longer just a chat bridge project.

It is a local orchestration platform for agent-driven software work, with the IM bridge acting as both a user interface and an auxiliary runtime channel. The codebase is organized around a small number of strong abstractions:

- bridge context
- runtime provider
- persistent task session
- task queue
- agent instance
- workflow service

Most future changes will fit into one of those seams.

## Recent Auto Mode Debugging And Fixes

This repo recently had a concentrated debugging pass around Telegram hybrid auto mode, especially the master/slave runner flow.

### Main findings

- Telegram auto mode has three distinct message paths:
  - plain Telegram user messages
  - slave execution reports sent back to master
  - master verification walkthrough prompts
- plain user messages do not need a master LLM turn first; they should be forwarded straight to the slave runner
- the master stall was not caused by the old timeout cleanup bug alone; a separate real issue was long-lived resumed master sessions keeping too much old context
- the stuck master review behavior often happened immediately after one `status` chunk, before any `text`, `tool_use`, or final `result`

### Important auto mode behavior now

- every new Telegram user message is treated as a new task
- when that happens, auto mode now starts fresh synthetic sessions for both:
  - master binding: `auto:master:...`
  - slave binding: `auto:...`
- the rolling Redis session summary is replaced with the new `User goal:` instead of appending prior task context
- this change is intentionally scoped to auto mode task intake; non-auto runner behavior stays as before

### Files changed during this debugging pass

- `src/lib/bridge/adapters/telegram-adapter.ts`
  - plain auto-mode user messages now reset master/slave synthetic sessions before slave handoff
  - runner-status writes were tightened so monitor state reflects the intended busy runner
  - Telegram reply-thread behavior was fixed so Redis-synthesized master/slave messages do not incorrectly reply to random Telegram messages
- `src/lib/bridge/redis-local-transport.ts`
  - added helper support for constructing synthetic slave chat ids consistently
- `src/lib/bridge/channel-router.ts`
  - existing `recreateBindingSession(...)` is the key primitive used to force fresh sessions and clear `sdkSessionId`
- `src/cursor-provider.ts`
  - abort handling was fixed so timed-out/stopped Cursor turns reject correctly instead of hanging after session start
  - incomplete Cursor exits after abort are now surfaced as `AbortError`
- `src/lib/bridge/conversation-engine.ts`
  - richer auto-mode stream/tool logging was added so logs show tool start/finish, durations, pending tools, and whether a turn ever emitted status/result/error
- `src/lib/bridge/master-verification-walkthrough.ts`
  - master verification scope was reduced for non-UI tasks
  - verification now distinguishes `API_ONLY` vs `UI_AND_API`

### Practical log interpretation

When diagnosing auto mode now, the most useful signals are:

- whether the first Telegram user message was logged as `forwarded directly to slave (no master LLM)`
- whether the later master review turn is resuming an old Cursor session via `--resume ...`
- whether the stream ever emits:
  - `status`
  - `text`
  - `tool_use`
  - `result`
- whether `auto_mode_turn_summary` or `auto_mode_turn_failed_summary` was emitted
- whether `masterBusy` / `slaveBusy` in runner status match the actual current phase

### Tests added or updated for this work

- `src/__tests__/cursor-provider.test.ts`
- `src/__tests__/master-verification-walkthrough.test.ts`
- `src/__tests__/telegram-auto-mode-session-reset.test.ts`

These tests now cover:

- Cursor abort/terminal-result behavior
- verification prompt mode selection
- fresh master/slave session reset on each new Telegram auto-mode task
