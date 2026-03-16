# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Claude-to-IM Skill is a Node.js TypeScript daemon that bridges AI coding agents (Claude Code, Codex, Cursor) to IM platforms (Telegram, Discord, Feishu/Lark, QQ). See `README.md` for full details.

### Development commands

Standard commands are in `package.json` scripts:

- `npm install` — install dependencies
- `npm test` — run unit tests (128 tests, uses Node.js built-in test runner with `tsx`)
- `npm run typecheck` — TypeScript type checking (pre-existing errors exist with `toSorted` / adapter arguments; tracked upstream)
- `npm run build` — esbuild bundle to `dist/daemon.mjs`
- `npm run dev` — run daemon via `tsx src/main.ts`

### Non-obvious caveats

- **Console output is redirected to file**: `setupLogger()` in `src/logger.ts` replaces `console.log`/`console.error`/`console.warn` with file-based logging to `$CTI_HOME/logs/bridge.log`. When running `npm run dev`, there will be **no terminal output**. Check the log file instead.
- **Config is file-based, not env-var-based**: The daemon reads config from `$CTI_HOME/config.env` (default `~/.claude-to-im/config.env`), not from environment variables. Use `CTI_HOME` env var to point to a custom config directory.
- **IM bot tokens required for runtime**: The daemon needs at least one valid IM bot token to do anything useful. Tests mock all external dependencies so no tokens are needed for `npm test`.
- **`CTI_RUNTIME` determines LLM backend**: Default is `claude` (requires Claude CLI installed). Use `codex` or `auto` to avoid the Claude CLI requirement. Set this in the config file, not as an env var.
- **TypeScript typecheck has pre-existing errors**: `npm run typecheck` reports errors related to `toSorted()` (needs `lib: ES2023+`) and adapter argument mismatches. These are known upstream issues. The build (`npm run build`) and tests pass regardless.
