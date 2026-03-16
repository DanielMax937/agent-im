import fs from 'node:fs';
import path from 'node:path';
import pino, { multistream, type Logger } from 'pino';

import { CTI_HOME } from './config';

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

const LOG_DIR = path.join(CTI_HOME, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');

let loggerInstance: Logger | null = null;
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

function createLogger(): Logger {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fileDestination = pino.destination({
    dest: LOG_PATH,
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
          method.apply(this, args.map((arg) => maskValue(arg)));
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

export function setupLogger(): Logger {
  const logger = getLogger();
  if (consolePatched) return logger;

  console.log = (...args: unknown[]) => {
    logger.info(...(args as [unknown, ...unknown[]]));
  };
  console.warn = (...args: unknown[]) => {
    logger.warn(...(args as [unknown, ...unknown[]]));
  };
  console.error = (...args: unknown[]) => {
    logger.error(...(args as [unknown, ...unknown[]]));
  };
  consolePatched = true;
  return logger;
}
