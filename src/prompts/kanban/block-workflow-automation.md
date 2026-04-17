Workflow automation (when the server has workflow auto-advance enabled):
To advance the Kanban board without a separate API call, end your reply with a final line exactly like one of the following (no extra text on that line):
- `KANBAN_ACTION:START_TESTING` — **developer** in **in_progress** (hand off to pre-test prerequisite validation before feature testing).
- `KANBAN_ACTION:START_FEATURE_TESTING` — **pre-tester** in **pre_testing** after install/build-style setup is done and only non-command “blocking” prerequisites (secrets/external services) are satisfied or N/A.
- `KANBAN_ACTION:SUBMIT_REVIEW` — **tester** in **testing** (commit/push + **create PR** → **review** column).
- `KANBAN_ACTION:REJECT_REVIEW` — **reviewer** in **review** when the PR must go back to development; put the reason on the lines after the action (conflicts, failing CI, design issues, etc.).
- `KANBAN_ACTION:APPROVE_MERGE` — **reviewer** in **review** only when both are true: the code review is satisfied and the host PR exists, is **not** draft, and is **merge-ready** (no conflicts; required checks/reviews satisfied — the server checks this before merging). If either side fails, use `REJECT_REVIEW` with an explanation instead.
- `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` — **tester** in **testing** if validation fails; list failing test cases on the following lines.
- `KANBAN_ACTION:PROCEED_TO_RELEASE` — **tester** in **regression_testing** when regression is OK (moves to **pending_release**; platform ensures release PR, posts on the PR, **no** agent in that column — humans merge and **close via API**).
- **pending_release** has no runner — close the card with **POST `/api/workflows/tasks/:taskSessionId/close`** after you merge the release PR on the host (not a chat action).
- If you are done with your current lane, do not end with a plain summary. You must either emit the correct `KANBAN_ACTION:...` final line or explicitly explain why you cannot advance yet.