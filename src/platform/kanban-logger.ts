import type { Logger } from 'pino';

import { getLogger } from '../logger';

/**
 * Structured logs for the Kanban platform (workflow, Telegram notify, agents, etc.).
 * Output: stdout + `~/.claude-to-im/kanban/logs/bridge-YYYY-MM-DD.log` for the Kanban Next server.
 * Bridge daemon/slave processes log under `$CTI_HOME/logs/` even when spawned by Next (see `logger.ts`).
 * Set `CTI_LOG_LEVEL=debug` for verbose traces.
 */
let kanbanLogger: Logger | null = null;

export function getKanbanLogger(): Logger {
  if (!kanbanLogger) {
    kanbanLogger = getLogger().child({ scope: 'kanban' });
  }
  return kanbanLogger;
}
