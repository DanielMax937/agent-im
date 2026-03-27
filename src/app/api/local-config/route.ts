import path from 'node:path';

import {
  getCtiBaseDir,
  canSwitchBridgesViaRegistry,
  createNewBridge,
  getConfigPath,
  getCtiHome,
  getCtiHomeForBridgeSlug,
  getCtiBotDisplayName,
  listBridgeSlugs,
  loadConfig,
  saveConfig,
  mergeConfigPatch,
  configForAdminResponse,
  syncConfigFileToProcessEnv,
  switchActiveBridge,
  deleteBridge,
  type Config,
} from '../../../config';
import { readBridgeDaemonDiskStatus } from '../../../lib/bridge-daemon-status';
import { resetLoggerInstance } from '../../../logger';

/** Bridge list + daemon status must reflect disk; never serve a stale snapshot. */
export const dynamic = 'force-dynamic';

function envPresenceSnapshot(): Record<string, boolean> {
  const keys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CTI_CODEX_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'CTI_CODEX_BASE_URL',
  ] as const;
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    out[key] = Boolean(process.env[key]?.trim());
  }
  return out;
}

export async function GET(): Promise<Response> {
  const activeBotName = getCtiBotDisplayName();
  const discovered = listBridgeSlugs();
  const bridges = [...new Set([...discovered, activeBotName])].sort((a, b) => a.localeCompare(b));

  const configsByBridge: Record<string, Config> = {};
  const secretFieldsByBridge: Record<string, string[]> = {};
  const daemonStatusByBridge: Record<string, ReturnType<typeof readBridgeDaemonDiskStatus>> = {};

  for (const slug of bridges) {
    const home = getCtiHomeForBridgeSlug(slug);
    const raw = loadConfig(home);
    const { config, secretFields } = configForAdminResponse(raw);
    configsByBridge[slug] = config;
    secretFieldsByBridge[slug] = secretFields;
    daemonStatusByBridge[slug] = readBridgeDaemonDiskStatus(home);
  }

  const raw = loadConfig();
  const { config, secretFields } = configForAdminResponse(raw);

  return Response.json({
    ok: true,
    configPath: getConfigPath(),
    ctiHome: getCtiHome(),
    ctiBaseDir: getCtiBaseDir(),
    botName: activeBotName,
    bridges,
    canSwitchBridges: canSwitchBridgesViaRegistry(),
    daemonStatus: readBridgeDaemonDiskStatus(),
    daemonStatusByBridge,
    config,
    secretFields,
    configsByBridge,
    secretFieldsByBridge,
    envPresence: envPresenceSnapshot(),
  });
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<Config> & { targetBridge?: string };
    const { targetBridge, ...patch } = body;
    const slug = typeof targetBridge === 'string' ? targetBridge.trim() : '';
    const home = slug ? getCtiHomeForBridgeSlug(slug) : undefined;
    const prev = home ? loadConfig(home) : loadConfig();
    const next = mergeConfigPatch(prev, patch);
    if (next.imBot && slug) {
      next.imBot = { ...next.imBot, id: slug };
    }
    saveConfig(next, home);
    const activeResolved = path.resolve(getCtiHome());
    const savedResolved = home ? path.resolve(home) : activeResolved;
    if (savedResolved === activeResolved) {
      syncConfigFileToProcessEnv();
    }
    return Response.json({ ok: true, configPath: home ? path.join(home, 'config.env') : getConfigPath() });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      newBridge?: boolean;
      switchBridge?: string;
      deleteBridge?: string;
    };
    if (typeof body.deleteBridge === 'string' && body.deleteBridge.trim()) {
      const result = deleteBridge(body.deleteBridge.trim());
      resetLoggerInstance();
      return Response.json({ ok: true, ...result });
    }
    if (typeof body.switchBridge === 'string' && body.switchBridge.trim()) {
      const result = switchActiveBridge(body.switchBridge.trim());
      resetLoggerInstance();
      return Response.json({ ok: true, ...result });
    }
    if (body?.newBridge === true) {
      const result = createNewBridge();
      resetLoggerInstance();
      return Response.json({ ok: true, ...result });
    }
    return Response.json(
      {
        ok: false,
        error:
          'Unsupported body; use { "newBridge": true }, { "switchBridge": "<slug>" }, or { "deleteBridge": "<slug>" }',
      },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
