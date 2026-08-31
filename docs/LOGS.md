# Viewing logs

Runtime logs are written with **Pino** (JSON lines). Secrets in messages are **masked** before write.

## Where the files are

All log files live under **`$CTI_HOME/logs/`**.

`CTI_HOME` is resolved as follows (same as the rest of the app):

1. If **`CTI_HOME`** is set → use that absolute directory.
2. Else if **`CTI_BOT_NAME`** is set → **`~/.claude-to-im/<CTI_BOT_NAME>/`** (or **`$CTI_BASE/<CTI_BOT_NAME>/`** when `CTI_BASE` is set).
3. Else → slug from **`~/.claude-to-im/.active_bridge`**, then **`~/.claude-to-im/<slug>/`**.

Filenames use the **local calendar date** when the process starts: **`bridge-YYYY-MM-DD.log`** (web / platform) and **`bridge-daemon-YYYY-MM-DD.log`** (daemon). Older undated files **`bridge.log`** / **`bridge-daemon.log`** are still recognized when tailing via the HTTP API (newest file wins).

| Pattern | Process |
|---------|---------|
| **`$CTI_HOME/logs/bridge-YYYY-MM-DD.log`** | Next.js dev/prod (`next dev` / `next start`), Kanban platform APIs, `setupLogger()` in the web process |
| **`$CTI_HOME/logs/bridge-daemon-YYYY-MM-DD.log`** | IM bridge daemon (`src/main.ts` / built daemon) |

Example (default layout):

```text
~/.claude-to-im/<bot-name>/logs/bridge-2026-04-02.log
~/.claude-to-im/<bot-name>/logs/bridge-daemon-2026-04-02.log
```

## Log level

Set **`CTI_LOG_LEVEL`** (e.g. in `.env` or `config.env`) to `trace`, `debug`, `info`, `warn`, or `error`. Default is **`info`**.

## View from the shell

Replace `$CTI_HOME` with your actual data directory (or `export CTI_HOME=...` first).

```bash
# Newest platform log (dated or legacy)
APP_LOG=$(ls -t "$CTI_HOME"/logs/bridge*.log 2>/dev/null | grep -v 'bridge-daemon' | head -1)
tail -n 100 "$APP_LOG"

# Follow live
tail -f "$APP_LOG"

# Newest daemon log
DAEMON_LOG=$(ls -t "$CTI_HOME"/logs/bridge-daemon*.log 2>/dev/null | head -1)
tail -n 100 "$DAEMON_LOG"
```

Logs are **one JSON object per line**. To filter by subsystem (Pino `scope`):

```bash
grep '"scope":"kanban"' "$APP_LOG"
grep '"scope":"llm-provider"' "$APP_LOG"
grep '"scope":"platform-app"' "$APP_LOG"
```

If **`jq`** is installed:

```bash
tail -n 200 "$APP_LOG" | jq -c 'select(.scope == "kanban")'
```

## View via HTTP (local Next server)

When the Next app is running, you can fetch a **tail** of the log file as JSON:

- **Platform / web process log** (newest `bridge-*.log` for the app, excluding daemon):  
  `GET /api/bridge/logs?source=app&lines=400`
- **Daemon log** (newest `bridge-daemon-*.log` or legacy `bridge-daemon.log`):  
  `GET /api/bridge/logs?source=daemon&lines=400`

`lines` is capped (see `BRIDGE_LOG_LINES_MAX` in code). The response includes `logPath`, `text`, and `missing`.

Example:

```bash
curl -s "http://localhost:3000/api/bridge/logs?source=app&lines=200" | jq .
```

## Troubleshooting

- **Empty or missing file**: confirm **`CTI_HOME`** / **`CTI_BOT_NAME`** matches the process you started; the web app and a manually launched daemon may use different homes if env differs.
- **Kanban vs bridge**: Kanban UI and workflow logs from the Next server go to the **platform** log file with **`scope: "kanban"`** (and related scopes), not necessarily to the daemon log.
