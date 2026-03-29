import fs from "node:fs";
import path from "node:path";

import { getCtiHome } from "../config";

/** Status written by `src/main.ts` to `$CTI_HOME/runtime/status.json`. */
export interface BridgeDaemonDiskStatus {
  /** Whether `status.json` exists. */
  statusFilePresent: boolean;
  /** Raw `running` flag from file (may be stale vs OS process). */
  fileSaysRunning: boolean;
  /** Effective: bridge process appears to be running. */
  effectiveRunning: boolean;
  /** `running` was true but PID is missing or dead. */
  stale: boolean;
  pid?: number;
  startedAt?: string;
  runId?: string;
  channels?: string[];
  lastExitReason?: string;
  /** Slave bridge status (written to `slave.*` fields in the same file). */
  slave?: {
    running: boolean;
    effectiveRunning: boolean;
    pid?: number;
    startedAt?: string;
    lastExitReason?: string;
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read standalone daemon status from disk for a bridge home.
 * @param ctiHomeOverride Resolved absolute path to `$CTI_HOME`, or omit to use {@link getCtiHome}.
 */
export function readBridgeDaemonDiskStatus(ctiHomeOverride?: string): BridgeDaemonDiskStatus {
  const base = ctiHomeOverride !== undefined ? path.resolve(ctiHomeOverride) : getCtiHome();
  const statusPath = path.join(base, "runtime", "status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      statusFilePresent: false,
      fileSaysRunning: false,
      effectiveRunning: false,
      stale: false,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    const fileSaysRunning = raw.running === true;
    const pid = typeof raw.pid === "number" && raw.pid > 0 ? raw.pid : undefined;
    const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : undefined;
    const runId = typeof raw.runId === "string" ? raw.runId : undefined;
    const lastExitReason =
      typeof raw.lastExitReason === "string" ? raw.lastExitReason : undefined;
    const channels = Array.isArray(raw.channels)
      ? raw.channels.map(String)
      : undefined;

    let stale = false;
    let effectiveRunning = false;
    if (fileSaysRunning) {
      if (pid != null) {
        if (isPidAlive(pid)) {
          effectiveRunning = true;
        } else {
          stale = true;
        }
      } else {
        effectiveRunning = true;
      }
    }

    // Parse slave status from nested `slave` object
    let slave: BridgeDaemonDiskStatus['slave'];
    if (raw.slave && typeof raw.slave === 'object') {
      const s = raw.slave as Record<string, unknown>;
      const sRunning = s.running === true;
      const sPid = typeof s.pid === 'number' && s.pid > 0 ? s.pid : undefined;
      let sEffective = false;
      if (sRunning && sPid != null && isPidAlive(sPid)) sEffective = true;
      else if (sRunning && sPid == null) sEffective = true;
      slave = {
        running: sRunning,
        effectiveRunning: sEffective,
        pid: sPid,
        startedAt: typeof s.startedAt === 'string' ? s.startedAt : undefined,
        lastExitReason: typeof s.lastExitReason === 'string' ? s.lastExitReason : undefined,
      };
    }

    return {
      statusFilePresent: true,
      fileSaysRunning,
      effectiveRunning,
      stale,
      pid,
      startedAt,
      runId,
      channels,
      lastExitReason,
      slave,
    };
  } catch {
    return {
      statusFilePresent: true,
      fileSaysRunning: false,
      effectiveRunning: false,
      stale: false,
    };
  }
}
