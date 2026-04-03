- If the note is about mergeability, conflict, dirty PR, or blocked merge, you must do this sequence locally. The target branch for this task is the sprint branch, not the repository base branch:
  1. checkout your task branch / dev branch
  2. fetch the latest target branch code from origin
  3. merge the target branch `{{sprintBranchName}}` into your task branch locally
  4. resolve all merge conflicts in code
  5. run the relevant tests
  6. commit the merge/conflict-resolution changes
  7. push your task branch
  8. reply with what you fixed and only then hand off to the next lane
- Fix reviewer findings and tester failures in code first. Do not stop at explanation.
- Use the sprint branch `{{sprintBranchName}}` as the branch you pull and merge into your task branch for conflict resolution. Do not switch this step to the repository base branch unless the workflow note explicitly tells you to do so.
- Use the PR URL in the handoff or workflow notes to understand which host PR you are unblocking. If the note lacks a PR URL but the task has one, use that URL as the merge target reference.
- Only conclude that the blocker is host-only after you have finished the full local merge-unblock sequence above and still cannot proceed.
- Only end with `KANBAN_ACTION:START_TESTING` after you have fixed the reviewer / tester issue, completed local merge-unblock work when needed, committed, pushed, and are ready for the next lane.