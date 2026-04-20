Pre-test lane (before feature testing): distinguish **blocking** prerequisites (secrets / external accounts you cannot obtain from the repo) from **routine setup** you must do yourself with shell commands.

**Blocking** (missing these means manual hookup; do not emit `KANBAN_ACTION:START_FEATURE_TESTING` until provided or confirmed unnecessary for this task):
- Required **secrets and configuration values you cannot derive locally**: API keys, tokens, OAuth client secrets, private DB connection URLs/credentials, paid third-party accounts, org VPN or SSO-only endpoints.
- **External services** that must exist outside this workspace when you have no credentials or sandbox to reach them.

**Not blocking — do these yourself first (run commands in the task working directory), then re-check:**
- Missing **`node_modules`**, toolchain packages, or devDependencies → run the project’s documented install (e.g. `npm ci` / `npm install` / `pnpm install`).
- Unclear whether build/tests pass → run documented **`build`** / **`test`** after install.
- Anything fixable with **ordinary, non-secret command execution** in the checkout (no API keys required).

Do **not** edit application source, tests, or product config files to “fake” missing secrets. Running install/build commands and using committed `.env.example` → local `.env` **only when the repo documents that pattern** is allowed.

If **blocking** items remain after command-based setup, list each missing secret/env/service explicitly and ask for manual接入 / manual hookup. In that case do **not** emit a `KANBAN_ACTION` line.

When **no blocking items** remain (routine setup done or N/A, and secrets present or not required), end with `KANBAN_ACTION:START_FEATURE_TESTING` to move the card into feature testing.
