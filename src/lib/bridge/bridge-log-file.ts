import fs from 'node:fs/promises';
import path from 'node:path';

import { getCtiHome } from '../../config';

/** Next.js / 平台进程 `setupLogger()` 默认写入。 */
export const BRIDGE_LOG_APP_BASENAME = 'bridge.log';

/** 仅桥接子进程（`src/main.ts` / dist daemon）写入，与平台日志分离。 */
export const BRIDGE_LOG_DAEMON_BASENAME = 'bridge-daemon.log';

export const BRIDGE_LOG_TAIL_BYTES = 512 * 1024;
export const BRIDGE_LOG_LINES_DEFAULT = 400;
export const BRIDGE_LOG_LINES_MAX = 5000;

/**
 * Tail a log file under `logs/` (default: 桥接子进程 `bridge-daemon.log`).
 * For large files, only the last ~512KB is read into memory.
 */
export async function readBridgeLogTail(
  maxLines: number,
  fileBasename: string = BRIDGE_LOG_DAEMON_BASENAME,
): Promise<{
  text: string;
  logPath: string;
  missing: boolean;
}> {
  const logPath = path.join(getCtiHome(), 'logs', fileBasename);
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
