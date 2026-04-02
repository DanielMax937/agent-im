import type { Logger } from 'pino';

import { getLogger } from '../logger';

/**
 * Structured logs for the Kanban platform (workflow, Telegram notify, agents, etc.).
 * Output: stdout + `$CTI_HOME/logs/bridge-YYYY-MM-DD.log` (same file as the rest of the app unless overridden).
 * Set `CTI_LOG_LEVEL=debug` for verbose traces.
 */
let kanbanLogger: Logger | null = null;

export function getKanbanLogger(): Logger {
  if (!kanbanLogger) {
    kanbanLogger = getLogger().child({ scope: 'kanban' });
  }
  return kanbanLogger;
}
