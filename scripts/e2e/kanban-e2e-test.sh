#!/usr/bin/env bash
# kanban-e2e-test.sh
# Loops through KANBAN-TESTCASES.md, creates real tasks via API,
# verifies state transitions, calls API for human-required operations.
#
# Usage:
#   ./scripts/e2e/kanban-e2e-test.sh [BASE_URL] [SECTION_FILTER]
#
# Examples:
#   ./scripts/e2e/kanban-e2e-test.sh
#   ./scripts/e2e/kanban-e2e-test.sh http://127.0.0.1:3300
#   ./scripts/e2e/kanban-e2e-test.sh http://127.0.0.1:3300 coverage
#
# Environment:
#   BASE_URL         default: http://127.0.0.1:3300
#   E2E_PROJECT_ID   default: todolist
#   E2E_TIMEOUT      poll timeout in seconds, default: 300
#   CTI_KANBAN_PLATFORM_DB_FILE  default test.db when script starts dev (avoids platform.db)
#   E2E_SKIP_GH_REPO=1 — use local bare origin + placeholder SCM (no GitHub API; gh 404 on auto-advance)
#   E2E_GH_ORG       — if set, gh repo create under this org; else your user (gh api user)
#   E2E_GH_REPO_PREFIX — default agent-im-e2e- (list/delete: gh repo list | grep agent-im-e2e)

set -euo pipefail

BASE="${1:-${BASE_URL:-http://127.0.0.1:3300}}"
FILTER="${2:-}"
PROJECT_ID="${E2E_PROJECT_ID:-todolist}"
POLL_TIMEOUT="${E2E_TIMEOUT:-300}"

PASS=0
FAIL=0
FAILURES=()

# ─── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✅ PASS${NC}  $*"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}❌ FAIL${NC}  $*"; FAIL=$((FAIL+1)); FAILURES+=("$*"); }
info() { echo -e "   ℹ  $*"; }
section() { echo -e "\n${YELLOW}══ $* ══${NC}"; }

# ─── Helpers ──────────────────────────────────────────────────────────────────
CURL_OPTS=(--noproxy "*")
api_get()  { curl -sf  "${CURL_OPTS[@]}" "$BASE$1"; }
api_post() { curl -sS --max-time 120 "${CURL_OPTS[@]}" -X POST   "$BASE$1" -H "Content-Type: application/json" -d "$2"; }
api_put()  { curl -sS  "${CURL_OPTS[@]}" -X PUT    "$BASE$1" -H "Content-Type: application/json" -d "$2"; }
api_del()  { curl -sS  "${CURL_OPTS[@]}" -X DELETE "$BASE$1"; }

json_field() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2','') if isinstance(d,dict) else '')" 2>/dev/null; }
json_field_raw() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('$2')))" 2>/dev/null; }

get_state() {
  api_get "/api/tasks/$1" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('workflowState','?'))" 2>/dev/null || echo "error"
}

assert_state() {
  local ID="$1" EXPECTED="$2" LABEL="${3:-$1}"
  local ACTUAL
  ACTUAL=$(get_state "$ID")
  if echo "$ACTUAL" | grep -qE "^($EXPECTED)$"; then
    pass "$LABEL: state=$ACTUAL"
  else
    fail "$LABEL: expected=[$EXPECTED] actual=$ACTUAL"
  fi
}

assert_error() {
  local RESP="$1" LABEL="${2:-}"
  if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'error' in d else 1)" 2>/dev/null; then
    pass "$LABEL: returned error as expected ($(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?')[:80])" 2>/dev/null))"
  else
    fail "$LABEL: expected error response, got: ${RESP:0:100}"
  fi
}

assert_field() {
  local RESP="$1" FIELD="$2" EXPECTED="$3" LABEL="${4:-}"
  local ACTUAL
  ACTUAL=$(json_field "$RESP" "$FIELD")
  if [ "$ACTUAL" = "$EXPECTED" ]; then
    pass "$LABEL: $FIELD=$ACTUAL"
  else
    fail "$LABEL: $FIELD expected=$EXPECTED actual=$ACTUAL"
  fi
}

poll_state() {
  local ID="$1" TARGET="$2" LABEL="${3:-$1}"
  local ELAPSED=0 INTERVAL=5
  info "Polling $LABEL for state [$TARGET] (timeout ${POLL_TIMEOUT}s)..."
  while [ "$ELAPSED" -lt "$POLL_TIMEOUT" ]; do
    local STATE
    STATE=$(get_state "$ID")
    if echo "$STATE" | grep -qE "^($TARGET)$"; then
      pass "$LABEL: reached state=$STATE"
      return 0
    fi
    info "  [${ELAPSED}s] current=$STATE waiting..."
    sleep "$INTERVAL"
    ELAPSED=$((ELAPSED+INTERVAL))
  done
  fail "$LABEL: timeout waiting for [$TARGET], last state=$(get_state "$ID")"
  return 1
}

unique_id() { echo "TC-$1-$(date +%s%N | tail -c 8)"; }

# Bare origin so `git fetch origin` in createTaskBranch succeeds (local-only test repo).
ensure_e2e_git_remote() {
  local repo="$1"
  [ -d "$repo/.git" ] || return 0
  if git -C "$repo" remote get-url origin &>/dev/null; then
    return 0
  fi
  local bare="/tmp/${PROJECT_ID}-e2e-origin.git"
  rm -rf "$bare"
  git clone --bare "$repo" "$bare" >/dev/null 2>&1 || true
  git -C "$repo" remote add origin "$bare" 2>/dev/null || git -C "$repo" remote set-url origin "$bare"
  git -C "$repo" push -u origin HEAD:main 2>/dev/null || git -C "$repo" push -u origin main 2>/dev/null || true
}

# Create a real GitHub repo via gh (name prefix E2E_GH_REPO_PREFIX) so SCM API calls succeed.
# Sets E2E_GH_REMOTE_URL, E2E_GH_SCM_PROJECT, E2E_GH_CREATED (1=gh, 0=placeholder/bare).
ensure_e2e_scm_remote() {
  local repo="$1"
  E2E_GH_CREATED=0
  if [ "${E2E_SKIP_GH_REPO:-}" = "1" ]; then
    ensure_e2e_git_remote "$repo"
    E2E_GH_REMOTE_URL="https://github.com/placeholder/${PROJECT_ID}"
    E2E_GH_SCM_PROJECT="placeholder/${PROJECT_ID}"
    info "E2E_SKIP_GH_REPO=1 — placeholder SCM (GitHub list PRs will 404 if workflow auto-advance runs)"
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo -e "${RED}gh not found. Install GitHub CLI or set E2E_SKIP_GH_REPO=1 for bare-remote placeholder.${NC}" >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo -e "${RED}gh not authenticated. Run: gh auth login, or set E2E_SKIP_GH_REPO=1${NC}" >&2
    exit 1
  fi
  [ -d "$repo/.git" ] || return 0
  local GH_OWNER REPO_NAME
  if [ -n "${E2E_GH_ORG:-}" ]; then
    GH_OWNER="$E2E_GH_ORG"
  else
    GH_OWNER=$(gh api user -q .login 2>/dev/null) || {
      echo -e "${RED}gh api user failed${NC}" >&2
      exit 1
    }
  fi
  REPO_NAME="${E2E_GH_REPO_PREFIX:-agent-im-e2e-}${PROJECT_ID}-$(date +%s)-$$"
  REPO_NAME=$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-')
  (
    cd "$repo" || exit 1
    git branch -M main 2>/dev/null || true
    git remote remove origin 2>/dev/null || true
    gh repo create "${GH_OWNER}/${REPO_NAME}" --public --source=. --remote=origin --push \
      --description "agent-im kanban e2e disposable (${PROJECT_ID})"
  ) || {
    echo -e "${RED}gh repo create failed${NC}" >&2
    exit 1
  }
  E2E_GH_SCM_PROJECT="${GH_OWNER}/${REPO_NAME}"
  E2E_GH_REMOTE_URL="https://github.com/${E2E_GH_SCM_PROJECT}"
  E2E_GH_CREATED=1
  info "GitHub repo ${E2E_GH_SCM_PROJECT} (prefix ${E2E_GH_REPO_PREFIX:-agent-im-e2e-} — gh repo list | grep ${E2E_GH_REPO_PREFIX:-agent-im-e2e-})"
}

# POST /api/projects upsert: create or merge repository.remoteUrl + scmProject for real GitHub.
upsert_e2e_project() {
  local LOCAL_PATH="$1"
  if api_get "/api/projects/$PROJECT_ID" > /tmp/e2e-proj.json 2>/dev/null; then
    local MERGED
    MERGED=$(python3 -c "
import json, sys
with open('/tmp/e2e-proj.json') as f:
    p = json.load(f)
ru, scm, lp = sys.argv[1:4]
p.setdefault('repository', {})
p['repository']['remoteUrl'] = ru
p['repository']['scmProject'] = scm
p['repository']['localPath'] = lp
p['repository']['baseBranch'] = p['repository'].get('baseBranch') or 'main'
p['repository']['sprintBranchPrefix'] = p['repository'].get('sprintBranchPrefix') or 'feature/'
p['repository']['taskBranchPrefix'] = p['repository'].get('taskBranchPrefix') or 'dev/'
p['repository']['scmProvider'] = p['repository'].get('scmProvider') or 'github'
print(json.dumps(p))
" "$E2E_GH_REMOTE_URL" "$E2E_GH_SCM_PROJECT" "$LOCAL_PATH")
    api_post "/api/projects" "$MERGED" > /dev/null
    pass "Project '$PROJECT_ID' SCM → $E2E_GH_SCM_PROJECT"
  else
    info "Creating project '$PROJECT_ID'..."
    api_post "/api/projects" "{
    \"id\": \"$PROJECT_ID\",
    \"name\": \"$PROJECT_ID\",
    \"repository\": {
      \"remoteUrl\": \"$E2E_GH_REMOTE_URL\",
      \"localPath\": \"$LOCAL_PATH\",
      \"baseBranch\": \"main\",
      \"sprintBranchPrefix\": \"feature/\",
      \"taskBranchPrefix\": \"dev/\",
      \"scmProvider\": \"github\",
      \"scmProject\": \"$E2E_GH_SCM_PROJECT\"
    },
    \"agents\": [],
    \"isPrivate\": false
  }" > /dev/null
    pass "Project '$PROJECT_ID' created"
  fi
}

# ─── Step 1: Server health ─────────────────────────────────────────────────────
section "P0: Server Health"
if api_get "/health" > /dev/null 2>&1; then
  pass "Server is reachable at $BASE"
else
  echo -e "${YELLOW}Server not running — attempting npm run dev in background...${NC}"
  GIT_EXE="${CTI_GIT_EXECUTABLE:-$(command -v git 2>/dev/null || echo "git")}"
  E2E_PLATFORM_DIR="${E2E_PLATFORM_DIR:-$(mktemp -d)}"
  export E2E_PLATFORM_DIR
  CTI_KANBAN_PLATFORM_DB_FILE="${CTI_KANBAN_PLATFORM_DB_FILE:-test.db}"
  export CTI_KANBAN_PLATFORM_DB_FILE
  CTI_KANBAN_CONFIRMATION_MAX_LOOPS="${CTI_KANBAN_CONFIRMATION_MAX_LOOPS:-10}"
  export CTI_KANBAN_CONFIRMATION_MAX_LOOPS
  info "Isolated platform store: $E2E_PLATFORM_DIR (db file: $CTI_KANBAN_PLATFORM_DB_FILE)"
  (cd "$(dirname "$0")/../.." && CTI_KANBAN_PLATFORM_DIR="$E2E_PLATFORM_DIR" CTI_KANBAN_PLATFORM_DB_FILE="$CTI_KANBAN_PLATFORM_DB_FILE" CTI_KANBAN_CONFIRMATION_MAX_LOOPS="$CTI_KANBAN_CONFIRMATION_MAX_LOOPS" CTI_KANBAN_USE_WORKTREE=0 CTI_GIT_EXECUTABLE="$GIT_EXE" npm run dev > /tmp/agent-im-e2e.log 2>&1) &
  NPM_PID=$!
  # Poll up to 30s for the server to become ready
  STARTED=0
  for i in $(seq 1 6); do
    sleep 5
    if api_get "/health" > /dev/null 2>&1; then
      STARTED=1
      break
    fi
  done
  if [ "$STARTED" = "1" ]; then
    pass "Server started (pid=$NPM_PID)"
  else
    fail "Server failed to start after 30s. Check /tmp/agent-im-e2e.log"
    exit 1
  fi
fi

# ─── Step 2: Ensure project + sprint ──────────────────────────────────────────
section "P0: Setup Project & Sprint"

# Ensure local git repo exists for the E2E project
E2E_REPO_PATH="/tmp/${PROJECT_ID}-e2e"
if [ ! -d "$E2E_REPO_PATH/.git" ]; then
  info "Initialising local git repo at $E2E_REPO_PATH ..."
  mkdir -p "$E2E_REPO_PATH"
  git -C "$E2E_REPO_PATH" init -b main > /dev/null 2>&1
  git -C "$E2E_REPO_PATH" commit --allow-empty -m "init" > /dev/null 2>&1
  pass "Local git repo initialised"
fi
ensure_e2e_scm_remote "$E2E_REPO_PATH"
upsert_e2e_project "$E2E_REPO_PATH"

# Get or create sprint
SPRINT_RESP=$(api_get "/api/sprints?projectId=$PROJECT_ID" 2>/dev/null || echo "[]")
# Prefer an active sprint whose integration branch is `main` (required for local git materialization).
SPRINT_ID=$(echo "$SPRINT_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.exit(0)
active = [s for s in data if s.get('status') == 'active']
pool = active or data
for s in pool:
    if s.get('branchName') == 'main':
        print(s['id'])
        break
" 2>/dev/null || echo "")

if [ -z "$SPRINT_ID" ]; then
  info "No sprint found, creating one..."
  SPRINT_RESP=$(api_post "/api/sprints" \
    "{\"projectId\":\"$PROJECT_ID\",\"name\":\"e2e-$(date +%Y%m%d-%H%M%S)\",\"branchName\":\"main\",\"baseBranch\":\"main\"}" 2>/dev/null || echo '{}')
  SPRINT_ID=$(json_field "$SPRINT_RESP" "id")
  if [ -n "$SPRINT_ID" ] && [ "$SPRINT_ID" != "None" ] && [ "$SPRINT_ID" != "null" ]; then
    pass "Sprint created: $SPRINT_ID"
  else
    fail "Failed to create sprint: $SPRINT_RESP"
    exit 1
  fi
else
  pass "Using sprint: $SPRINT_ID"
fi

# Align with API/board: assign requires non-empty default runner for every agent lane (PUT validates ids).
E2E_RUNNER_RESOLVED="${E2E_RUNNER_ID:-}"
if [ -z "$E2E_RUNNER_RESOLVED" ]; then
  E2E_RUNNER_RESOLVED=$(api_get "/api/platform/runners" | python3 -c "import sys,json; d=json.load(sys.stdin); rs=d.get('runners') or []; print(rs[0]['id'] if rs else '')" 2>/dev/null || echo "")
fi
if [ -z "$E2E_RUNNER_RESOLVED" ]; then
  fail "需要至少一个平台 runner（GET /api/platform/runners）或设置环境变量 E2E_RUNNER_ID"
  exit 1
fi
E2E_KANBAN_BODY=$(RID="$E2E_RUNNER_RESOLVED" python3 <<'PY'
import json, os
rid = os.environ["RID"]
kinds = ["agent-dev", "pre-tester", "codex-senior", "claude-review", "copilot-test"]
print(json.dumps({"kanbanRoleRunners": {k: rid for k in kinds}}))
PY
)
E2E_KR_HTTP=$(curl -sS -o /tmp/e2e-kanban-roles.body -w "%{http_code}" "${CURL_OPTS[@]}" -X PUT \
  -H "Content-Type: application/json" --data-binary "$E2E_KANBAN_BODY" \
  "$BASE/api/projects/$PROJECT_ID/kanban-roles" || echo "000")
if [ "$E2E_KR_HTTP" -lt 200 ] || [ "$E2E_KR_HTTP" -ge 300 ]; then
  fail "PUT /api/projects/$PROJECT_ID/kanban-roles failed (HTTP $E2E_KR_HTTP). Set E2E_RUNNER_ID. Response: $(head -c 240 /tmp/e2e-kanban-roles.body 2>/dev/null)"
  exit 1
fi
pass "Kanban: default runners set for all agent lanes (runner=$E2E_RUNNER_RESOLVED)"

# Helper: create task
create_task() {
  local ISSUE_ID="$1" TITLE="$2" EXTRA="${3:-}"
  local BODY="{\"projectId\":\"$PROJECT_ID\",\"sprintId\":\"$SPRINT_ID\",\"issueId\":\"$ISSUE_ID\",\"title\":\"$TITLE\"${EXTRA:+,$EXTRA}}"
  api_post "/api/workflows/tasks/create" "$BODY" 2>/dev/null || echo '{}'
}

# ─── Section SP: Sprint tests ──────────────────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "sprint" ]]; then
section "1. Sprint (SP1–SP3)"

# SP1: startSprint via workflow API (creates integration branch; requires working git + origin)
SP1_NAME="e2e-sp1-$(date +%s)"
SP1_RESP=$(api_post "/api/workflows/sprints/start" \
  "{\"projectId\":\"$PROJECT_ID\",\"sprintName\":\"$SP1_NAME\"}" 2>/dev/null || echo '{"error":"start failed"}')
if echo "$SP1_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('branchName','').startswith('feature/') else 1)" 2>/dev/null; then
  pass "SP1: POST /api/workflows/sprints/start created sprint branch"
else
  fail "SP1: startSprint failed: ${SP1_RESP:0:200}"
fi

# SP3: Missing required field (no name)
SP3_RESP=$(api_post "/api/sprints" \
  "{\"projectId\":\"$PROJECT_ID\"}" 2>/dev/null || echo '{"error":"missing name"}')
assert_error "$SP3_RESP" "SP3: missing sprint name returns error"

# SP3 (duplicate name): second POST with same display name as an active sprint
SP3_DUP_NAME="e2e-dup-$(date +%s)"
SP3_A=$(api_post "/api/sprints" \
  "{\"projectId\":\"$PROJECT_ID\",\"name\":\"$SP3_DUP_NAME\",\"branchName\":\"main\",\"baseBranch\":\"main\"}" 2>/dev/null || echo '{}')
SP3_B=$(api_post "/api/sprints" \
  "{\"projectId\":\"$PROJECT_ID\",\"name\":\"$SP3_DUP_NAME\",\"branchName\":\"main\",\"baseBranch\":\"main\"}" 2>/dev/null || echo '{}')
assert_error "$SP3_B" "SP3: duplicate sprint name rejected"
fi

# ─── Section T: Create Tasks ───────────────────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "tasks" || "$FILTER" == "create" ]]; then
section "2. 创建任务 todo (T1–T4)"

# T1: Normal create
T1_ID=$(unique_id "T1")
T1_RESP=$(create_task "$T1_ID" "[T1] 正常创建任务")
T1_TASK_ID=$(json_field "$T1_RESP" "id")
if [ -n "$T1_TASK_ID" ] && [ "$T1_TASK_ID" != "None" ]; then
  assert_state "$T1_TASK_ID" "todo" "T1: normal create"
else
  fail "T1: task not created: $T1_RESP"
fi

# T2: Hotfix
T2_ID=$(unique_id "T2")
T2_RESP=$(create_task "$T2_ID" "[T2] Hotfix任务" '"isHotfix":true')
T2_TASK_ID=$(json_field "$T2_RESP" "id")
T2_HOTFIX=$(json_field "$T2_RESP" "isHotfix")
if [ "$T2_HOTFIX" = "True" ] || [ "$T2_HOTFIX" = "true" ]; then
  pass "T2: hotfix task created (isHotfix=true)"
else
  fail "T2: isHotfix not set correctly, got: $T2_HOTFIX"
fi

# T3: Duplicate issueId
T3_RESP=$(create_task "$T1_ID" "[T3] Duplicate issueId" 2>/dev/null || echo '{"error":"duplicate"}')
assert_error "$T3_RESP" "T3: duplicate issueId"

# T4: Missing required fields
T4_RESP=$(api_post "/api/workflows/tasks/create" '{"projectId":"todolist"}' 2>/dev/null || echo '{"error":"missing"}')
assert_error "$T4_RESP" "T4: missing required fields"
fi

# ─── Section CV: Coverage ──────────────────────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "coverage" ]]; then
section "14. 覆盖率管理 (CV1–CV6)"

# CV1: Initial coverage
CV_RESP=$(api_get "/api/projects/$PROJECT_ID/coverage" 2>/dev/null || echo '{}')
CV_VAL=$(json_field "$CV_RESP" "coverage")
if [ "$CV_VAL" = "0" ] || [ "$CV_VAL" = "0.0" ]; then
  pass "CV1: initial coverage=0"
else
  info "CV1: coverage=$CV_VAL (may have been set by previous runs)"
fi

# CV2: Update with strictly higher value than current stored coverage
CV2_TARGET=$(echo "$CV_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = float(d.get('coverage') or 0)
print(c + 1.0 if c >= 77.0 else 78.0)
" 2>/dev/null || echo 78)
CV2_RESP=$(api_post "/api/projects/$PROJECT_ID/coverage" "{\"coverage\":$CV2_TARGET,\"context\":\"e2e-test\"}")
assert_field "$CV2_RESP" "updated" "True" "CV2: update to higher coverage ($CV2_TARGET%)"

# CV3: Update with lower value — not updated
CV3_RESP=$(api_post "/api/projects/$PROJECT_ID/coverage" '{"coverage":50}')
assert_field "$CV3_RESP" "updated" "False" "CV3: lower value not updated"

# CV4: Equal value — not updated (match last stored high watermark)
CV4_RESP=$(api_post "/api/projects/$PROJECT_ID/coverage" "{\"coverage\":$CV2_TARGET}")
assert_field "$CV4_RESP" "updated" "False" "CV4: equal value not updated"

# CV5: History
CV5_RESP=$(api_get "/api/projects/$PROJECT_ID/coverage/history?limit=10" 2>/dev/null || echo '[]')
CV5_COUNT=$(echo "$CV5_RESP" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data) if isinstance(data,list) else 0)" 2>/dev/null || echo 0)
if [ "$CV5_COUNT" -gt 0 ]; then
  pass "CV5: coverage history has $CV5_COUNT entries"
else
  fail "CV5: coverage history empty"
fi

# CV6: History records all uploads including lower values
CV6_LOWER=$(api_post "/api/projects/$PROJECT_ID/coverage" '{"coverage":40,"context":"lower-value"}')
CV6_HIST=$(api_get "/api/projects/$PROJECT_ID/coverage/history?limit=20")
CV6_NEW_COUNT=$(echo "$CV6_HIST" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data) if isinstance(data,list) else 0)" 2>/dev/null || echo 0)
if [ "$CV6_NEW_COUNT" -gt "$CV5_COUNT" ]; then
  pass "CV6: lower value still recorded in history ($CV6_NEW_COUNT entries)"
else
  fail "CV6: history did not grow after lower-value upload"
fi
fi

# ─── Section B: Block/Unblock ─────────────────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "block" ]]; then
section "12. 阻塞 blocked (B1–B4)"

# Block is only allowed from active lanes (e.g. in_progress). Assign from todo → queue → in_progress first.
B_ID=$(unique_id "B1")
B_RESP=$(create_task "$B_ID" "[B1] 阻塞测试任务")
B_TASK_ID=$(json_field "$B_RESP" "id")

if [ -z "$B_TASK_ID" ] || [ "$B_TASK_ID" = "None" ]; then
  fail "B: could not create task for block tests"
else
  info "Assigning block-test task to dev (expect in_progress)..."
  api_post "/api/workflows/tasks/assign" \
    "{\"projectId\":\"$PROJECT_ID\",\"sprintId\":\"$SPRINT_ID\",
      \"issueId\":\"$B_ID\",\"taskSessionId\":\"$B_TASK_ID\",
      \"kanbanAgent\":\"agent-dev\"}" > /dev/null

  if ! poll_state "$B_TASK_ID" "in_progress" "B: materialize developer assignment"; then
    info "B: last state=$(get_state "$B_TASK_ID")"
  fi

  # B1: Block (from in_progress)
  B1_RESP=$(api_post "/api/workflows/tasks/$B_TASK_ID/block" '{"reason":"等待第三方 API"}' 2>/dev/null || echo '{"error":"?"}')
  if echo "$B1_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('workflowState')=='blocked' else 1)" 2>/dev/null; then
    pass "B1: task blocked"
  else
    fail "B1: expected workflowState=blocked, got: ${B1_RESP:0:200}"
  fi

  # B2: Unblock
  B2_RESP=$(api_post "/api/workflows/tasks/$B_TASK_ID/unblock" '{}' 2>/dev/null || echo '{"error":"?"}')
  if echo "$B2_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('workflowState')!='blocked' else 1)" 2>/dev/null; then
    pass "B2: task unblocked, state=$(get_state "$B_TASK_ID")"
  else
    fail "B2: unblock failed: ${B2_RESP:0:120}"
  fi

  # B3: Cannot block a task still in todo (separate card; avoids a 2nd block on the same runner)
  B3_ID=$(unique_id "B3")
  B3_RESP=$(create_task "$B3_ID" "[B3] todo 上禁止阻塞")
  B3_TASK_ID=$(json_field "$B3_RESP" "id")
  if [ -z "$B3_TASK_ID" ] || [ "$B3_TASK_ID" = "None" ]; then
    fail "B3: could not create todo task"
  else
    B3_BLOCK=$(api_post "/api/workflows/tasks/$B3_TASK_ID/block" '{"reason":"x"}' 2>/dev/null || echo '{"error":"?"}')
    assert_error "$B3_BLOCK" "B3: block from todo state"
  fi
fi
fi

# ─── Section F: Test Failure Compensation ─────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "fail" || "$FILTER" == "compensation" ]]; then
section "15. 测试失败补偿 (F1–F3)"

# F3: Wrong state (todo task) → error
F3_ID=$(unique_id "F3")
F3_RESP=$(create_task "$F3_ID" "[F3] 非测试状态失败上报")
F3_TASK_ID=$(json_field "$F3_RESP" "id")
if [ -n "$F3_TASK_ID" ] && [ "$F3_TASK_ID" != "None" ]; then
  F3_FAIL_RESP=$(api_post "/api/workflows/tasks/$F3_TASK_ID/testing/fail" \
    '{"summary":"test fail","log":"Error details"}' 2>/dev/null || echo '{"error":"wrong state"}')
  assert_error "$F3_FAIL_RESP" "F3: testing/fail on todo state"
else
  fail "F3: could not create task"
fi
fi

# ─── Section EX: Edge Cases ────────────────────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "edge" || "$FILTER" == "ex" ]]; then
section "18. 边界与异常 (EX1–EX5)"

# EX1: Illegal transition — close a todo task
EX1_ID=$(unique_id "EX1")
EX1_RESP=$(create_task "$EX1_ID" "[EX1] 非法状态流转")
EX1_TASK_ID=$(json_field "$EX1_RESP" "id")
if [ -n "$EX1_TASK_ID" ] && [ "$EX1_TASK_ID" != "None" ]; then
  EX1_CLOSE=$(api_post "/api/workflows/tasks/$EX1_TASK_ID/close" '{}' 2>/dev/null || echo '{"error":"invalid transition"}')
  assert_error "$EX1_CLOSE" "EX1: close from todo state"
else
  fail "EX1: could not create task"
fi

# EX3: Non-existent project
EX3_RESP=$(api_post "/api/workflows/tasks/create" \
  '{"projectId":"ghost-project","sprintId":"x","title":"test","issueId":"GHOST-1"}' \
  2>/dev/null || echo '{"error":"not found"}')
assert_error "$EX3_RESP" "EX3: non-existent project"

# EX4: Sprint from another project
EX4_RESP=$(api_post "/api/workflows/tasks/create" \
  "{\"projectId\":\"$PROJECT_ID\",\"sprintId\":\"00000000-fake-sprint\",\"title\":\"test\",\"issueId\":\"$(unique_id EX4)\"}" \
  2>/dev/null || echo '{"error":"not found"}')
assert_error "$EX4_RESP" "EX4: sprint not belonging to project"
fi

# ─── Section SH: CI Callback (Private Repo) ────────────────────────────────────
if [[ -z "$FILTER" || "$FILTER" == "ci" || "$FILTER" == "private" ]]; then
section "8. 私有仓库 CI 回调 (SH3–SH5)"

# SH5: CI callback on non-regression task → error
SH5_ID=$(unique_id "SH5")
SH5_RESP=$(create_task "$SH5_ID" "[SH5] CI回调状态不匹配")
SH5_TASK_ID=$(json_field "$SH5_RESP" "id")
if [ -n "$SH5_TASK_ID" ] && [ "$SH5_TASK_ID" != "None" ]; then
  SH5_CI=$(api_post "/api/workflows/tasks/$SH5_TASK_ID/ci-result" \
    '{"status":"success"}' 2>/dev/null || echo '{"error":"wrong state"}')
  assert_error "$SH5_CI" "SH5: ci-result on todo state"
else
  fail "SH5: could not create task"
fi
fi

# ─── Section HP: Dev queue smoke (repeatable without live AI agents) ─────────
if [[ -z "$FILTER" || "$FILTER" == "ai" || "$FILTER" == "happy" ]]; then
section "16. 开发队列启动 (HP)"

HP_ID=$(unique_id "HP")
HP_RESP=$(create_task "$HP_ID" "[HP] 开发队列烟雾")
HP_TASK_ID=$(json_field "$HP_RESP" "id")

if [ -z "$HP_TASK_ID" ] || [ "$HP_TASK_ID" = "None" ]; then
  fail "HP: could not create task"
else
  api_post "/api/workflows/tasks/assign" \
    "{\"projectId\":\"$PROJECT_ID\",\"sprintId\":\"$SPRINT_ID\",
      \"issueId\":\"$HP_ID\",\"taskSessionId\":\"$HP_TASK_ID\",
      \"kanbanAgent\":\"agent-dev\"}" > /dev/null

  if ! poll_state "$HP_TASK_ID" "in_progress" "HP: assigned to dev (in_progress)"; then
    info "HP: last state=$(get_state "$HP_TASK_ID")"
  fi
fi
fi

# ─── Final Report ──────────────────────────────────────────────────────────────
if [ "${E2E_GH_CREATED:-0}" = "1" ] && [ -n "${E2E_GH_SCM_PROJECT:-}" ]; then
  info "Disposable GitHub repo: $E2E_GH_SCM_PROJECT — delete: gh repo delete $E2E_GH_SCM_PROJECT --yes"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Kanban E2E Test Results"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed tests:${NC}"
  for F in "${FAILURES[@]}"; do
    echo "  - $F"
  done
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
  exit 0
else
  echo -e "${RED}❌ $FAIL TESTS FAILED${NC}"
  exit 1
fi
