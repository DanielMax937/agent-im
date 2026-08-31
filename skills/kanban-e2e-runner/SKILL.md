---
name: kanban-e2e-runner
description: Use when running end-to-end Kanban workflow tests against a live agent-im server, verifying state transitions, API behavior, coverage gates, private repo CI lane, UAT, blocking, hotfix, and async close flows from docs/KANBAN-TESTCASES.md
---

# Kanban E2E Test Runner

## Overview

Runs every test case in `docs/KANBAN-TESTCASES.md` against a live agent-im server. For each case the runner creates a real task via API, drives state transitions (calling API endpoints for every "human" action), polls for expected state, and records pass/fail.

**Canonical full run (recommended):** `npm run test:kanban:full` — runs `scripts/kanban-full-test-runner.mjs`, which includes API/unit-style checks plus **integration flows** in `scripts/kanban-test-flows.mjs` (real `gh` repos, merges, and workflow transitions). Per-case results are written under `docs/test-results/<run-id>/` as `<ID>.md`. Requires `gh auth`, Chrome DevTools Server (CDS) for board snapshots where used, and a platform runner.

---

## Phase 0 — Server & Prerequisites

### 0.1 Start the server (if not running)

```bash
# Check if already running
curl -sf http://127.0.0.1:3300/health || npm run dev &
# Wait until healthy
until curl -sf http://127.0.0.1:3300/health; do sleep 2; done
echo "Server ready"
```

### 0.2 Ensure project "todolist" exists

```bash
BASE=http://127.0.0.1:3300

# Check
PROJECT=$(curl -sf "$BASE/api/projects/todolist")
if [ -z "$PROJECT" ]; then
  # Create
  curl -sf -X POST "$BASE/api/projects" \
    -H "Content-Type: application/json" \
    -d '{
      "id": "todolist",
      "name": "todolist",
      "issueIdPrefix": "TDL",
      "repository": {
        "remoteUrl": "https://github.com/placeholder/todolist",
        "localPath": "/tmp/todolist-e2e",
        "baseBranch": "main",
        "sprintBranchPrefix": "feature/",
        "taskBranchPrefix": "dev/",
        "scmProvider": "github",
        "scmProject": "placeholder/todolist"
      },
      "agents": [],
      "isPrivate": false,
      "requiresUat": false
    }'
fi
```

> For tests that need `isPrivate: true` or `requiresUat: true`, create **separate** projects: `todolist-private` and `todolist-uat`.

### 0.3 Ensure a current Sprint exists

```bash
# List sprints for project
SPRINTS=$(curl -sf "$BASE/api/sprints?projectId=todolist")
SPRINT_ID=$(echo "$SPRINTS" | python3 -c "import sys,json; s=json.load(sys.stdin); print(s[0]['id'] if s else '')" 2>/dev/null)

if [ -z "$SPRINT_ID" ]; then
  RESP=$(curl -sf -X POST "$BASE/api/workflows/sprints/start" \
    -H "Content-Type: application/json" \
    -d '{"projectId":"todolist","sprintName":"e2e-sprint-1"}')
  SPRINT_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
fi
echo "Sprint: $SPRINT_ID"
```

---

## Phase 1 — Test Execution Loop

### Helper: create a task

```bash
create_task() {
  local ISSUE_ID="$1"   # e.g. "TDL-T1"
  local TITLE="$2"
  local EXTRA="${3:-{}}" # optional JSON fragment merged into body

  curl -sf -X POST "$BASE/api/workflows/tasks/create" \
    -H "Content-Type: application/json" \
    -d "{
      \"projectId\": \"todolist\",
      \"sprintId\": \"$SPRINT_ID\",
      \"issueId\": \"$ISSUE_ID\",
      \"title\": \"$TITLE\",
      $EXTRA
    }"
}
```

### Helper: poll task state (with timeout)

```bash
poll_state() {
  local TASK_ID="$1"
  local EXPECTED="$2"
  local MAX=60   # seconds
  local i=0
  while [ $i -lt $MAX ]; do
    STATE=$(curl -sf "$BASE/api/tasks/$TASK_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState',''))")
    if [ "$STATE" = "$EXPECTED" ]; then echo "✅ $EXPECTED"; return 0; fi
    sleep 2; i=$((i+2))
  done
  echo "❌ Expected $EXPECTED, got $STATE after ${MAX}s"
  return 1
}
```

### Helper: call workflow action

```bash
task_action() {
  local TASK_ID="$1"
  local ACTION="$2"
  local BODY="${3:-{}}"
  curl -sf -X POST "$BASE/api/workflows/tasks/$TASK_ID/$ACTION" \
    -H "Content-Type: application/json" \
    -d "$BODY"
}
```

---

## Phase 2 — Test Cases by Section

Run cases in the order below. Each case is independent — use a **fresh unique issueId** per run (e.g. append a timestamp: `TDL-T1-$(date +%s)`).

### Section 1 — Sprint (SP1–SP3)

| Case | Steps | Verify |
|------|-------|--------|
| SP1 | `POST /api/workflows/sprints/start` with valid projectId/sprintName | HTTP 201; sprint object returned |
| SP2 | `GET /api/sprints?projectId=todolist` | List non-empty |
| SP3 | Create sprint with same name again | HTTP 4xx; error message |

### Section 2 — Create Task (T1–T4)

| Case | Steps | Verify |
|------|-------|--------|
| T1 | `create_task "TDL-T1-<ts>" "Normal task"` | `workflowState = todo` |
| T2 | Add `"isHotfix": true` in extra body | Response contains `isHotfix: true` |
| T3 | `create_task` with same issueId twice | Second call returns error |
| T4 | `create_task` without required fields | HTTP 4xx |

### Section 3 — Development (A1–A5)

```bash
# A1: assign task
TASK_ID=<from T1>
task_action "$TASK_ID" "assign" '{"kanbanAgent":"agent-dev","handoffComment":"E2E test handoff"}'
# For the workflow assign endpoint:
curl -sf -X POST "$BASE/api/workflows/tasks/assign" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\":\"todolist\",\"sprintId\":\"$SPRINT_ID\",\"issueId\":\"TDL-T1-<ts>\",\"taskSessionId\":\"$TASK_ID\",\"kanbanAgent\":\"agent-dev\"}"
poll_state "$TASK_ID" "in_progress"
```

| Case | Steps | Verify |
|------|-------|--------|
| A1 | Assign with valid handoffComment | `workflowState = pending_start` or `in_progress` |
| A3 | Assign task that depends on unfinished task | HTTP 4xx; dependency error |
| A5 | Wait for task to reach `pending_release` | Verify runner instances stopped: `GET /api/instances` shows none running for this task |

### Section 4 — Pre-Testing (PT1–PT3)

```bash
# PT1: trigger start-testing (dev done)
task_action "$TASK_ID" "start-testing"
poll_state "$TASK_ID" "pre_testing"

# PT2: trigger start-feature-testing (pre-tester done)
task_action "$TASK_ID" "start-feature-testing"
poll_state "$TASK_ID" "testing"

# PT3 (hotfix): hotfix task skips pre_testing
# Create task with isHotfix:true, assign, then start-testing → should go to testing directly
```

### Section 5 — Testing (E1–E3)

```bash
# Submit review from testing lane
task_action "$TASK_ID" "submit-review" \
  '{"commitMessage":"E2E: feat done","prTitle":"E2E test PR","prBody":"Auto-generated by e2e runner"}'
poll_state "$TASK_ID" "review"
```

### Section 6 — Review (R1–R5)

```bash
# R2: reviewer approves (simulate via API — real agent action)
# Human-operated: just call start-regression directly
task_action "$TASK_ID" "start-regression"
poll_state "$TASK_ID" "regression_testing"

# R3: reject review
task_action "$TASK_ID" "reject-review" '{"comment":"Needs better test coverage"}'
poll_state "$TASK_ID" "in_progress"

# R4: reject with empty comment → expect error
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/$TASK_ID/reject-review" \
  -H "Content-Type: application/json" -d '{"comment":""}')
echo "$RESP" | grep -q "error" && echo "✅ R4 pass" || echo "❌ R4 fail"
```

### Section 7 — Regression Public (G1–G5)

```bash
# G2: proceed to release (coverage passes)
task_action "$TASK_ID" "proceed-to-release"
poll_state "$TASK_ID" "pending_release"

# G4: regression/refresh
task_action "$TASK_ID" "regression/refresh"

# G5: non-regression state → expect error
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/$TASK_ID/regression/refresh" \
  -H "Content-Type: application/json" -d '{}')
echo "$RESP" | grep -q "error" && echo "✅ G5 pass"
```

### Section 8 — Private Repo CI (SH1–SH6)

```bash
# Use todolist-private project (isPrivate: true)
PRIV_TASK=<taskSessionId for private project task in regression_testing>

# SH3: CI success callback
curl -sf -X POST "$BASE/api/workflows/tasks/$PRIV_TASK/ci-result" \
  -H "Content-Type: application/json" \
  -d '{"status":"success","coverage":85}'
poll_state "$PRIV_TASK" "pending_release"

# SH4: CI failure callback (separate task)
curl -sf -X POST "$BASE/api/workflows/tasks/$PRIV_TASK2/ci-result" \
  -H "Content-Type: application/json" \
  -d '{"status":"failure","reason":"Unit tests failed"}'
poll_state "$PRIV_TASK2" "in_progress"

# SH5: wrong state → expect error
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/$PRIV_TASK/ci-result" \
  -H "Content-Type: application/json" -d '{"status":"success"}')
echo "$RESP" | grep -q "error" && echo "✅ SH5 pass"
```

### Section 9 — UAT (U1–U4)

```bash
# Use todolist-uat project (requiresUat: true)
# After proceed-to-release → should land in pending_uat
poll_state "$UAT_TASK" "pending_uat"

# U2: UAT approve
task_action "$UAT_TASK" "uat-approve"
poll_state "$UAT_TASK" "pending_release"

# U3: UAT reject (separate task)
task_action "$UAT_TASK2" "uat-reject" '{"reason":"UI issues found"}'
poll_state "$UAT_TASK2" "regression_testing"
```

### Section 10 — Pending Release (PR1–PR3)

```bash
# PR2: async close
task_action "$TASK_ID" "close-async"
# State goes to closing then closed
poll_state "$TASK_ID" "closed"

# PR3: close when PR not merged → expect block
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/$UNMERGED_TASK/close-async" \
  -H "Content-Type: application/json" -d '{}')
# Should return error or revert to pending_release
```

### Section 11 — Blocking (B1–B4)

```bash
# B1: block an active task
task_action "$TASK_ID" "block" '{"reason":"Waiting for dependency"}'
poll_state "$TASK_ID" "blocked"

# B2: unblock
task_action "$TASK_ID" "unblock"
# Should restore to previous state

# B4: block a closed task → expect error
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/$CLOSED_TASK/block" \
  -H "Content-Type: application/json" -d '{"reason":"test"}')
echo "$RESP" | grep -q "error" && echo "✅ B4 pass"
```

### Section 14 — Coverage (CV1–CV9)

```bash
# CV1: initial coverage = 0
curl -sf "$BASE/api/projects/todolist/coverage"
# → { "coverage": 0 }

# CV2: update to higher value
curl -sf -X POST "$BASE/api/projects/todolist/coverage" \
  -H "Content-Type: application/json" \
  -d '{"coverage":78,"context":"e2e-sprint-1"}'
# → { "updated": true, "coverage": 78 }

# CV3: update to lower value
curl -sf -X POST "$BASE/api/projects/todolist/coverage" \
  -H "Content-Type: application/json" \
  -d '{"coverage":50}'
# → { "updated": false }

# CV5: history
curl -sf "$BASE/api/projects/todolist/coverage/history?limit=10"
```

### Section 15 — Test Failure Compensation (F1–F3)

```bash
# F1: testing fail
task_action "$TASK_ID" "testing/fail" \
  '{"summary":"Test suite crashed","log":"Error: Cannot find module..."}'
poll_state "$TASK_ID" "in_progress"

# F3: fail on non-testing state → error
RESP=$(task_action "$TODO_TASK" "testing/fail" '{"summary":"x","log":"x"}')
echo "$RESP" | grep -q "error" && echo "✅ F3 pass"
```

### Section 18 — Boundary & Edge Cases (EX1–EX7)

```bash
# EX1: invalid transition
RESP=$(task_action "$TODO_TASK" "close" '{}')
echo "$RESP" | grep -q "error" && echo "✅ EX1 pass"

# EX3: non-existent project
RESP=$(curl -sf -X POST "$BASE/api/workflows/tasks/create" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"nonexistent","sprintId":"x","issueId":"X-1","title":"t"}')
echo "$RESP" | grep -q "error" && echo "✅ EX3 pass"
```

---

## Phase 3 — Report

After all cases, print a summary:

```
=== Kanban E2E Test Report ===
PASS: SP1, SP2, T1, T2, A1, PT1, PT2, R3, ...
FAIL: [case] — [reason]
SKIP: [case] — [reason]

Total: X passed, Y failed, Z skipped
```

---

## Quick Reference — Key Endpoints

| Action | Method | Path |
|--------|--------|------|
| Create project | POST | `/api/projects` |
| Create sprint | POST | `/api/workflows/sprints/start` |
| Create task | POST | `/api/workflows/tasks/create` |
| Assign task | POST | `/api/workflows/tasks/assign` |
| Poll task state | GET | `/api/tasks/:taskSessionId` |
| Start testing | POST | `/api/workflows/tasks/:id/start-testing` |
| Start feature testing | POST | `/api/workflows/tasks/:id/start-feature-testing` |
| Submit review | POST | `/api/workflows/tasks/:id/submit-review` |
| Reject review | POST | `/api/workflows/tasks/:id/reject-review` |
| Start regression | POST | `/api/workflows/tasks/:id/start-regression` |
| Regression refresh | POST | `/api/workflows/tasks/:id/regression/refresh` |
| Proceed to release | POST | `/api/workflows/tasks/:id/proceed-to-release` |
| CI result (private) | POST | `/api/workflows/tasks/:id/ci-result` |
| UAT approve | POST | `/api/workflows/tasks/:id/uat-approve` |
| UAT reject | POST | `/api/workflows/tasks/:id/uat-reject` |
| Close task | POST | `/api/workflows/tasks/:id/close` |
| Close async | POST | `/api/workflows/tasks/:id/close-async` |
| Block | POST | `/api/workflows/tasks/:id/block` |
| Unblock | POST | `/api/workflows/tasks/:id/unblock` |
| Testing fail | POST | `/api/workflows/tasks/:id/testing/fail` |
| Get coverage | GET | `/api/projects/:id/coverage` |
| Update coverage | POST | `/api/projects/:id/coverage` |
| Coverage history | GET | `/api/projects/:id/coverage/history` |

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Reusing issueId across runs | Append timestamp: `TDL-T1-$(date +%s)` |
| Polling too fast | 2s interval; 60s max before declaring timeout |
| Expecting immediate `in_progress` | Task may pass through `pending_start` first |
| Calling close on non-`pending_release` task | Must reach that state first via full flow |
| Forgetting `handoffComment` when assigning | Required by UI; API may accept but agents expect it |
| Private repo CI test on public project | Must use a project with `isPrivate: true` |
| UAT test on project without `requiresUat` | Must use project where `requiresUat: true` |
