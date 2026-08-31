import fs from 'node:fs/promises';
import path from 'node:path';

import { getCtiHome } from '../../config';

/** Legacy fixed names (pre–date-suffix); still recognized when resolving latest log. */
export const BRIDGE_LOG_APP_BASENAME = 'bridge.log';

/** Legacy fixed name for daemon log; still recognized when resolving latest log. */
export const BRIDGE_LOG_DAEMON_BASENAME = 'bridge-daemon.log';

const DATED_APP_PATTERN = /^bridge-\d{4}-\d{2}-\d{2}\.log$/;
const DATED_DAEMON_PATTERN = /^bridge-daemon-\d{4}-\d{2}-\d{2}\.log$/;

/** Local calendar date `YYYY-MM-DD` (for log filenames). */
export function formatLocalDateForLog(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** e.g. `bridge-2026-04-02.log` */
export function bridgeAppLogBasenameForDate(d: Date = new Date()): string {
  return `bridge-${formatLocalDateForLog(d)}.log`;
}

/** e.g. `bridge-daemon-2026-04-02.log` */
export function bridgeDaemonLogBasenameForDate(d: Date = new Date()): string {
  return `bridge-daemon-${formatLocalDateForLog(d)}.log`;
}

export const BRIDGE_LOG_TAIL_BYTES = 512 * 1024;
export const BRIDGE_LOG_LINES_DEFAULT = 400;
export const BRIDGE_LOG_LINES_MAX = 5000;

/**
 * Pick the newest log file for the app or daemon (by mtime).
 * Prefers dated `bridge-YYYY-MM-DD.log` / `bridge-daemon-YYYY-MM-DD.log`, then legacy undated names.
 */
export async function resolveLatestBridgeLogBasename(
  kind: 'app' | 'daemon',
): Promise<string> {
  const logDir = path.join(getCtiHome(), 'logs');
  const pattern = kind === 'app' ? DATED_APP_PATTERN : DATED_DAEMON_PATTERN;
  const legacy = kind === 'app' ? BRIDGE_LOG_APP_BASENAME : BRIDGE_LOG_DAEMON_BASENAME;

  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return kind === 'app' ? bridgeAppLogBasenameForDate() : bridgeDaemonLogBasenameForDate();
    }
    throw error;
  }

  const dated = entries.filter((name) => pattern.test(name));
  if (dated.length > 0) {
    const withMtime = await Promise.all(
      dated.map(async (name) => {
        const st = await fs.stat(path.join(logDir, name));
        return { name, mtimeMs: st.mtimeMs };
      }),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withMtime[0]!.name;
  }

  if (entries.includes(legacy)) {
    return legacy;
  }

  return kind === 'app' ? bridgeAppLogBasenameForDate() : bridgeDaemonLogBasenameForDate();
}

/**
 * Tail a log file under `logs/`. If `fileBasename` is omitted, uses the newest daemon log (dated or legacy).
 * For large files, only the last ~512KB is read into memory.
 */
export async function readBridgeLogTail(
  maxLines: number,
  fileBasename?: string,
): Promise<{
  text: string;
  logPath: string;
  missing: boolean;
}> {
  const basename = fileBasename ?? (await resolveLatestBridgeLogBasename('daemon'));
  const logPath = path.join(getCtiHome(), 'logs', basename);
  try {
    const st = await fs.stat(logPath);
    const readSize = Math.min(st.size, BRIDGE_LOG_TAIL_BYTES);
    const start = st.size - readSize;
    const buf = Buffer.alloc(readSize);
    const fh = await fs.open(logPath, 'r');
    try {
      await fh.read(buf, 0, readSize, start);
    } finally {
      await fh.close();
    }
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-maxLines).join('\n');
    return { text: tail, logPath, missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: '', logPath, missing: true };
    }
    throw error;
  }
}
