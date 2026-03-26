import {
  CTI_BASE_DIR,
  canSwitchBridgesViaRegistry,
  createNewBridge,
  getConfigPath,
  getCtiHome,
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

export async function GET(): Promise<Response> {
  const raw = loadConfig();
  const { config, secretFields } = configForAdminResponse(raw);
  const activeBotName = getCtiBotDisplayName();
  const discovered = listBridgeSlugs();
  const bridges = [...new Set([...discovered, activeBotName])].sort((a, b) => a.localeCompare(b));
  return Response.json({
    ok: true,
    configPath: getConfigPath(),
    ctiHome: getCtiHome(),
    ctiBaseDir: CTI_BASE_DIR,
    botName: activeBotName,
    bridges,
    canSwitchBridges: canSwitchBridgesViaRegistry(),
    daemonStatus: readBridgeDaemonDiskStatus(),
    config,
    secretFields,
  });
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<Config>;
    const prev = loadConfig();
    const next = mergeConfigPatch(prev, body);
    saveConfig(next);
    syncConfigFileToProcessEnv();
    return Response.json({ ok: true, configPath: getConfigPath() });
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
