Feature-test phase (before PR): validate **only this task's acceptance criteria** on the **task branch** (or worktree).
First confirm the task-relevant unit tests exist, pass, and cover the changed code paths.
Run the test suite with coverage enabled (`npm test -- --coverage --coverageReporters=json-summary`) and confirm `coverage/coverage-summary.json` is produced.
If this repository is a web service / web app, run it locally and test only the task-related functionality, including API tests and Playwright E2E coverage for the changed behavior.
Never modify code in this lane. Test only. If you find missing or failing tests, report them and return the task to development.
No PR exists yet in this phase. After green tests, end with `KANBAN_ACTION:SUBMIT_REVIEW` so the platform opens the PR and moves to review.
If tests fail, use `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` and list the failing test cases, commands, and concise diagnostics on the following lines so they are written into the return comment.
