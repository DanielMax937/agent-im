/**
 * Runs the bridge daemon (`src/main.ts` / `dist/daemon.mjs`) as a **child process** of the
 * Next.js server. When the server exits, the child is terminated so bridge processes are not
 * left orphaned.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readBridgeDaemonDiskStatus } from './bridge-daemon-status';
import type { AdapterStatus, BridgeStatus } from './bridge/types';

let managedChild: ChildProcess | null = null;
let shutdownHooksRegistered = false;

function getProjectRoot(): string {
  return process.env.CTI_PROJECT_ROOT?.trim() || process.cwd();
}

/**
 * Prefer bundled daemon; in dev fall back to `tsx` running `src/main.ts`.
 */
export function resolveDaemonEntry(): { command: string; args: string[] } {
  const root = getProjectRoot();
  const bundled = path.join(root, 'dist', 'daemon.mjs');
  if (fs.existsSync(bundled)) {
    return { command: process.execPath, args: [bundled] };
  }
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const mainTs = path.join(root, 'src', 'main.ts');
  if (fs.existsSync(tsxCli) && fs.existsSync(mainTs)) {
    return { command: process.execPath, args: [tsxCli, mainTs] };
  }
  throw new Error(
    '未找到桥接入口：请先执行 npm run build:daemon 生成 dist/daemon.mjs，或在开发环境安装 tsx。',
  );
}

function isManagedChildAlive(): boolean {
  const c = managedChild;
  return c != null && !c.killed && c.exitCode === null;
}

/** True when status.json PID matches the child we spawned in this process. */
export function isBridgeManagedByApp(): boolean {
  const disk = readBridgeDaemonDiskStatus();
  if (!disk.effectiveRunning || disk.pid == null) return false;
  if (!isManagedChildAlive() || managedChild!.pid == null) return false;
  return managedChild!.pid === disk.pid;
}

function diskStatusToBridgeStatus(disk: ReturnType<typeof readBridgeDaemonDiskStatus>): BridgeStatus {
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
    managedByApp: isBridgeManagedByApp(),
  };
}

/** Status for GET /api/bridge/status — derived from on-disk daemon + our managed child PID. */
export function getBridgeStatusForApi(): BridgeStatus {
  return diskStatusToBridgeStatus(readBridgeDaemonDiskStatus());
}

export function registerBridgeShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  const onSignal = () => {
    void stopBridgeDaemonChild().catch(() => {});
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.on('exit', () => {
    const c = managedChild;
    if (c && !c.killed) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });
}

function attachChildHandlers(child: ChildProcess): void {
  child.on('exit', (code, signal) => {
    if (managedChild === child) managedChild = null;
    console.log(`[bridge-app-child] daemon exited code=${code} signal=${signal ?? ''}`);
  });
  child.on('error', (err) => {
    console.error('[bridge-app-child] spawn error:', err);
    if (managedChild === child) managedChild = null;
  });
}

/**
 * Start the bridge as a child process. Refuses if another process already holds the bridge
 * (status.json + live PID) unless it is our own child.
 */
export async function startBridgeDaemonChild(): Promise<void> {
  registerBridgeShutdownHooks();

  const disk0 = readBridgeDaemonDiskStatus();
  if (disk0.effectiveRunning) {
    if (isBridgeManagedByApp()) return;
    throw new Error(
      `桥接已在运行（PID ${disk0.pid ?? '?'}）。若为外部 daemon.sh 启动，请先停止或更换 CTI_HOME。`,
    );
  }

  if (managedChild && isManagedChildAlive()) {
    return;
  }

  if (managedChild) {
    managedChild = null;
  }

  const { command, args } = resolveDaemonEntry();
  const child = spawn(command, args, {
    cwd: getProjectRoot(),
    env: { ...process.env },
    stdio: 'inherit',
    detached: false,
  });
  managedChild = child;
  attachChildHandlers(child);

  const expectedPid = child.pid;
  if (expectedPid == null) {
    managedChild = null;
    throw new Error('桥接子进程未能取得 PID');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isManagedChildAlive()) {
      throw new Error('桥接进程启动后立即退出，请查看终端日志。');
    }
    const disk = readBridgeDaemonDiskStatus();
    if (disk.effectiveRunning && disk.pid === expectedPid) return;
  }
  throw new Error('桥接进程启动超时（未在 status.json 中看到预期 PID）。');
}

export type StopBridgeResult = { ok: true } | { ok: false; reason: 'not_managed' };

/**
 * Stop only the daemon we spawned. If another process owns the bridge, returns `not_managed`.
 */
export async function stopBridgeDaemonChild(): Promise<StopBridgeResult> {
  const child = managedChild;
  if (!child) {
    const disk = readBridgeDaemonDiskStatus();
    if (disk.effectiveRunning) {
      return { ok: false, reason: 'not_managed' };
    }
    return { ok: true };
  }

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
  if (managedChild === child) managedChild = null;
  return { ok: true };
}
