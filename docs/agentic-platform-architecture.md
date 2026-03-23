# Agentic Platform Refactor Plan

## Target directory layout

- `src/main.ts`: keep the original daemon entrypoint for CLI/bridge compatibility.
- `src/app/`: Next.js app router entrypoint for the multi-tenant web platform.
- `src/platform/container.ts`: shared Next.js container bootstrap for stores, workflow services, and runtime instances.
- `src/runtime-provider.ts`: shared Claude/Codex/Cursor runtime resolver.
- `src/platform/app.ts`: native HTTP API surface for sprint, task, approval, and webhook workflows, shared by Next.js and tests.
- `src/platform/json-platform-store.ts`: JSON persistence for `Project`, `Sprint`, `TaskSession`, `AgentInstance`, isolated task queues, and approval records.
- `src/platform/jira-adapter.ts`: Jira comment polling and comment write-back adapter.
- `src/platform/instance-manager.ts`: singleton manager that creates, starts, stops, and reconciles runtime instances.
- `src/platform/workflow-service.ts`: workflow state machine and Git/PR orchestration.
- `src/platform/compensation-service.ts`: failed-test compensation flow back to the original developer agent.
- `src/platform/prompts.ts`: role-specific prompt templates for developer, reviewer, and tester agents.
- `src/platform/git-service.ts`: Git branch, commit, and push wrappers.
- `src/platform/scm-client.ts`: GitHub/GitLab pull request creation client.

## Modeling notes

- `Project` owns repository metadata, branch naming rules, and agent profiles.
- `Sprint` owns the iteration branch and the task list for that branch.
- `TaskSession` maps one Jira issue to one persisted session context, plus isolated queue keys:
  - `task:{taskId}:inbox`
  - `task:{taskId}:approvals`
- `AgentInstance` binds one runtime (`claude`/`codex`/`cursor`) and one role (`developer`/`reviewer`/`tester`) to one `taskId`.

## Workflow notes

1. Start sprint: `master` -> `feature/<sprint-name>`.
2. Assign task: `feature/<sprint-name>` -> `dev/<task-id>`.
3. Submit review: commit, push, create PR, and spin up a reviewer instance.
4. Start testing: spin up a tester instance for the same task session.
5. Test failure: enqueue tester logs back to the developer queue and transition the task back to `in_progress`.
