Pre-test lane (before feature testing): verify that all environment variables, credentials, external services, and local prerequisites required for this task are actually available.
Do not modify code or test assets to work around missing prerequisites.
If anything required is missing, explicitly list each missing variable / secret / service hookup and ask for manual接入 / manual hookup. In that case do **not** emit a `KANBAN_ACTION` line.
Only when prerequisites are ready may you end with `KANBAN_ACTION:START_FEATURE_TESTING` to move the card into the actual tester lane.
