/**
 * File-backed monitor message store.
 *
 * The bridge daemon writes messages here after every master/slave Redis push.
 * The Next.js monitor page reads from the same file.
 *
 * File location: `$CTI_HOME/runtime/monitor-messages.json`
 * Format: `{ master: MonitorEntry[], slave: MonitorEntry[] }`
 * Capped at MAX_ENTRIES per role (ring buffer).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCtiHome } from '../config';

const MAX_ENTRIES = 200;

export interface MonitorEntry {
  text: string;
  ts: number;       // Date.now()
  bridgeSlug?: string;
}

interface MonitorFile {
  master: MonitorEntry[];
  slave: MonitorEntry[];
}

function monitorFilePath(ctiHomeOverride?: string): string {
  const base = ctiHomeOverride ?? getCtiHome();
  return path.join(base, 'runtime', 'monitor-messages.json');
}

function readFile(ctiHomeOverride?: string): MonitorFile {
  try {
    const raw = fs.readFileSync(monitorFilePath(ctiHomeOverride), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      master: Array.isArray(parsed?.master) ? parsed.master : [],
      slave: Array.isArray(parsed?.slave) ? parsed.slave : [],
    };
  } catch {
    return { master: [], slave: [] };
  }
}

function writeFile(data: MonitorFile, ctiHomeOverride?: string): void {
  const fp = monitorFilePath(ctiHomeOverride);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

/** Append a master response to the monitor log. */
export function appendMasterMessage(text: string, bridgeSlug?: string, ctiHomeOverride?: string): void {
  try {
    const data = readFile(ctiHomeOverride);
    data.master.push({ text, ts: Date.now(), bridgeSlug });
    if (data.master.length > MAX_ENTRIES) {
      data.master = data.master.slice(-MAX_ENTRIES);
    }
    writeFile(data, ctiHomeOverride);
  } catch {
    // best-effort — don't break the main flow
  }
}

/** Append a slave response to the monitor log. */
export function appendSlaveMessage(text: string, bridgeSlug?: string, ctiHomeOverride?: string): void {
  try {
    const data = readFile(ctiHomeOverride);
    data.slave.push({ text, ts: Date.now(), bridgeSlug });
    if (data.slave.length > MAX_ENTRIES) {
      data.slave = data.slave.slice(-MAX_ENTRIES);
    }
    writeFile(data, ctiHomeOverride);
  } catch {
    // best-effort
  }
}

/** Read all monitor messages (for the API endpoint). */
export function readMonitorMessages(ctiHomeOverride?: string): MonitorFile {
  return readFile(ctiHomeOverride);
}

// ── Runner working status (separate file to avoid contention) ──

export interface RunnerStatus {
  masterBusy: boolean;
  slaveBusy: boolean;
  masterSince?: number;  // timestamp when master started working
  slaveSince?: number;   // timestamp when slave started working
  updatedAt: number;
}

function statusFilePath(ctiHomeOverride?: string): string {
  const base = ctiHomeOverride ?? getCtiHome();
  return path.join(base, 'runtime', 'runner-status.json');
}

/** Read runner working status. */
export function readRunnerStatus(ctiHomeOverride?: string): RunnerStatus {
  try {
    const raw = fs.readFileSync(statusFilePath(ctiHomeOverride), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { masterBusy: false, slaveBusy: false, updatedAt: 0 };
  }
}

/** Update runner working status (partial merge). */
export function writeRunnerStatus(
  update: Partial<Omit<RunnerStatus, 'updatedAt'>>,
  ctiHomeOverride?: string,
): void {
  try {
    const current = readRunnerStatus(ctiHomeOverride);
    const merged = { ...current, ...update, updatedAt: Date.now() };
    const fp = statusFilePath(ctiHomeOverride);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, fp);
  } catch {
    // best-effort
  }
}
