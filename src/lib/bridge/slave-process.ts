/**
 * Manages slave bridge child processes.  When the master bridge starts in
 * auto mode it spawns a slave bridge; when the master stops it kills the
 * slave.  Each master adapter instance can have at most one slave child.
 *
 * Key → instanceId (e.g. "telegram:default"), Value → ChildProcess.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

import { getCtiHome, getSlaveEnvPath, loadSlaveEnv } from '../../config';
import { applyStandardProxyEnvFromCtiProxy } from '../proxy-env';
import { resolveDaemonEntry } from '../bridge-app-child';

// ── In-memory registry ────────────────────────────────────────────────

const slaveChildren = new Map<string, ChildProcess>();
let shutdownHooked = false;

/** All currently tracked slave instance IDs (for diagnostics / tests). */
export function listSlaveInstanceIds(): string[] {
  return [...slaveChildren.keys()];
}

function getProjectRoot(): string {
  return process.env.CTI_PROJECT_ROOT?.trim() || process.cwd();
}

// ── Lifecycle helpers ─────────────────────────────────────────────────

function registerSlaveShutdownHooks(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;

  const onSignal = () => {
    void stopAllSlaves().catch(() => {});
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.on('exit', () => {
    for (const [, child] of slaveChildren) {
      if (child && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  });
}

function isAlive(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && !child.killed && child.exitCode === null;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Spawn a slave bridge child process for the given adapter instance.
 * The slave inherits the current process env with overrides from
 * `config.slave.env`.  The Telegram bot token is stripped so the slave
 * enters Redis-only auto mode.
 *
 * Optional `envOverrides` are merged after slave env (e.g. `CTI_DEFAULT_WORKDIR`
 * after `/cwd` in hybrid Auto mode).
 */
export function startSlaveProcess(instanceId: string, envOverrides?: Record<string, string>): void {
  registerSlaveShutdownHooks();

  // Already running?
  const existing = slaveChildren.get(instanceId);
  if (existing && isAlive(existing)) {
    console.log(`[slave-process] Slave already running for ${instanceId} (PID ${existing.pid})`);
    return;
  }

  // Slave env must exist
  const slaveEnvPath = getSlaveEnvPath();
  if (!fs.existsSync(slaveEnvPath)) {
    console.warn(
      `[slave-process] config.slave.env not found at ${slaveEnvPath} — cannot start slave for ${instanceId}`,
    );
    return;
  }

  const slaveEnv = loadSlaveEnv();
  if (!slaveEnv.CTI_RUNTIME && !slaveEnv.CTI_RUNNERS) {
    console.warn(`[slave-process] config.slave.env is empty — cannot start slave for ${instanceId}`);
    return;
  }

  // Build child env: inherit current process env, merge slave env, strip bot token
  const childEnv: Record<string, string | undefined> = { ...process.env };
  Object.assign(childEnv, slaveEnv);
  if (envOverrides) {
    Object.assign(childEnv, envOverrides);
  }
  childEnv.CTI_HOME = getCtiHome();
  // Strip Telegram bot token so slave enters Redis-only auto mode
  delete childEnv.CTI_TELEGRAM_BOT_TOKEN;
  delete childEnv.TELEGRAM_BOT_TOKEN;
  // Tag as slave so main.ts / adapter can detect it if needed
  childEnv.CTI_SLAVE_BRIDGE = '1';
  applyStandardProxyEnvFromCtiProxy(childEnv);

  const { command, args } = resolveDaemonEntry();
  const child = spawn(command, args, {
    cwd: getProjectRoot(),
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  slaveChildren.set(instanceId, child);

  // Prefix slave stdout/stderr for easy identification
  const tag = `[slave:${instanceId}]`;
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      console.log(`${tag} ${line}`);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      console.error(`${tag} ${line}`);
    }
  });

  child.on('exit', (code, signal) => {
    if (slaveChildren.get(instanceId) === child) {
      slaveChildren.delete(instanceId);
    }
    console.log(`${tag} exited code=${code} signal=${signal ?? ''}`);
  });
  child.on('error', (err) => {
    console.error(`${tag} spawn error:`, err);
    if (slaveChildren.get(instanceId) === child) {
      slaveChildren.delete(instanceId);
    }
  });

  const wdLog = childEnv.CTI_DEFAULT_WORKDIR ? ` CTI_DEFAULT_WORKDIR=${childEnv.CTI_DEFAULT_WORKDIR}` : '';
  console.log(`[slave-process] Started slave for ${instanceId} (PID ${child.pid})${wdLog}`);
}

/**
 * Stop the slave bridge child for the given adapter instance.
 * Sends SIGTERM, waits up to 12 s, then SIGKILL.
 */
export async function stopSlaveProcess(instanceId: string): Promise<void> {
  const child = slaveChildren.get(instanceId);
  if (!child || !isAlive(child)) {
    slaveChildren.delete(instanceId);
    return;
  }

  console.log(`[slave-process] Stopping slave for ${instanceId} (PID ${child.pid})`);
  child.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 12_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });

  if (slaveChildren.get(instanceId) === child) {
    slaveChildren.delete(instanceId);
  }
}

/** Stop all tracked slave processes (called on master shutdown). */
export async function stopAllSlaves(): Promise<void> {
  const entries = [...slaveChildren.entries()];
  await Promise.all(entries.map(([id]) => stopSlaveProcess(id)));
}
