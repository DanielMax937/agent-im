#!/usr/bin/env bash
set -euo pipefail
# Create a Kanban task via agent-im API; optionally assign from todo to a lane.
# Usage: create-kanban-task.sh <projectId> <title> [kanbanAgent]
#   kanbanAgent: optional, e.g. agent-dev or codex-senior (omit to leave task in todo)
# Env: AGENT_IM_BASE_URL (default http://127.0.0.1:3300)

export AGENT_IM_BASE_URL="${AGENT_IM_BASE_URL:-http://127.0.0.1:3300}"
export PROJECT_ID="${1:?usage: $0 <projectId> <title> [kanbanAgent]}"
export TASK_TITLE="${2:?title}"
export KANBAN_AGENT="${3:-}"

python3 <<'PY'
import json, os, sys, urllib.error, urllib.parse, urllib.request

base = os.environ["AGENT_IM_BASE_URL"].rstrip("/")
project_id = os.environ["PROJECT_ID"]
title = os.environ["TASK_TITLE"]
kanban = os.environ.get("KANBAN_AGENT", "").strip()


def req(method, path, data=None):
    url = base + path
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw = resp.read().decode()
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        raise SystemExit(f"HTTP {e.code}: {raw}") from e
    if not raw.strip():
        return code, {}
    return code, json.loads(raw)


_, sprints = req("GET", "/api/sprints?projectId=" + urllib.parse.quote(project_id))
if not isinstance(sprints, list) or len(sprints) == 0:
    sys.exit("No sprints for project; create one via POST /api/workflows/sprints/start")
sprint_id = sprints[0]["id"]

code, created = req(
    "POST",
    "/api/workflows/tasks/create",
    {"projectId": project_id, "sprintId": sprint_id, "title": title},
)
if code not in (200, 201) or not created.get("id"):
    print(json.dumps(created, indent=2, ensure_ascii=False))
    sys.exit(f"create failed: HTTP {code}")
print(
    json.dumps(
        {"step": "created", "taskSessionId": created["id"], "issueId": created["issueId"]},
        indent=2,
        ensure_ascii=False,
    )
)

if kanban:
    code2, assigned = req(
        "POST",
        "/api/workflows/tasks/assign",
        {
            "projectId": project_id,
            "sprintId": sprint_id,
            "issueId": created["issueId"],
            "taskSessionId": created["id"],
            "kanbanAgent": kanban,
        },
    )
    if code2 not in (200, 201):
        print(json.dumps(assigned, indent=2, ensure_ascii=False))
        sys.exit(f"assign failed: HTTP {code2}")
    print(
        json.dumps(
            {
                "step": "assigned",
                "kanbanAgent": kanban,
                "workflowState": assigned.get("workflowState"),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
PY
