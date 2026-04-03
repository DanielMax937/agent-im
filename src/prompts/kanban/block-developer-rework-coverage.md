- COVERAGE REJECTION: This task was returned because of insufficient coverage. Follow these steps in order:
  1. Run the test suite with coverage: `npm test -- --coverage --coverageReporters=json-summary`
  2. Open `coverage/coverage-summary.json` and identify all **changed files** that have less than 100% line coverage.
  3. Add or improve unit tests for those files until each changed file is fully covered.
  4. Then find the file with the lowest overall coverage in the summary and write tests for it.
  5. Repeat step 4 until the project total lines coverage meets or exceeds the minimum required (stated in the rejection note).
  6. Only after the required total coverage is reached, commit, push, and hand off.