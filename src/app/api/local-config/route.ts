import {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  mergeConfigPatch,
  configForAdminResponse,
  syncConfigFileToProcessEnv,
  type Config,
} from '../../../config';

export async function GET(): Promise<Response> {
  const raw = loadConfig();
  const { config, secretFields } = configForAdminResponse(raw);
  return Response.json({
    ok: true,
    configPath: CONFIG_PATH,
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
    return Response.json({ ok: true, configPath: CONFIG_PATH });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
