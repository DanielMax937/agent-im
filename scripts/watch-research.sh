#!/usr/bin/env bash
# Poll agent-im Research mode session progress until terminal phase or Ctrl+C.
#
# Usage:
#   bash scripts/watch-research.sh <folder> <sessionId> [interval_sec] [base_url]
#   bash scripts/watch-research.sh --once <folder> <sessionId> [base_url]
#
# Examples:
#   bash scripts/watch-research.sh /Users/me/competition_handoff_docs 92bacdc8-3c80-4d7d-aa76-265f2806c196
#   bash scripts/watch-research.sh /Users/me/proj abc-123 10
#   bash scripts/watch-research.sh --once /Users/me/proj abc-123 http://localhost:3300

set -euo pipefail

ONCE=0
if [[ "${1:-}" == "--once" || "${1:-}" == "-1" ]]; then
  ONCE=1
  shift
fi

FOLDER="${1:-}"
SID="${2:-}"
INTERVAL="${3:-15}"
BASE_URL="${4:-${RESEARCH_API_BASE:-http://localhost:3300}}"

usage() {
  cat <<'EOF'
Usage:
  watch-research.sh <folder> <sessionId> [interval_sec] [base_url]
  watch-research.sh --once <folder> <sessionId> [base_url]

Environment:
  RESEARCH_API_BASE   default http://localhost:3300

Terminal phases (loop exits): completed, failed, timeout, aborted
EOF
  exit 1
}

if [[ -z "$FOLDER" || -z "$SID" ]]; then
  usage
fi

FOLDER="$(cd "$FOLDER" 2>/dev/null && pwd || echo "$FOLDER")"
BASE_URL="${BASE_URL%/}"

if [[ "$ONCE" == 0 && "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -lt 1 ]]; then
  echo "interval_sec must be >= 1" >&2
  exit 1
fi

# If third arg looks like URL (loop mode), treat it as base_url
if [[ "$ONCE" == 0 && "$INTERVAL" == http* ]]; then
  BASE_URL="$INTERVAL"
  INTERVAL=15
fi

if [[ "$ONCE" == 1 && "${3:-}" == http* ]]; then
  BASE_URL="$3"
fi

have_jq() { command -v jq >/dev/null 2>&1; }

fetch_state() {
  local url="${BASE_URL}/api/research/${SID}?folder=${FOLDER}"
  local body http_code
  body="$(curl -sfS -m 15 "$url" 2>&1)" || {
    echo "ERROR: curl failed for $url" >&2
    echo "$body" >&2
    return 1
  }
  printf '%s' "$body"
}

print_summary() {
  local body="$1"
  if have_jq; then
    echo "$body" | jq '{
      phase: .state.phase,
      turn: .state.turn,
      maxTurns: .state.maxTurns,
      runnerA: .state.runnerA,
      runnerB: .state.runnerB,
      updatedAt: .state.updatedAt,
      finishedAt: .state.finishedAt,
      finishedReason: .state.finishedReason,
      lastStatus: .state.lastStatus,
      lastVerdict: .state.lastVerdict,
      resultPath: .resultPath
    }'
  else
    python3 - <<'PY' "$body"
import json, sys
body = sys.argv[1]
d = json.loads(body)
s = d.get("state") or {}
print("phase:", s.get("phase"))
print("turn:", s.get("turn"), "/", s.get("maxTurns"))
print("runnerA:", s.get("runnerA"), "runnerB:", s.get("runnerB"))
print("updatedAt:", s.get("updatedAt"))
if s.get("finishedAt"):
    print("finishedAt:", s.get("finishedAt"))
if s.get("finishedReason"):
    print("finishedReason:", s.get("finishedReason"))
if s.get("lastStatus"):
    print("lastStatus:", json.dumps(s["lastStatus"], ensure_ascii=False))
if s.get("lastVerdict"):
    print("lastVerdict:", json.dumps(s["lastVerdict"], ensure_ascii=False))
print("resultPath:", d.get("resultPath"))
PY
  fi
}

is_terminal_phase() {
  local phase="$1"
  case "$phase" in
    completed|failed|timeout|aborted) return 0 ;;
    *) return 1 ;;
  esac
}

get_phase() {
  local body="$1"
  if have_jq; then
    echo "$body" | jq -r '.state.phase // empty'
  else
    echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',{}).get('phase',''))"
  fi
}

poll_once() {
  local body phase
  body="$(fetch_state)"
  phase="$(get_phase "$body")"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "folder:   $FOLDER"
  echo "session:  $SID"
  echo "api:      $BASE_URL"
  echo "---"
  print_summary "$body"
  echo
  if is_terminal_phase "$phase"; then
    echo ">>> Session ended (phase=$phase). Loop stopping."
    if have_jq; then
      local rp
      rp="$(echo "$body" | jq -r '.resultPath // empty')"
      if [[ -n "$rp" && -f "$rp" ]]; then
        echo ">>> Result file:"
        head -30 "$rp"
      fi
    fi
    return 2
  fi
  return 0
}

if [[ "$ONCE" == 1 ]]; then
  poll_once || exit $?
  exit 0
fi

echo "Watching research session (every ${INTERVAL}s). Ctrl+C to stop."
echo "folder=$FOLDER session=$SID"
echo

while true; do
  if [[ -t 1 ]]; then
    clear
  fi
  set +e
  poll_once
  rc=$?
  set -e
  if [[ "$rc" == 2 ]]; then
    exit 0
  fi
  if [[ "$rc" != 0 ]]; then
    exit "$rc"
  fi
  sleep "$INTERVAL"
done
