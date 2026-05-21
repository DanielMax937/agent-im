/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

import { initBridgeContext } from './lib/bridge/context';
import * as bridgeManager from './lib/bridge/bridge-manager';
// Side-effect import to trigger adapter self-registration
import './lib/bridge/adapters/index';

import {
  loadConfig,
  configToSettings,
  getCtiHome,
  syncConfigFileToProcessEnv,
  normalizeRunners,
  normalizeRunnersForChannelType,
  defaultRunnerIdForChannelType,
} from './config';
import { buildImBridgeLlmStack } from './lib/bridge/llm-registry';
import { bridgeDaemonLogBasenameForDate } from './lib/bridge/bridge-log-file';
import { notifyBridgeClosing, notifyBridgeStarted } from './lib/bridge/shutdown-notify';
import { JsonFileStore } from './store';
import { PendingPermissions } from './permission-gateway';
import { setupLogger } from './logger';

function runtimeDir(): string {
  return path.join(getCtiHome(), 'runtime');
}
function statusFile(): string {
  return path.join(runtimeDir(), 'status.json');
}
function pidFile(): string {
  return path.join(runtimeDir(), 'bridge.pid');
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const sf = statusFile();
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(sf, 'utf-8')); } catch { /* first write */ }

  if (process.env.CTI_SLAVE_BRIDGE === '1') {
    // Slave writes to `slave.*` fields so it doesn't clobber master status
    const slave: Record<string, unknown> = {};
    if (info.running !== undefined) slave.running = info.running;
    if (info.pid !== undefined) slave.pid = info.pid;
    if (info.runId !== undefined) slave.runId = info.runId;
    if (info.startedAt !== undefined) slave.startedAt = info.startedAt;
    if (info.channels !== undefined) slave.channels = info.channels;
    if (info.lastExitReason !== undefined) slave.lastExitReason = info.lastExitReason;
    const merged = { ...existing, slave: { ...(existing.slave as Record<string, unknown> ?? {}), ...slave } };
    const tmp = sf + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, sf);
  } else {
    const merged = { ...existing, ...info };
    const tmp = sf + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, sf);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  syncConfigFileToProcessEnv();
  setupLogger({ logFileName: bridgeDaemonLogBasenameForDate() });

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  // Set up HTTP proxy for all outbound fetch() calls (Telegram, Feishu, etc.)
  if (config.proxy) {
    try {
      setGlobalDispatcher(new ProxyAgent(config.proxy));
      console.log(`[claude-to-im] Proxy: ON (${config.proxy})`);
    } catch (err) {
      console.error(`[claude-to-im] Failed to configure proxy (${config.proxy}):`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else {
    console.log('[claude-to-im] Proxy: OFF (CTI_PROXY not set, direct connection)');
  }

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const { defaultLlm, resolveLlmForBinding, resolveLlmForRunner } = await buildImBridgeLlmStack(config, pendingPerms);
  const bridgeRunners = normalizeRunners(config);
  const bridgeDefaultRunnerId = config.defaultRunnerId ?? bridgeRunners[0]?.id;
  const nBots = config.imBot ? 1 : 0;
  console.log(
    `[claude-to-im] IM bridge: ${nBots ? `1 bot (CTI_IM_BOT), per-bot runners` : `${bridgeRunners.length} global runner(s)`}; per-chat binding resolution`,
  );

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm: defaultLlm,
    resolveLlmForBinding,
    resolveLlmForRunner,
    getRunnerConfigsForChannelType: (channelType) =>
      normalizeRunnersForChannelType(loadConfig(), channelType),
    getDefaultRunnerIdForChannelType: (channelType) =>
      defaultRunnerIdForChannelType(loadConfig(), channelType),
    imRunners: bridgeRunners.map((p) => ({
      id: p.id,
      runtime: p.runtime,
      label: p.label,
    })),
    imRunnerConfigs: bridgeRunners,
    defaultRunnerId: bridgeDefaultRunnerId,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: async () => {
        fs.mkdirSync(runtimeDir(), { recursive: true });
        // Only master writes the PID file (used by isBridgeManagedByApp)
        if (process.env.CTI_SLAVE_BRIDGE !== '1') {
          fs.writeFileSync(pidFile(), String(process.pid), 'utf-8');
        }
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
        await notifyBridgeStarted(process.pid, config.enabledChannels);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await notifyBridgeClosing(reason);
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
