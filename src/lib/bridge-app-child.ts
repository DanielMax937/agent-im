/**
 * Runs bridge daemons (`src/main.ts` / `dist/daemon.mjs`) as **child processes** of the
 * Next.js server. Multiple bridges (distinct `CTI_HOME` directories) may run at once; each
 * home has at most one managed child. When the server exits, all children are terminated.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getCtiHome } from '../config';
import { readBridgeDaemonDiskStatus } from './bridge-daemon-status';
import type { AdapterStatus, BridgeStatus } from './bridge/types';

/** Resolved absolute path → child process we spawned for that bridge home. */
const managedChildren = new Map<string, ChildProcess>();
let shutdownHooksRegistered = false;

function getProjectRoot(): string {
  return process.env.CTI_PROJECT_ROOT?.trim() || process.cwd();
}

function newestSourceMtimeMs(root: string): number {
  const pending = [path.join(root, 'src')];
  let newest = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* ignore */
      }
    }
  }
  return newest;
}

function isBundledDaemonFresh(root: string, bundledPath: string): boolean {
  try {
    const bundledStat = fs.statSync(bundledPath);
    return bundledStat.mtimeMs >= newestSourceMtimeMs(root);
  } catch {
    return false;
  }
}

/** Resolved CTI_HOME for this operation (explicit override or active server home). */
export function resolveBridgeHomeKey(ctiHomeOverride?: string): string {
  return ctiHomeOverride !== undefined ? path.resolve(ctiHomeOverride) : path.resolve(getCtiHome());
}

function isProcessAlive(c: ChildProcess | undefined | null): boolean {
  return c != null && !c.killed && c.exitCode === null;
}

function getManagedChildForHome(home: string): ChildProcess | undefined {
  return managedChildren.get(home);
}

/**
 * Prefer bundled daemon; in dev fall back to `tsx` running `src/main.ts`.
 */
export function resolveDaemonEntry(): { command: string; args: string[] } {
  const root = getProjectRoot();
  const bundled = path.join(root, 'dist', 'daemon.mjs');
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const mainTs = path.join(root, 'src', 'main.ts');
  const hasTsxFallback = fs.existsSync(tsxCli) && fs.existsSync(mainTs);
  if (fs.existsSync(bundled) && isBundledDaemonFresh(root, bundled)) {
    return { command: process.execPath, args: [bundled] };
  }
  if (hasTsxFallback) {
    return { command: process.execPath, args: [tsxCli, mainTs] };
  }
  throw new Error(
    fs.existsSync(bundled)
      ? '桥接 daemon 构建产物已过期：请先执行 npm run build:daemon，或在开发环境安装 tsx 以直接运行 src/main.ts。'
      : '未找到桥接入口：请先执行 npm run build:daemon 生成 dist/daemon.mjs，或在开发环境安装 tsx。',
  );
}

/** True when status.json PID matches the managed child for this `home`. */
export function isBridgeManagedByApp(ctiHomeOverride?: string): boolean {
  const home = resolveBridgeHomeKey(ctiHomeOverride);
  const disk = readBridgeDaemonDiskStatus(home);
  if (!disk.effectiveRunning || disk.pid == null) return false;
  const child = getManagedChildForHome(home);
  if (!isProcessAlive(child) || child!.pid == null) return false;
  return child!.pid === disk.pid;
}

function diskStatusToBridgeStatus(
  disk: ReturnType<typeof readBridgeDaemonDiskStatus>,
  home: string,
): BridgeStatus {
  if (!disk.effectiveRunning) {
    return { running: false, startedAt: null, adapters: [], managedByApp: false };
  }
  const channels = disk.channels ?? [];
  const adapters: AdapterStatus[] = channels.map((ch) => ({
    channelType: ch,
    running: true,
    connectedAt: disk.startedAt ?? null,
    lastMessageAt: null,
    error: null,
  }));
  return {
    running: true,
    startedAt: disk.startedAt ?? null,
    adapters,
    managedByApp: isBridgeManagedByApp(home),
  };
}

/** Status for GET /api/bridge/status — on-disk daemon + managed child PID for one home. */
export function getBridgeStatusForApi(ctiHomeOverride?: string): BridgeStatus {
  const home = resolveBridgeHomeKey(ctiHomeOverride);
  return diskStatusToBridgeStatus(readBridgeDaemonDiskStatus(home), home);
}

async function killManagedChild(home: string, child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 12_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (managedChildren.get(home) === child) {
    managedChildren.delete(home);
  }
}

async function stopAllManagedBridgeChildren(): Promise<void> {
  const entries = [...managedChildren.entries()];
  await Promise.all(entries.map(([home, child]) => killManagedChild(home, child)));
}

export function registerBridgeShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const onSignal = () => {
    void stopAllManagedBridgeChildren().catch(() => {});
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.on('exit', () => {
    for (const [, child] of managedChildren) {
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  });
}

function attachChildHandlers(child: ChildProcess, home: string): void {
  child.on('exit', (code, signal) => {
    if (managedChildren.get(home) === child) {
      managedChildren.delete(home);
    }
    console.log(`[bridge-app-child] daemon exited home=${home} code=${code} signal=${signal ?? ''}`);
  });
  child.on('error', (err) => {
    console.error('[bridge-app-child] spawn error:', err);
    if (managedChildren.get(home) === child) {
      managedChildren.delete(home);
    }
  });
}

/**
 * Start the bridge daemon for a given `CTI_HOME` (default: active server home).
 */
export async function startBridgeDaemonChild(ctiHomeOverride?: string): Promise<void> {
  registerBridgeShutdownHooks();

  const home = resolveBridgeHomeKey(ctiHomeOverride);

  const disk0 = readBridgeDaemonDiskStatus(home);
  if (disk0.effectiveRunning) {
    if (isBridgeManagedByApp(home)) return;
    throw new Error(
      `桥接已在运行（PID ${disk0.pid ?? '?'}）。若为外部 daemon.sh 启动，请先停止或更换 CTI_HOME。`,
    );
  }

  const existing = managedChildren.get(home);
  if (existing && isProcessAlive(existing)) {
    if (isBridgeManagedByApp(home)) return;
    await killManagedChild(home, existing);
  }

  const { command, args } = resolveDaemonEntry();
  const child = spawn(command, args, {
    cwd: getProjectRoot(),
    env: {
      ...process.env,
      CTI_HOME: home,
      // Override parent CTI_BOT_NAME (e.g. Next/kanban) so child matches this bridge directory.
      CTI_BOT_NAME: path.basename(home),
    },
    stdio: 'inherit',
    detached: false,
  });
  managedChildren.set(home, child);
  attachChildHandlers(child, home);

  const expectedPid = child.pid;
  if (expectedPid == null) {
    managedChildren.delete(home);
    throw new Error('桥接子进程未能取得 PID');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessAlive(managedChildren.get(home))) {
      managedChildren.delete(home);
      throw new Error('桥接进程启动后立即退出，请查看终端日志。');
    }
    const disk = readBridgeDaemonDiskStatus(home);
    if (disk.effectiveRunning && disk.pid === expectedPid) return;
  }
  throw new Error('桥接进程启动超时（未在 status.json 中看到预期 PID）。');
}

export type StopBridgeResult = { ok: true } | { ok: false; reason: 'not_managed' };

/**
 * Stop the managed daemon for a given `CTI_HOME` (default: active server home).
 */
export async function stopBridgeDaemonChild(ctiHomeOverride?: string): Promise<StopBridgeResult> {
  const home = resolveBridgeHomeKey(ctiHomeOverride);
  const child = managedChildren.get(home);
  if (!child) {
    const disk = readBridgeDaemonDiskStatus(home);
    if (disk.effectiveRunning) {
      return { ok: false, reason: 'not_managed' };
    }
    return { ok: true };
  }

  await killManagedChild(home, child);
  return { ok: true };
}
