# AGENTS.md

## Cursor Cloud specific instructions

### Overview

claude-to-im-skill is a Node.js/TypeScript daemon that bridges IM platforms (Telegram, Discord, Feishu/Lark, QQ) to AI coding agents (Claude Code, Codex, Cursor). It requires Node.js >= 20 and uses npm as its package manager.

### Key commands

See `package.json` scripts and README "Development" section. Summary:

- **Install**: `npm install`
- **Dev mode**: `npm run dev` (runs `tsx src/main.ts`)
- **Typecheck**: `npm run typecheck` (pre-existing TS errors exist in `src/lib/bridge/` — these are known)
- **Tests**: `npm test` (uses Node.js built-in test runner with `tsx` loader; all 128 tests should pass)
- **Build**: `npm run build` (produces `dist/daemon.mjs` via esbuild)

### Non-obvious caveats

- **Console output is redirected to log file**: `setupLogger()` in `src/logger.ts` overrides `console.log/error/warn` to write to `$CTI_HOME/logs/bridge.log`. When running `npm run dev`, you will see no stdout/stderr output. Check `~/.claude-to-im/logs/bridge.log` (or `$CTI_HOME/logs/bridge.log`) for daemon output.
- **CTI_HOME**: Defaults to `~/.claude-to-im/`. Override with `CTI_HOME` env var. Tests use `CTI_HOME=$(mktemp -d)` to isolate state.
- **Running the daemon requires IM bot tokens**: The daemon connects to IM platform APIs. Without valid tokens in `$CTI_HOME/config.env`, adapters will log errors but the daemon still starts and runs its event loop. This is expected behavior in a dev environment without tokens.
- **CTI_RUNTIME**: Controls which AI backend is used (`claude`, `codex`, `cursor`, or `auto`). Default is `claude`, which requires the `claude` CLI to be installed. Use `CTI_RUNTIME=codex` for development without the Claude CLI.
- **Optional dependencies**: `@openai/codex-sdk` and `redis` are optional. They install automatically with `npm install` but won't block the build if they fail.
- **TypeScript errors**: There are pre-existing type errors (e.g., missing arguments in adapter files, `toSorted` needing ES2023 lib). These do not affect tests or the build (esbuild bypasses type checking).
