# Auto mode Redis refactor (design)

## Goals

1. Remove legacy “local agent” naming and parallel code paths; **Auto mode** is the single model.
2. **Redis keys** are namespaced by **bridge slug** (`CTI_BOT_NAME` / `getImBotInstanceId()`), **channel routing key** (`telegram` or `telegram:instanceId`), **runner id**, and for the **slave** role a fixed `:slave` segment before the queue suffix.
3. **Master** queues (when used) omit `:slave`; **slave** queues use `...:slave:input|out|turns|resp`.

## Key format

```
cti:auto:{bridgeSlug}:{channelType}:{runnerId}:{suffix}           # master
cti:auto:{bridgeSlug}:{channelType}:{runnerId}:slave:{suffix}      # slave
```

- `channelType`: adapter `channelType` (e.g. `telegram`, `discord:main`).
- `runnerId`: effective runner profile id for that role (master binding vs `autoSlaveRunnerId`).
- `suffix`: `input` | `out` | `turns` | `resp` (renamed from `la_resp`).

## Behaviour (unchanged semantics)

- **Hybrid IM**: master path LPUSH user text to **slave** `input` only; no master LLM on plain text.
- **Slave poll**: RPOP **slave** `input`, run LLM with slave runner, deliver + LPUSH `out`.
- **Prefixes**: `[master]` / `[slave]` on Telegram.

## Migration

- Store keys: prefer `bridge_*_auto_*` only; one-time read of legacy `bridge_*_local_agent_*` in `loadConfig`/settings merge can copy into new keys (optional follow-up).
- Redis: old `cti:localagent:*` keys are **not** read; operators must drain or abandon old queues.

## Testing

- Code now uses `cti:auto:…` keys and `deliverySource: 'slave'`; run `npm run typecheck` and `npm test`.
