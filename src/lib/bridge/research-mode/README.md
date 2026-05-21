# Research mode

Two-agent research / work loop, modelled after Auto mode but driven by an
HTTP API and a `goal.md` file rather than an IM channel.

| Concept             | Auto mode               | Research mode                                    |
|---------------------|--------------------------|---------------------------------------------------|
| Trigger             | Telegram message / Redis | `POST /api/research`                              |
| Goal source         | User's IM message        | `<folder>/goal.md` (re-read every turn)           |
| Agent A             | Slave (executor)         | Researcher (executor with tools)                  |
| Agent B             | Master (no tools)        | Senior Reviewer (**full tools**, judgment-first)  |
| Transport (primary) | Redis queues             | Filesystem (`<folder>/.research/`)                 |
| Transport (mirror)  | —                        | Redis (`cti:research:{bridgeSlug}:{sessionId}:*`) |
| Result              | Telegram message         | `<folder>/.research/result-<sid>.md` + optional Telegram |

## Loop

```
        ┌────────────────────────────┐
        │ POST /api/research         │
        │ { folder, maxTurns?, … }   │
        └────────────┬───────────────┘
                     ▼
       read goal.md, create session
                     │
                     ▼
        ┌──────── orchestrator loop ─────────┐
        │                                    │
        │  → A (researcher)                  │
        │     emits RESEARCH_A_STATUS_JSON   │
        │     phase ∈ {plan, blocker,        │
        │              complete}             │
        │                                    │
        │  → B (reviewer)                    │
        │     emits RESEARCH_B_VERDICT_JSON  │
        │     verdict ∈ {approve-plan,       │
        │       request-changes,             │
        │       suggest-direction,           │
        │       confirm-complete,            │
        │       reject-complete}             │
        │                                    │
        │  isMutualCompletion?               │
        │   ├─ yes → write result.md, stop   │
        │   └─ no  → feed verdict to A       │
        │                                    │
        └────────────────────────────────────┘
```

The task is considered done **only** when A emits `phase: "complete"` AND B
responds with `verdict: "confirm-complete"` on the very next reviewer turn.

## Files

- `protocol.ts` — JSON marker definitions + robust parser (scans the last
  line for the tagged prefix; tolerates extra code fences / whitespace).
- `session-store.ts` — Filesystem state (`state.json`, `transcript.jsonl`,
  `result-<sid>.md`). Source of truth.
- `redis-mirror.ts` — Optional best-effort mirror that re-pushes turns to
  `cti:research:{bridgeSlug}:{sessionId}:turns` so the existing monitor page
  can peek at them. Skipped when no Redis URL is configured.
- `telegram-notify.ts` — Optional completion notice via the configured
  Telegram bot token (Auto-mode key: `telegram_bot_token`).
- `orchestrator.ts` — The loop itself, plus two helpers that build the
  per-turn prompts from `src/prompts/bridge/research-mode-*.md`.

The HTTP layer lives in `src/app/api/research/route.ts` (POST/GET list) and
`src/app/api/research/[id]/route.ts` (per-session GET).

## Quick start (smoke test)

```bash
mkdir -p /tmp/research-demo
cat > /tmp/research-demo/goal.md <<'EOF'
Add a hello.txt file containing "hi" to this folder.
EOF

curl -s -X POST http://localhost:3300/api/research \
  -H 'content-type: application/json' \
  -d '{"folder": "/tmp/research-demo", "maxTurns": 6}'

# poll
SID=...  # session id returned by the POST above
curl -s "http://localhost:3300/api/research/$SID?folder=/tmp/research-demo&transcript=1" | jq .

cat /tmp/research-demo/.research/result-$SID.md
```

## Configuration

Research mode is an **agent-im platform-level** feature: it runs inside the
agent-im HTTP process (the `kanban` bridge) and is **independent of any IM
bot**. Stopping `mybot` / `discord` / etc. does not stop Research mode.

### Top-level `Config.research` (`CTI_RESEARCH` env var)

Persisted as a single JSON value in the `kanban` bridge's `config.env`:

```bash
CTI_RESEARCH={"researcherRunner":{"id":"claude-a","runtime":"claude"},"reviewerRunner":{"id":"codex-b","runtime":"codex"},"defaultMaxTurns":30}
```

| Field              | Purpose                                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------------------|
| `researcherRunner` | Runner profile that powers **Agent A**. Built into a dedicated `LLMProvider` by `buildImBridgeLlmStack`.         |
| `reviewerRunner`   | Runner profile that powers **Agent B**. Built into a dedicated `LLMProvider` by `buildImBridgeLlmStack`.         |
| `defaultMaxTurns`  | Default `maxTurns` for `POST /api/research` when the request body omits it (orchestrator hard default: `30`).    |

Either side may be omitted — the orchestrator then falls back to the bridge
default LLM. `POST /api/research { runnerA, runnerB }` still overrides on a
per-call basis.

The admin page (`/admin`) renders a top-level **Research 模式** card that
edits these fields and saves them to the `kanban` bridge's `config.env`.

> **Legacy migration.** Earlier versions stored these inside
> `imBot.researchResearcherRunner` / `researchReviewerRunner` on each
> bridge's `imBot` config. `loadConfig` still reads those legacy fields and
> lifts them up to `Config.research` automatically; the next `saveConfig`
> drops them from `CTI_IM_BOT` so there is only one source of truth.

### Telegram mirror (every agent reply)

By default, **each Agent A and Agent B reply** is sent to Telegram, plus a short
summary when the session ends — same bot token / chat as Auto mode
(`imBot.tgBotToken` + `imBot.tgChatId`, usually on the `mybot` bridge).

Resolution order:

1. `POST /api/research` body `notifyTelegram: { chatId?, instanceId?, bridgeSlug? }` (override chat or pin a bridge for token lookup)
2. Scan all bridge `config.env` files — prefers `mybot`, then bridges with `autoMode` / `autoRedisUrl`, then `kanban`
3. Platform JsonFileStore keys `telegram_bot_token` / `telegram_chat_id` (hybrid Auto instances first)
4. Env `CTI_TELEGRAM_BOT_TOKEN` + `CTI_TG_CHAT_ID`

Message format (HTML):

- `[researcher] turn N · session …` — Agent A reply (parallel to Auto `[master]` / `[slave]`)
- `[reviewer] turn N · session …` — Agent B reply
- Final `Research mode — completed|failed|…` block with folder / result path

Omit `notifyTelegram` entirely to use auto-resolution; you do **not** need to pass `chatId` if `mybot` (or kanban) already has Telegram configured.

### Other env vars

| Env var                   | Purpose                                                                 |
|---------------------------|--------------------------------------------------------------------------|
| `CTI_RESEARCH_REDIS_URL`  | Redis URL for the optional mirror; falls back to `CTI_TELEGRAM_AUTO_REDIS_URL` / `CTI_AUTO_REDIS_URL` / `CTI_LOCAL_AGENT_REDIS_URL`. Leave unset to disable mirroring entirely. |
| `CTI_TELEGRAM_BOT_TOKEN`  | Env fallback for the bot token when store/config lack `tgBotToken`. |
| `CTI_TG_CHAT_ID`          | Env fallback for the notify chat when store/config lack `tgChatId`. |

## Constraints

- Tool access is **enabled for both** A and B (per design — B can verify A's
  claims). The conversation engine does not strip tools in research mode.
- Each session creates two underlying CodePilot sessions (one per agent) so
  prompt history is isolated. Sessions are not surfaced in the IM bindings
  list because their synthetic `channelType` is `research:researcher` /
  `research:reviewer`.
- The orchestrator runs entirely in-process. It does **not** start any
  separate slave child process; Auto-mode's `slave-process.ts` is untouched.

## Where to look when something goes wrong

1. `<folder>/.research/sessions/<sid>/state.json` — terminal phase + reason.
2. `<folder>/.research/sessions/<sid>/transcript.jsonl` — every turn (A reply,
   B reply, orchestrator note). `parseError` is recorded when an agent failed
   to emit a valid tagged JSON line.
3. App logs: `pino` events `research_loop_start`, `research_loop_exception`,
   `research_session_loop_unhandled`, `research_a_error`, `research_b_error`.
