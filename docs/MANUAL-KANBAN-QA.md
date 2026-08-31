# Manual QA — Kanban workflow

Manual checklist for the **agentic Kanban** flow (`todo → in_progress → review → testing → regression_testing → closed`). Primary UI: `/board`. APIs are under `/api/workflows/...` and `/api/kanban/status`.

Tick each row when behavior matches **expected**.

---

## Preconditions (once)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| P1 | Server & data | Start the app; open `/board` | Page loads; projects list populates (or empty with no error). |
| P2 | Project exists | Have at least one **Project** configured (e.g. via admin / store) with valid `localPath`, branches, SCM settings | `/api/projects` returns your project. |
| P3 | Git & remote | Repo path is real; `origin` fetch works if you will run PR/regression steps | No surprise git errors when later steps run. |

---

## Step 0 — Sprint (iteration branch)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| S1 | Start sprint | `POST /api/workflows/sprints/start` with `projectId`, `sprintName`, optional `baseBranch` (see [README](../README.md) curl examples) | New sprint; `feature/<prefix><slug>` branch created; sprint appears in `/api/sprints?projectId=...`. |
| S2 | Board: sprint dropdown | Select project on `/board` | Sprints load; you can pick the sprint for “新建任务”. |

---

## Step 1 — `todo` (create card)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| T1 | Create task | Project + sprint + unique `issueId` + title → **创建** | Card appears in **待办**; task has `workflowState` `todo`. |
| T2 | Duplicate issue | Create again with same `issueId` | Error (task already exists). |
| T3 | Validation | Leave project/sprint/issue/title incomplete → **创建** | UI error (“请选择项目…”). |

---

## Step 2 — `in_progress` (assign from todo)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| A1 | Happy path | Fill **交接说明**; choose lane (agent-开发 / codex-高级开发) → **分配并启动 runner** | Card moves to **开发中**; branch/worktree created (per `CTI_KANBAN_USE_WORKTREE`); workflow comments mention assignment; runner starts (if your env runs instances). |
| A2 | Handoff required | Clear 交接说明 → assign | UI error (“分配前请填写交接说明…”). |
| A3 | Escalation after ≥2 rejections | After two review rejections, assign again from **待办** with `reviewRejectionCount ≥ 2` | UI hint about codex; assigning **agent-开发** still resolves to **codex-高级开发** server-side (`resolveKanbanAgent`). |

---

## Step 3 — `review` (submit for review)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| R1 | Submit PR | Optional commit/PR fields → **提交评审（claude-review）** | State **评审中**; PR URL on card; reviewer agent started; workflow comment about PR. |
| R2 | Git empty / no-op commit | Submit with nothing to commit | Behavior per `gitService.commitAll` (still follows PR flow as implemented). |

---

## Step 4 — `review` → `in_progress` (reject)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| J1 | Reject with comment | Fill **打回说明** → **打回开发** | Card **开发中**; `reviewRejectionCount` increments; developer runner restarted; comment logged. |
| J2 | Comment required | Empty 打回说明 → **打回开发** | UI error (“打回时请填写说明…”). |

---

## Step 5 — `testing` (from review)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| E1 | Enter testing | From **评审中** → **进入测试（copilot-测试）** | **测试中**; `kanbanAgent` copilot-测试; tester runner started. |

---

## Step 6 — `regression_testing`

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| G1 | Enter regression | From **测试中** → **进入回归测试** | **回归测试中**; `regressionMasterSha` set (first 7 chars shown); regression tester started; comment mentions master SHA. |

---

## Step 7 — Regression refresh (optional)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| RF1 | Master unchanged | **检查 master 是否前进** | Workflow comment that baseline unchanged (or baseline recorded if missing). |
| RF2 | Master advanced | Push/merge to `origin/<baseBranch>`, then **检查 master 是否前进** | Baseline updates; handoff text warns to discard stale checkout; tester restarted. |
| RF3 | Wrong state | Call `POST /api/workflows/tasks/:taskSessionId/regression/refresh` when task not in `regression_testing` | API error. |

---

## Step 8 — `closed`

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| C1 | Close from testing | **测试中** → **标记完成** | **完成**; agent instances for that task stopped; workflow comment indicates close. |
| C2 | Close from regression | **回归测试中** → **标记完成** | Same as C1. |
| C3 | Invalid transition | Try `POST /api/workflows/tasks/:taskSessionId/close` from **待办** / **开发中** (no UI button for these) | Error: invalid workflow transition. |

---

## Compensation — test failure (API only; not on board UI)

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| F1 | Report failure | `POST /api/workflows/tasks/:taskSessionId/testing/fail` with JSON including `taskSessionId`, `summary`, `log` while state is **testing** or **回归测试中** | Task returns to developer flow via `CompensationService` (typically **开发中** again). |
| F2 | Wrong state | Same API when task is not in testing/regression | Error (“Task is not in testing or regression_testing”). |

Example:

```http
POST /api/workflows/tasks/<taskSessionId>/testing/fail
Content-Type: application/json

{"taskSessionId":"<id>","summary":"short","log":"logs..."}
```

---

## Dashboard & observability

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| K1 | Aggregate status | **负责人视图（聚合状态）** | Counts per column match board; per-project breakdown; instance count listed. |
| K2 | Refresh | **刷新任务** after changes | Task list matches store. |

---

## Optional integrations

| # | Test case | Steps | Expected |
|---|------------|-------|----------|
| O1 | Telegram fan-out | Set `CTI_KANBAN_TELEGRAM_BOT_TOKEN` + `CTI_KANBAN_TELEGRAM_CHAT_ID` | Workflow comments also notify Telegram (`kanban-notify`). |
| O2 | Jira webhook | `POST /api/webhooks/jira` with payloads matching `handleJiraWebhook` status strings | Transitions align (e.g. `review`, `testing`, `regression`, `closed`). |
| O3 | Redis “Kanban (g)” supplement | Telegram → Redis auto path with `CTI_KANBAN_SUPPLEMENT_G_IN_REDIS` not `0` | Session summary appends `Kanban requirement (g, full):` block (`kanban-redis-supplement.ts`). |

---

## Suggested minimal happy path (one issue)

1. Start sprint  
2. Create task (`todo`)  
3. Assign with handoff (`in_progress`)  
4. Submit review (`review`)  
5. Start testing (`testing`)  
6. Start regression (`regression_testing`)  
7. Mark complete (`closed`)

**Branch path:** after step 4, use **打回开发** once or twice, then re-submit review and continue.

**Failure path:** from testing or regression, call **testing/fail** API, then verify return to dev and repeat forward steps.

---

## Related code

| Area | Location |
|------|----------|
| Workflow transitions | `src/platform/workflow-service.ts` |
| Board UI | `src/app/board/page.tsx` |
| Kanban status API | `GET /api/kanban/status` |
| Types / columns | `src/platform/types.ts` |
