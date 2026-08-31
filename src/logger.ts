import fs from 'node:fs';
import path from 'node:path';
import pino, { multistream, type Logger } from 'pino';

import { getCtiHome, getKanbanPlatformCtiHome } from './config';
import { bridgeAppLogBasenameForDate } from './lib/bridge/bridge-log-file';

const MASK_PATTERNS: RegExp[] = [
  /(?:token|secret|password|api_key)["']?\s*[:=]\s*["']?([^\s"',]+)/gi,
  /bot\d+:[A-Za-z0-9_-]{35}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

export function maskSecrets(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      if (match.length <= 4) return match;
      return '*'.repeat(match.length - 4) + match.slice(-4);
    });
  }
  return result;
}

let loggerInstance: Logger | null = null;
/** First `setupLogger` wins for this process (Next → bridge-YYYY-MM-DD.log; daemon → bridge-daemon-YYYY-MM-DD.log). */
let logFileBasename: string | null = null;

export function resetLoggerInstance(): void {
  loggerInstance = null;
  logFileBasename = null;
}
let consolePatched = false;

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskSecrets(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskSecrets(value.message),
      stack: value.stack ? maskSecrets(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => maskValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, maskValue(entry)]),
  );
}

function logDirectory(): string {
  // Next.js sets NEXT_RUNTIME on the dev server. Bridge daemon / slave processes spawned by Next
  // inherit it but set CTI_HOME to a per-bridge directory — they must log under that home, not
  // ~/.claude-to-im/kanban/logs. The Kanban web app itself has no CTI_HOME (only CTI_BOT_NAME=kanban
  // from kanban/config.env), so it still uses getKanbanPlatformCtiHome() below.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const explicit = process.env.CTI_HOME?.trim();
    if (explicit) {
      return path.join(path.resolve(explicit), 'logs');
    }
    return path.join(getKanbanPlatformCtiHome(), 'logs');
  }
  return path.join(getCtiHome(), 'logs');
}

function createLogger(): Logger {
  const logDir = logDirectory();
  const basename = logFileBasename ?? bridgeAppLogBasenameForDate();
  const logPath = path.join(logDir, basename);
  fs.mkdirSync(logDir, { recursive: true });
  const fileDestination = pino.destination({
    dest: logPath,
    mkdir: true,
    sync: false,
  });

  return pino(
    {
      level: process.env.CTI_LOG_LEVEL || 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log(object) {
          return maskValue(object) as Record<string, unknown>;
        },
      },
      hooks: {
        logMethod(args, method) {
          const maskedArgs = args.map((arg) => maskValue(arg));
          if (maskedArgs.length === 0) {
            method.apply(this, [{}] as Parameters<typeof method>);
            return;
          }
          method.apply(this, maskedArgs as Parameters<typeof method>);
        },
      },
    },
    multistream([
      { stream: process.stdout },
      { stream: fileDestination },
    ]),
  );
}

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

export interface SetupLoggerOptions {
  /** Default `bridge-YYYY-MM-DD.log` (Next). Use `bridgeDaemonLogBasenameForDate()` for `src/main.ts` only. */
  logFileName?: string;
}

export function setupLogger(opts?: SetupLoggerOptions): Logger {
  if (!loggerInstance && opts?.logFileName?.trim()) {
    logFileBasename = opts.logFileName.trim();
  }
  const logger = getLogger();
  if (consolePatched) return logger;

  const logWithLevel = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
    if (args.length === 0) {
      logger[level]({});
      return;
    }

    const [first, ...rest] = args;
    if (typeof first === 'string') {
      if (rest.length === 0) {
        logger[level](first);
        return;
      }
      logger[level]({ args: rest }, first);
      return;
    }

    if (rest.length > 0 && typeof rest[0] === 'string') {
      const [message, ...messageArgs] = rest;
      logger[level](first, message, ...messageArgs);
      return;
    }

    logger[level]({ payload: first, args: rest });
  };

  console.log = (...args: unknown[]) => {
    logWithLevel('info', args);
  };
  console.warn = (...args: unknown[]) => {
    logWithLevel('warn', args);
  };
  console.error = (...args: unknown[]) => {
    logWithLevel('error', args);
  };
  consolePatched = true;
  return logger;
}
