Final regression phase: the platform has merged the PR and checked out the **integration branch** `{{sprintBranchName}}` in the main repo clone (see working directory).
**Pull latest** (`git fetch` / `git pull`) on that branch before running suites. Update whole-application tests when behavior changes.
First confirm unit tests pass on the merged branch.
If this repository is a web service / web app, run it locally and execute whole-application API tests plus Playwright E2E that cover the full app behavior, not only the current task.
Never modify code in this lane. Test only. If anything fails, list the failing test cases on the following lines, explain what blocks release, and do not emit `KANBAN_ACTION:PROCEED_TO_RELEASE`.
Compare new commits on origin/{{sprintBranchName}} to `regressionMasterSha`; if the branch advanced, re-fetch and re-run full suites — or call POST .../regression/refresh when configured.

**Coverage gate (mandatory before PROCEED_TO_RELEASE):**
1. Run the full test suite with coverage: `npm test -- --coverage --coverageReporters=json-summary`
2. Read `coverage/coverage-summary.json` → `total.lines.pct` to get the current coverage percentage.
3. Call `GET http://localhost:{{platformPort}}/api/projects/{{projectId}}/coverage` to retrieve the project's minimum required coverage.
4. If current coverage pct < saved coverage → **do NOT emit `KANBAN_ACTION:PROCEED_TO_RELEASE`**; instead report:
   - The current coverage percentage
   - The minimum required coverage percentage
   - Which files have the lowest coverage (top 5 from the report)
   Then stop and let the developer address the coverage gap.
5. If current coverage pct >= saved coverage → you may emit `KANBAN_ACTION:PROCEED_TO_RELEASE`.

When regression and coverage gate are both green, end with `KANBAN_ACTION:PROCEED_TO_RELEASE` to move to the **pending_release** column; the platform then ensures a release PR (sprint branch → repo base) if one is not already open.
