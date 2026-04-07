import type { Logger } from 'pino';

import { getLogger } from '../logger';

/**
 * Structured logs for the Kanban platform (workflow, Telegram notify, agents, etc.).
 * Output: stdout + `~/.claude-to-im/kanban/logs/bridge-YYYY-MM-DD.log` (Next server; see `logger.ts`).
 * Set `CTI_LOG_LEVEL=debug` for verbose traces.
 */
let kanbanLogger: Logger | null = null;

export function getKanbanLogger(): Logger {
  if (!kanbanLogger) {
    kanbanLogger = getLogger().child({ scope: 'kanban' });
  }
  return kanbanLogger;
}
