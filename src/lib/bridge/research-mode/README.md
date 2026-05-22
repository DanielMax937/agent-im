# Research mode

Two-agent research / work loop, modelled after Auto mode but driven by an
HTTP API and a `goal.md` file rather than an IM channel.

Research mode uses its own **dedicated bridge** at `~/.claude-to-im/research/`,
keeping it fully independent from the Kanban platform and IM bridges.

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

Research mode has its own **dedicated bridge** configuration at `~/.claude-to-im/research/`
(or `CTI_RESEARCH_HOME` if set). This keeps Research mode fully independent from
the Kanban platform bridge.

### Directory structure

```
~/.claude-to-im/
├── kanban/                    # Kanban/Platform bridge (for workflows, Kanban UI)
├── mybot/                     # IM bridges (Telegram, Discord, etc.)
└── research/                  # Research mode dedicated bridge (NEW)
    └── config.env             # CTI_RUNNERS, CTI_RESEARCH, etc.
```

### Research bridge config.env

Create `~/.claude-to-im/research/config.env` with your runner and Research configuration:

```bash
# Runtime setting
CTI_RUNTIME=claude

# Runner configurations for Agent A (researcher) and Agent B (reviewer)
CTI_RUNNERS=[{"id":"researcher","runtime":"claude","label":"Researcher"},{"id":"reviewer","runtime":"codex","label":"Reviewer"}]

# Research mode specific settings (including dedicated Telegram)
CTI_RESEARCH={
  "researcherRunner":{"id":"researcher","runtime":"claude"},
  "reviewerRunner":{"id":"reviewer","runtime":"codex"},
  "defaultMaxTurns":30,
  "telegram":{
    "botToken":"123456:ABC-DEF",
    "chatId":"123456789"
  }
}
```

### CTI_RESEARCH Configuration

| Field              | Purpose                                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------------------|
| `researcherRunner` | Runner profile that powers **Agent A**. Built into a dedicated `LLMProvider` by `buildImBridgeLlmStack`.         |
| `reviewerRunner`   | Runner profile that powers **Agent B**. Built into a dedicated `LLMProvider` by `buildImBridgeLlmStack`.         |
| `defaultMaxTurns`  | Default `maxTurns` for `POST /api/research` when the request body omits it (orchestrator hard default: `30`).    |
| `telegram`         | Dedicated Telegram bot token and chat ID for Research notifications. When set, this takes precedence over all other Telegram sources. |

Either side may be omitted — the orchestrator then falls back to the bridge
default LLM. `POST /api/research { runnerA, runnerB }` still overrides on a
per-call basis.

### Fallback behavior

If the Research bridge directory (`~/.claude-to-im/research/`) does not exist,
Research mode falls back to using the global BridgeContext (the `kanban` bridge
configuration). This ensures backward compatibility for existing deployments.

### Environment variables

| Env var                   | Purpose                                                                 |
|---------------------------|--------------------------------------------------------------------------|
| `CTI_RESEARCH_HOME`       | Override Research bridge directory (default: `~/.claude-to-im/research`) |
| `CTI_RESEARCH_REDIS_URL`  | Redis URL for the optional mirror; falls back to `CTI_TELEGRAM_AUTO_REDIS_URL` / `CTI_AUTO_REDIS_URL` / `CTI_LOCAL_AGENT_REDIS_URL`. Leave unset to disable mirroring entirely. |

### Admin page

The admin page (`/admin`) renders a top-level **Research 模式** card that
edits these fields and saves them to the `research` bridge's `config.env`
(if the directory exists) or the `kanban` bridge's `config.env` (fallback).

### Telegram notifications

Each Agent A and Agent B reply is mirrored to Telegram, plus a summary when the session ends.

**Priority for Telegram credentials:**

1. **`CTI_RESEARCH.telegram`** (dedicated Research bridge config) — **recommended**
2. `POST /api/research` body `notifyTelegram: { chatId? }` (override chat only)
3. Other bridge configs (`mybot` → `kanban` → others)
4. Bridge JsonFileStore
5. `CTI_TELEGRAM_BOT_TOKEN` + `CTI_TG_CHAT_ID` env fallbacks

**Message format (HTML):**

- `[researcher] turn N · session …` — Agent A reply
- `[reviewer] turn N · session …` — Agent B reply
- Final `Research mode — completed|failed|…` block with folder / result path

### Example: Complete research/config.env

```bash
CTI_RUNTIME=claude

CTI_RUNNERS=[
  {"id":"researcher","runtime":"claude","label":"Researcher","defaultModel":"claude-sonnet-4-20250514"},
  {"id":"reviewer","runtime":"codex","label":"Senior Reviewer","defaultModel":"o4-mini"}
]

CTI_RESEARCH={
  "researcherRunner":{"id":"researcher"},
  "reviewerRunner":{"id":"reviewer"},
  "defaultMaxTurns":30,
  "telegram":{
    "botToken":"YOUR_BOT_TOKEN",
    "chatId":"YOUR_CHAT_ID"
  },
  "expertCouncil":{
    "rejectThreshold":3,
    "maxExperts":5
  }
}
```

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
