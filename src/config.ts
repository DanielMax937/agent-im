import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  imScopedStoreKey,
  parseImBaseAndInstanceId,
  type ImBaseChannel,
} from "./lib/bridge/im-instance-settings";
import { applyStandardProxyEnvFromCtiProxy } from "./lib/proxy-env";

import type {
  AgentEnvSlot,
  Config,
  ImInstanceChannel,
  ImInstanceSpec,
  RunnerConfig,
  RuntimeKind,
} from "./config-shared";
import {
  normalizeRunners,
  normalizeRuntimeKind,
  parseRunnerRuntimeKind,
} from "./config-shared";

export type {
  AgentEnvSlot,
  Config,
  ImInstanceChannel,
  ImInstanceSpec,
  RunnerConfig,
  RuntimeKind,
} from "./config-shared";
export {
  normalizeRunners,
  normalizeRuntimeKind,
  parseRunnerRuntimeKind,
} from "./config-shared";

/** Base directory for per-bot homes: `~/.claude-to-im` unless `CTI_BASE` is set. */
export function getCtiBaseDir(): string {
  return process.env.CTI_BASE?.trim() || path.join(os.homedir(), ".claude-to-im");
}

const IM_INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ACTIVE_BRIDGE_FILENAME = ".active_bridge";

let bridgePathsCache: string | null = null;

export function invalidateBridgePathsCache(): void {
  bridgePathsCache = null;
}

function activeBridgeFilePath(): string {
  return path.join(getCtiBaseDir(), ACTIVE_BRIDGE_FILENAME);
}

function generateBridgeSlug(): string {
  return `bridge-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * When neither `CTI_HOME` nor `CTI_BOT_NAME` is set, read or create `CTI_BASE_DIR/.active_bridge`
 * (single-line slug) and set `process.env.CTI_BOT_NAME` so the data directory is stable for this machine.
 */
function readOrCreateActiveBridgeSlug(): string {
  fs.mkdirSync(getCtiBaseDir(), { recursive: true });
  const filePath = activeBridgeFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (raw && IM_INSTANCE_ID_RE.test(raw)) {
      process.env.CTI_BOT_NAME = raw;
      return raw;
    }
  } catch {
    /* missing file */
  }
  const slug = generateBridgeSlug();
  fs.writeFileSync(filePath, `${slug}\n`, { mode: 0o600 });
  process.env.CTI_BOT_NAME = slug;
  return slug;
}

/**
 * Resolve the bot data directory (contains `config.env`, `data/`, `logs/`, `runtime/`).
 * - If `CTI_HOME` is set → use it (absolute path).
 * - Else if `CTI_BOT_NAME` is set → `CTI_BASE_DIR/CTI_BOT_NAME`.
 * - Else → slug from `.active_bridge` (created on first use).
 */
function resolveCtiHomeDisk(): string {
  const raw = process.env.CTI_HOME?.trim();
  if (raw) {
    return path.resolve(raw);
  }
  const bot = process.env.CTI_BOT_NAME?.trim();
  if (bot) {
    if (!IM_INSTANCE_ID_RE.test(bot)) {
      throw new Error(
        `CTI_BOT_NAME must match ${IM_INSTANCE_ID_RE.source} (letters, digits, _, -).`,
      );
    }
    return path.join(getCtiBaseDir(), bot);
  }
  const slug = readOrCreateActiveBridgeSlug();
  return path.join(getCtiBaseDir(), slug);
}

/** Lazily resolved; safe to import before env is fully set (e.g. Next.js without `.env.local`). */
export function getCtiHome(): string {
  if (bridgePathsCache) return bridgePathsCache;
  bridgePathsCache = resolveCtiHomeDisk();
  return bridgePathsCache;
}

export function getConfigPath(): string {
  return path.join(getCtiHome(), "config.env");
}

/** Default bot directory under {@link getCtiBaseDir} for the Kanban web app (ignores `.active_bridge`). */
export const KANBAN_PLATFORM_DEFAULT_BOT_NAME = "kanban";

/**
 * Kanban board / workflow / runner APIs always read `config.env` from this directory (not overridable by `CTI_HOME` / `CTI_BASE` / `CTI_BOT_NAME`).
 */
export function getKanbanPlatformCtiHome(): string {
  return path.join(os.homedir(), ".claude-to-im", KANBAN_PLATFORM_DEFAULT_BOT_NAME);
}

/** `loadConfig` from {@link getKanbanPlatformCtiHome} — use for all Kanban platform server paths. */
export function loadKanbanPlatformConfig(): Config {
  return loadConfig(getKanbanPlatformCtiHome());
}

export function getSlaveEnvPath(ctiHomeOverride?: string): string {
  const home = ctiHomeOverride?.trim() ? path.resolve(ctiHomeOverride.trim()) : getCtiHome();
  return path.join(home, "config.slave.env");
}

/** Load slave runner env vars from `$CTI_HOME/config.slave.env`. Returns empty object if file missing. */
export function loadSlaveEnv(ctiHomeOverride?: string): Record<string, string> {
  try {
    const content = fs.readFileSync(getSlaveEnvPath(ctiHomeOverride), "utf-8");
    const map = parseEnvFile(content);
    const out: Record<string, string> = {};
    for (const [k, v] of map) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function isSlaveBridgeProcess(): boolean {
  return process.env.CTI_SLAVE_BRIDGE === "1";
}

function overlaySlaveEnv(env: Map<string, string>, ctiHomeOverride?: string): void {
  if (!isSlaveBridgeProcess()) return;
  const slaveEnv = loadSlaveEnv(ctiHomeOverride);
  for (const [key, value] of Object.entries(slaveEnv)) {
    env.set(key, value);
  }
}

/** Build env var entries from a slave runner config + auto mode settings. */
export function buildSlaveEnvFromRunner(
  runner: RunnerConfig,
  spec: ImInstanceSpec,
  parentConfig: Config,
): Record<string, string> {
  const env: Record<string, string> = {};
  env.CTI_RUNTIME = runner.runtime;
  env.CTI_RUNNERS = JSON.stringify([runner]);
  env.CTI_DEFAULT_RUNNER = runner.id;
  if (runner.defaultModel) env.CTI_DEFAULT_MODEL = runner.defaultModel;
  if (runner.defaultMode) env.CTI_DEFAULT_MODE = runner.defaultMode;
  if (runner.autoApprove !== undefined) env.CTI_AUTO_APPROVE = runner.autoApprove ? "true" : "false";
  if (runner.claudeExecutable) env.CTI_CLAUDE_CODE_EXECUTABLE = runner.claudeExecutable;
  if (runner.codexExecutable) env.CTI_CODEX_EXECUTABLE = runner.codexExecutable;
  if (runner.cursorExecutable) env.CTI_CURSOR_EXECUTABLE = runner.cursorExecutable;
  if (runner.copilotExecutable) env.CTI_COPILOT_EXECUTABLE = runner.copilotExecutable;
  if (runner.opencodeExecutable) env.CTI_OPENCODE_EXECUTABLE = runner.opencodeExecutable;
  // Carry forward Auto mode Redis settings so the slave bridge can connect
  if (spec.autoRedisUrl) env.CTI_AUTO_REDIS_URL = spec.autoRedisUrl;
  if (spec.autoRedisNamespace) env.CTI_AUTO_REDIS_NAMESPACE = spec.autoRedisNamespace;
  if (spec.autoMaxTurns !== undefined) env.CTI_AUTO_MAX_TURNS = String(spec.autoMaxTurns);
  if (spec.autoReviewMaxLoops !== undefined) env.CTI_AUTO_REVIEW_MAX_LOOPS = String(spec.autoReviewMaxLoops);
  if (spec.autoCoverageCommand) env.CTI_AUTO_COVERAGE_COMMAND = spec.autoCoverageCommand;
  if (spec.autoCoverageMinPct !== undefined) env.CTI_AUTO_COVERAGE_MIN_PCT = String(spec.autoCoverageMinPct);
  // Carry forward proxy
  if (parentConfig.proxy) env.CTI_PROXY = parentConfig.proxy;
  // Auto-mode timeouts + chunk logging (from saved config; else legacy: inherit generating process env)
  if (
    parentConfig.autoMasterReplyTimeoutMs !== undefined &&
    parentConfig.autoMasterReplyTimeoutMs > 0
  ) {
    env.CTI_AUTO_MASTER_REPLY_TIMEOUT_MS = String(parentConfig.autoMasterReplyTimeoutMs);
  } else if (parentConfig.autoMasterReplyTimeoutMs === undefined) {
    const v = process.env.CTI_AUTO_MASTER_REPLY_TIMEOUT_MS;
    if (v !== undefined && v !== "") env.CTI_AUTO_MASTER_REPLY_TIMEOUT_MS = v;
  }
  if (
    parentConfig.autoSlaveReplyTimeoutMs !== undefined &&
    parentConfig.autoSlaveReplyTimeoutMs > 0
  ) {
    env.CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS = String(parentConfig.autoSlaveReplyTimeoutMs);
  } else if (parentConfig.autoSlaveReplyTimeoutMs === undefined) {
    const v = process.env.CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS;
    if (v !== undefined && v !== "") env.CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS = v;
  }
  if (parentConfig.autoLogStreamChunks === false) {
    env.CTI_AUTO_LOG_STREAM_CHUNKS = "0";
  } else if (parentConfig.autoLogStreamChunks === undefined) {
    const v = process.env.CTI_AUTO_LOG_STREAM_CHUNKS;
    if (v !== undefined && v !== "") env.CTI_AUTO_LOG_STREAM_CHUNKS = v;
  }
  // Merge runner-level subprocess env last (overrides)
  if (runner.subprocessEnv) Object.assign(env, runner.subprocessEnv);
  applyStandardProxyEnvFromCtiProxy(env);
  return env;
}

/** Write slave runner env to `$CTI_HOME/config.slave.env` (atomic). */
export function saveSlaveEnv(env: Record<string, string>, ctiHomeOverride?: string): void {
  const filePath = getSlaveEnvPath(ctiHomeOverride);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let out = "# Slave runner environment — generated from admin UI\n";
  for (const [k, v] of Object.entries(env)) {
    if (!k.trim()) continue;
    out += formatEnvLine(k.trim(), v);
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Resolve the data directory for a bridge slug under `CTI_BASE_DIR`.
 * When `CTI_HOME` is set, the **active** bridge (see {@link getCtiBotDisplayName}) maps to that
 * path; any **other** slug still resolves to `CTI_BASE_DIR/<slug>` so admin/API can address
 * multiple bridge homes without all sharing one status.json.
 */
export function getCtiHomeForBridgeSlug(slug: string): string {
  const t = slug.trim();
  if (!t) return getCtiHome();
  if (process.env.CTI_HOME?.trim()) {
    const active = getCtiBotDisplayName();
    if (t === active) return getCtiHome();
    return path.join(getCtiBaseDir(), t);
  }
  return path.join(getCtiBaseDir(), t);
}

/**
 * Create a new bridge directory: writes `.active_bridge`, sets `CTI_BOT_NAME`, clears path cache.
 * Not available when `CTI_HOME` is set (explicit home wins).
 */
export function createNewBridge(): { ctiHome: string; configPath: string; botName: string } {
  if (process.env.CTI_HOME?.trim()) {
    throw new Error(
      "已设置 CTI_HOME 时无法使用「新建桥接」：请移除 CTI_HOME，改用 CTI_BOT_NAME / .active_bridge，或手动新建目录。",
    );
  }
  const slug = generateBridgeSlug();
  fs.mkdirSync(getCtiBaseDir(), { recursive: true });
  fs.writeFileSync(activeBridgeFilePath(), `${slug}\n`, { mode: 0o600 });
  process.env.CTI_BOT_NAME = slug;
  invalidateBridgePathsCache();
  const home = getCtiHome();
  fs.mkdirSync(home, { recursive: true });
  return { ctiHome: home, configPath: getConfigPath(), botName: slug };
}

/** True when per-bot dirs under CTI_BASE + `.active_bridge` apply (no explicit CTI_HOME). */
export function canSwitchBridgesViaRegistry(): boolean {
  return !process.env.CTI_HOME?.trim();
}

/** Known internal subdirectory names that should never be treated as bridge homes. */
const BRIDGE_INTERNAL_SUBDIRS = new Set(['data', 'logs', 'runtime', 'store']);

/**
 * Subdirectories of `CTI_BASE_DIR` whose names match the bot slug pattern (existing bridge homes).
 */
export function listBridgeSlugs(): string[] {
  fs.mkdirSync(getCtiBaseDir(), { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getCtiBaseDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name.startsWith(".")) continue;
    if (!IM_INSTANCE_ID_RE.test(name)) continue;
    if (BRIDGE_INTERNAL_SUBDIRS.has(name)) continue;
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Point `.active_bridge` at an existing directory under CTI_BASE_DIR. Same constraints as `createNewBridge`.
 */
export function switchActiveBridge(slug: string): { ctiHome: string; configPath: string; botName: string } {
  if (process.env.CTI_HOME?.trim()) {
    throw new Error("已设置 CTI_HOME 时无法切换桥接目录。");
  }
  const t = slug.trim();
  if (!t || !IM_INSTANCE_ID_RE.test(t)) {
    throw new Error("无效的桥接标识。");
  }
  const home = path.join(getCtiBaseDir(), t);
  let st: ReturnType<typeof fs.statSync>;
  try {
    st = fs.statSync(home);
  } catch {
    throw new Error(`未找到桥接目录：${t}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`不是目录：${t}`);
  }
  fs.mkdirSync(getCtiBaseDir(), { recursive: true });
  fs.writeFileSync(activeBridgeFilePath(), `${t}\n`, { mode: 0o600 });
  process.env.CTI_BOT_NAME = t;
  invalidateBridgePathsCache();
  return { ctiHome: getCtiHome(), configPath: getConfigPath(), botName: t };
}

/**
 * Remove a bridge home under `CTI_BASE_DIR/<slug>`. If the active bridge is removed,
 * switches to another existing slug or creates a new empty bridge.
 * Not available when `CTI_HOME` is set.
 */
export function deleteBridge(slug: string): { ctiHome: string; configPath: string; botName: string } {
  if (process.env.CTI_HOME?.trim()) {
    throw new Error(
      "已设置 CTI_HOME 时无法使用「删除桥接」：请移除 CTI_HOME 或手动删除目录。",
    );
  }
  const t = slug.trim();
  if (!t || !IM_INSTANCE_ID_RE.test(t)) {
    throw new Error("无效的桥接标识。");
  }
  if (BRIDGE_INTERNAL_SUBDIRS.has(t)) {
    throw new Error("无效的桥接标识。");
  }
  const home = path.join(getCtiBaseDir(), t);
  let st: ReturnType<typeof fs.statSync>;
  try {
    st = fs.statSync(home);
  } catch {
    throw new Error(`未找到桥接目录：${t}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`不是目录：${t}`);
  }

  const active = process.env.CTI_BOT_NAME?.trim();
  const wasActive = active === t;

  fs.rmSync(home, { recursive: true, force: true });

  if (!wasActive) {
    return {
      ctiHome: getCtiHome(),
      configPath: getConfigPath(),
      botName: getCtiBotDisplayName(),
    };
  }

  const remaining = listBridgeSlugs();
  if (remaining.length > 0) {
    return switchActiveBridge(remaining[0]);
  }
  return createNewBridge();
}

/**
 * Display label for the active data directory.
 * When `CTI_HOME` is set (e.g. embedded bridge child), use that directory's basename — do not trust
 * inherited `CTI_BOT_NAME` from the parent process (it may point at another bridge, e.g. kanban).
 * Otherwise prefer `CTI_BOT_NAME`, then basename of resolved `getCtiHome()`.
 */
export function getCtiBotDisplayName(): string {
  if (process.env.CTI_HOME?.trim()) {
    return path.basename(getCtiHome());
  }
  const fromEnv = process.env.CTI_BOT_NAME?.trim();
  if (fromEnv) return fromEnv;
  return path.basename(getCtiHome());
}

/** IM routing / store instance id — always the active bridge name (same as {@link getCtiBotDisplayName}). */
export function getImBotInstanceId(): string {
  return getCtiBotDisplayName();
}

/**
 * Redis `cti:auto:{slug}:…` segment: use {@link ImInstanceSpec.autoRedisNamespace} when set so a
 * second bridge (separate `CTI_HOME` / `config.env`) can share queues with the first.
 */
export function resolveAutoRedisBridgeSlug(config: Config): string {
  const raw = config.imBot?.autoRedisNamespace?.trim();
  if (raw && IM_INSTANCE_ID_RE.test(raw)) return raw;
  return getImBotInstanceId();
}
const IM_INSTANCE_CHANNELS: ImInstanceChannel[] = ["telegram", "discord", "feishu", "qq"];
const IM_BASE_CHANNEL_SET = new Set<string>(IM_INSTANCE_CHANNELS);

/**
 * When `imBot` is set, the bot's primary `channel` is always on; plus any IM channels listed in
 * `CTI_ENABLED_CHANNELS` (e.g. `telegram,discord`) so multi-channel bridges work. Non-IM entries
 * (e.g. legacy `agent`) are preserved from `config.enabledChannels`.
 */
export function effectiveEnabledChannels(config: Config): string[] {
  const bot = config.imBot;
  if (!bot) {
    return [...config.enabledChannels];
  }
  const out = new Set<string>();
  if (bot.enabled !== false) {
    out.add(bot.channel);
  }
  for (const c of config.enabledChannels) {
    if (IM_BASE_CHANNEL_SET.has(c)) out.add(c);
  }
  const legacyNonIm = config.enabledChannels.filter((c) => !IM_BASE_CHANNEL_SET.has(c));
  for (const c of legacyNonIm) out.add(c);
  return Array.from(out).sort();
}

function pickRunnerBoolRow(o: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in o)) return undefined;
  const v = o[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function pickRunnerStrRow(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function pickRunnerModeRow(o: Record<string, unknown>): "code" | "plan" | "ask" | undefined {
  const v = o.defaultMode;
  if (v === "code" || v === "plan" || v === "ask") return v;
  return undefined;
}

function pickRunnerSubprocessEnvRow(o: Record<string, unknown>): Record<string, string> | undefined {
  const raw = o.subprocessEnv;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parse one runner object from JSON (shared by `CTI_RUNNERS` and `imBot.runners`). */
export function runnerFromRow(o: Record<string, unknown>): RunnerConfig | null {
  const id = o.id;
  const rt = o.runtime;
  if (typeof id !== "string") return null;
  const runtime = parseRunnerRuntimeKind(rt);
  if (runtime === null) return null;
  return {
    id,
    runtime,
    label: pickRunnerStrRow(o, "label"),
    defaultModel: pickRunnerStrRow(o, "defaultModel"),
    defaultMode: pickRunnerModeRow(o),
    autoApprove: pickRunnerBoolRow(o, "autoApprove"),
    claudeExecutable: pickRunnerStrRow(o, "claudeExecutable"),
    claudeUseLogin: pickRunnerBoolRow(o, "claudeUseLogin"),
    codexUseLogin: pickRunnerBoolRow(o, "codexUseLogin"),
    codexExecutable: pickRunnerStrRow(o, "codexExecutable"),
    cursorExecutable: pickRunnerStrRow(o, "cursorExecutable"),
    cursorDefaultModel: pickRunnerStrRow(o, "cursorDefaultModel"),
    copilotExecutable: pickRunnerStrRow(o, "copilotExecutable"),
    opencodeExecutable: pickRunnerStrRow(o, "opencodeExecutable"),
    subprocessEnv: pickRunnerSubprocessEnvRow(o),
  };
}

function parseRunnersField(raw: unknown): RunnerConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RunnerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = runnerFromRow(item as Record<string, unknown>);
    if (r) out.push(r);
  }
  return out.length ? out : undefined;
}

function imInstanceSpecFromRow(o: Record<string, unknown>): ImInstanceSpec | null {
  const channel = o.channel;
  if (
    typeof channel !== "string" ||
    !IM_INSTANCE_CHANNELS.includes(channel as ImInstanceChannel)
  ) {
    return null;
  }
  const ch = channel as ImInstanceChannel;
  const rawId = o.id;
  const id =
    typeof rawId === "string" && IM_INSTANCE_ID_RE.test(rawId.trim())
      ? rawId.trim()
      : getCtiBotDisplayName();
  if (!IM_INSTANCE_ID_RE.test(id)) return null;
  const autoModeMerged =
    typeof o.autoMode === "boolean"
      ? o.autoMode
      : typeof o.localAgentEnabled === "boolean"
        ? o.localAgentEnabled
        : undefined;
  const autoSlaveRunner =
    o.autoSlaveRunner && typeof o.autoSlaveRunner === "object"
      ? runnerFromRow(o.autoSlaveRunner as Record<string, unknown>) ?? undefined
      : undefined;
  const autoRedisUrl =
    typeof o.autoRedisUrl === "string"
      ? o.autoRedisUrl
      : typeof o.localAgentRedisUrl === "string"
        ? o.localAgentRedisUrl
        : undefined;
  const autoMaxTurns =
    typeof o.autoMaxTurns === "number"
      ? o.autoMaxTurns
      : typeof o.localAgentMaxTurns === "number"
        ? o.localAgentMaxTurns
        : undefined;
  const autoRedisNamespace =
    typeof o.autoRedisNamespace === "string" && IM_INSTANCE_ID_RE.test(o.autoRedisNamespace.trim())
      ? o.autoRedisNamespace.trim()
      : undefined;
  const autoSlaveExternal =
    typeof o.autoSlaveExternal === "boolean" ? o.autoSlaveExternal : undefined;
  const autoReviewMaxLoops =
    typeof o.autoReviewMaxLoops === "number" ? o.autoReviewMaxLoops : undefined;
  const autoCoverageCommand =
    typeof o.autoCoverageCommand === "string" && o.autoCoverageCommand.trim()
      ? o.autoCoverageCommand.trim()
      : undefined;
  const autoCoverageMinPct =
    typeof o.autoCoverageMinPct === "number" ? o.autoCoverageMinPct : undefined;
  return {
    id,
    channel: ch,
    enabled: o.enabled === undefined ? undefined : Boolean(o.enabled),
    tgBotToken: typeof o.tgBotToken === "string" ? o.tgBotToken : undefined,
    tgAllowedUsers: Array.isArray(o.tgAllowedUsers)
      ? o.tgAllowedUsers.map(String)
      : undefined,
    tgChatId: typeof o.tgChatId === "string" ? o.tgChatId : undefined,
    discordBotToken:
      typeof o.discordBotToken === "string" ? o.discordBotToken : undefined,
    discordAllowedUsers: Array.isArray(o.discordAllowedUsers)
      ? o.discordAllowedUsers.map(String)
      : undefined,
    discordAllowedChannels: Array.isArray(o.discordAllowedChannels)
      ? o.discordAllowedChannels.map(String)
      : undefined,
    discordAllowedGuilds: Array.isArray(o.discordAllowedGuilds)
      ? o.discordAllowedGuilds.map(String)
      : undefined,
    feishuAppId: typeof o.feishuAppId === "string" ? o.feishuAppId : undefined,
    feishuAppSecret:
      typeof o.feishuAppSecret === "string" ? o.feishuAppSecret : undefined,
    feishuDomain: typeof o.feishuDomain === "string" ? o.feishuDomain : undefined,
    feishuAllowedUsers: Array.isArray(o.feishuAllowedUsers)
      ? o.feishuAllowedUsers.map(String)
      : undefined,
    qqAppId: typeof o.qqAppId === "string" ? o.qqAppId : undefined,
    qqAppSecret: typeof o.qqAppSecret === "string" ? o.qqAppSecret : undefined,
    qqAllowedUsers: Array.isArray(o.qqAllowedUsers)
      ? o.qqAllowedUsers.map(String)
      : undefined,
    qqImageEnabled:
      typeof o.qqImageEnabled === "boolean" ? o.qqImageEnabled : undefined,
    qqMaxImageSize:
      typeof o.qqMaxImageSize === "number" ? o.qqMaxImageSize : undefined,
    autoMode: autoModeMerged,
    autoRedisUrl,
    autoMaxTurns,
    autoSlaveRunner,
    autoRedisNamespace,
    autoSlaveExternal,
    autoReviewMaxLoops,
    autoCoverageCommand,
    autoCoverageMinPct,
    runners: parseRunnersField(o.runners),
    defaultRunnerId:
      typeof o.defaultRunnerId === "string" && o.defaultRunnerId.trim()
        ? o.defaultRunnerId.trim()
        : undefined,
    defaultWorkDir:
      typeof o.defaultWorkDir === "string" ? o.defaultWorkDir : undefined,
    proxy: typeof o.proxy === "string" ? o.proxy : undefined,
    autoApprove: o.autoApprove === undefined ? undefined : Boolean(o.autoApprove),
    defaultModel: typeof o.defaultModel === "string" ? o.defaultModel : undefined,
    defaultMode: typeof o.defaultMode === "string" ? o.defaultMode : undefined,
  };
}

function parseImBot(env: Map<string, string>): ImInstanceSpec | undefined {
  const botJson = env.get("CTI_IM_BOT")?.trim();
  if (botJson) {
    try {
      const o = JSON.parse(botJson) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const spec = imInstanceSpecFromRow(o as Record<string, unknown>);
        if (spec) return spec;
      }
    } catch {
      /* ignore */
    }
  }
  const legacy = env.get("CTI_IM_INSTANCES")?.trim();
  if (legacy) {
    try {
      const arr = JSON.parse(legacy) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        const row = arr[0];
        if (row && typeof row === "object") {
          return imInstanceSpecFromRow(row as Record<string, unknown>) ?? undefined;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function applyImBotToSettings(m: Map<string, string>, config: Config): void {
  const spec = config.imBot;
  if (!spec) return;
  const ch = spec.channel;
  const base = ch as ImBaseChannel;
  const id = getImBotInstanceId();
  m.set(`bridge_${base}_instances`, id);
  m.set(`bridge_${base}_enabled`, spec.enabled !== false ? "true" : "false");
  const en = spec.enabled !== false;
  m.set(imScopedStoreKey(base, id, `bridge_${base}_enabled`), en ? "true" : "false");

  if (ch === "telegram") {
        if (spec.tgBotToken) {
          m.set(imScopedStoreKey(base, id, "telegram_bot_token"), spec.tgBotToken);
        }
        if (spec.tgAllowedUsers?.length) {
          m.set(
            imScopedStoreKey(base, id, "telegram_bridge_allowed_users"),
            spec.tgAllowedUsers.join(","),
          );
        }
        if (spec.tgChatId) {
          m.set(imScopedStoreKey(base, id, "telegram_chat_id"), spec.tgChatId);
        }
      } else if (ch === "discord") {
        if (spec.discordBotToken) {
          m.set(
            imScopedStoreKey(base, id, "bridge_discord_bot_token"),
            spec.discordBotToken,
          );
        }
        if (spec.discordAllowedUsers?.length) {
          m.set(
            imScopedStoreKey(base, id, "bridge_discord_allowed_users"),
            spec.discordAllowedUsers.join(","),
          );
        }
        if (spec.discordAllowedChannels?.length) {
          m.set(
            imScopedStoreKey(base, id, "bridge_discord_allowed_channels"),
            spec.discordAllowedChannels.join(","),
          );
        }
        if (spec.discordAllowedGuilds?.length) {
          m.set(
            imScopedStoreKey(base, id, "bridge_discord_allowed_guilds"),
            spec.discordAllowedGuilds.join(","),
          );
        }
      } else if (ch === "feishu") {
        if (spec.feishuAppId) {
          m.set(imScopedStoreKey(base, id, "bridge_feishu_app_id"), spec.feishuAppId);
        }
        if (spec.feishuAppSecret) {
          m.set(
            imScopedStoreKey(base, id, "bridge_feishu_app_secret"),
            spec.feishuAppSecret,
          );
        }
        if (spec.feishuDomain) {
          m.set(imScopedStoreKey(base, id, "bridge_feishu_domain"), spec.feishuDomain);
        }
        if (spec.feishuAllowedUsers?.length) {
          m.set(
            imScopedStoreKey(base, id, "bridge_feishu_allowed_users"),
            spec.feishuAllowedUsers.join(","),
          );
        }
      } else if (ch === "qq") {
        if (spec.qqAppId) {
          m.set(imScopedStoreKey(base, id, "bridge_qq_app_id"), spec.qqAppId);
        }
        if (spec.qqAppSecret) {
          m.set(imScopedStoreKey(base, id, "bridge_qq_app_secret"), spec.qqAppSecret);
        }
        if (spec.qqAllowedUsers?.length) {
          m.set(
            imScopedStoreKey(base, id, "bridge_qq_allowed_users"),
            spec.qqAllowedUsers.join(","),
          );
        }
        if (spec.qqImageEnabled !== undefined) {
          m.set(
            imScopedStoreKey(base, id, "bridge_qq_image_enabled"),
            String(spec.qqImageEnabled),
          );
        }
        if (spec.qqMaxImageSize !== undefined) {
          m.set(
            imScopedStoreKey(base, id, "bridge_qq_max_image_size"),
            String(spec.qqMaxImageSize),
          );
        }
  }

  if (spec.autoMode !== undefined) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_mode`),
      spec.autoMode ? "true" : "false",
    );
  }
  if (spec.autoRedisUrl) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_redis_url`),
      spec.autoRedisUrl,
    );
  }
  if (spec.autoMaxTurns !== undefined) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_max_turns`),
      String(spec.autoMaxTurns),
    );
  }
  if (spec.autoReviewMaxLoops !== undefined) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_review_max_loops`),
      String(spec.autoReviewMaxLoops),
    );
  }
  if (spec.autoCoverageCommand) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_coverage_command`),
      spec.autoCoverageCommand,
    );
  }
  if (spec.autoCoverageMinPct !== undefined) {
    m.set(
      imScopedStoreKey(base, id, `bridge_${base}_auto_coverage_min_pct`),
      String(spec.autoCoverageMinPct),
    );
  }
}

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/**
 * Loads `$CTI_HOME/config.env` entries into `process.env` so modules that
 * only read `process.env` (e.g. agent-adapter `CTI_AGENT_1_*`) see the file.
 */
export function syncConfigFileToProcessEnv(ctiHomeOverride?: string): void {
  try {
    const configPath = ctiHomeOverride?.trim()
      ? path.join(path.resolve(ctiHomeOverride.trim()), "config.env")
      : getConfigPath();
    const content = fs.readFileSync(configPath, "utf-8");
    const env = parseEnvFile(content);
    for (const [key, value] of env) {
      if (value !== undefined) process.env[key] = value;
    }
    if (isSlaveBridgeProcess()) {
      const slaveEnv = loadSlaveEnv(ctiHomeOverride);
      for (const [key, value] of Object.entries(slaveEnv)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
    try {
      process.env.CTI_RUNTIME = resolveEffectiveRuntime(loadConfig(ctiHomeOverride));
    } catch {
      /* ignore */
    }
    // Kanban Next server, bridge daemon, admin reload: mirror CTI_PROXY → HTTP(S)_PROXY for CLI runners.
    applyStandardProxyEnvFromCtiProxy(process.env);
  } catch {
    /* missing file */
  }
}

function parseAgentSlotsFromEnv(env: Map<string, string>): AgentEnvSlot[] {
  const slots: AgentEnvSlot[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const apiKey = env.get(`CTI_AGENT_${i}_OPENAI_API_KEY`);
    if (!apiKey) continue;
    slots.push({
      slot: i,
      openaiApiKey: apiKey,
      redisUrl: env.get(`CTI_AGENT_${i}_REDIS_URL`) || undefined,
      firstPrompt: env.get(`CTI_AGENT_${i}_FIRST_PROMPT`) || undefined,
      openaiBaseUrl: env.get(`CTI_AGENT_${i}_OPENAI_BASE_URL`) || undefined,
      openaiModel: env.get(`CTI_AGENT_${i}_OPENAI_MODEL`) || undefined,
      maxTurns: env.get(`CTI_AGENT_${i}_MAX_TURNS`)
        ? Number(env.get(`CTI_AGENT_${i}_MAX_TURNS`))
        : undefined,
    });
  }
  return slots;
}

function parseRunnerJsonArray(raw: string | undefined): RunnerConfig[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out: RunnerConfig[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const r = runnerFromRow(item as Record<string, unknown>);
      if (r) out.push(r);
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Effective runner list for Kanban / platform APIs.
 *
 * - {@link normalizeRunners} prefers `imBot.runners` and **drops** top-level `CTI_RUNNERS` (`config.runners`)
 *   when the bot has its own list — but Kanban may still reference ids that exist only in file-level
 *   `CTI_RUNNERS`, which previously produced orphan rows with `runtime: "unknown"`. We union in those
 *   missing ids here (imBot / primary wins on duplicate id).
 * - Then merges `process.env.CTI_RUNNERS` (e.g. Next.js `.env.local`) so dev env can add or override.
 */
export function normalizeRunnersWithProcessEnvOverride(config: Config): RunnerConfig[] {
  const primary = normalizeRunners(config);
  const byId = new Map(primary.map((r) => [r.id, r]));
  if (config.runners?.length) {
    for (const r of config.runners) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  const merged = [...byId.values()];
  const envExtra = parseRunnerJsonArray(process.env.CTI_RUNNERS);
  if (!envExtra?.length) return merged;
  const byId2 = new Map(merged.map((r) => [r.id, r]));
  for (const r of envExtra) {
    byId2.set(r.id, r);
  }
  return [...byId2.values()];
}

export function findImInstanceSpec(
  config: Config,
  base: ImInstanceChannel,
  instanceId: string,
): ImInstanceSpec | undefined {
  const bot = config.imBot;
  if (!bot || bot.channel !== base) return undefined;
  const bridgeId = getImBotInstanceId();
  if (instanceId === "default") return bot;
  if (instanceId === bridgeId) return bot;
  if (bot.id && instanceId === bot.id) return bot;
  return undefined;
}

/** Runners for one IM bot: embedded list, or bridge-level `CTI_RUNNERS` fallback. */
export function normalizeRunnersForInstance(spec: ImInstanceSpec, config: Config): RunnerConfig[] {
  const base =
    spec.runners && spec.runners.length > 0 ? spec.runners : normalizeRunners(config);
  const s = spec.autoSlaveRunner;
  if (!s?.id?.trim()) return base;
  const id = s.id.trim();
  // Populate slave runner subprocessEnv from config.slave.env (file-based, replaces inline JSON)
  const fileEnv = loadSlaveEnv();
  const merged: RunnerConfig = {
    ...s,
    id,
    subprocessEnv: Object.keys(fileEnv).length > 0 ? fileEnv : s.subprocessEnv,
  };
  const withoutDup = base.filter((r) => r.id !== id);
  return [...withoutDup, merged];
}

/** Runners visible on a given adapter `channelType` (`telegram` or `telegram:slug`). */
export function normalizeRunnersForChannelType(config: Config, channelType: string): RunnerConfig[] {
  const parsed = parseImBaseAndInstanceId(channelType);
  if (!parsed) return normalizeRunners(config);
  const spec = findImInstanceSpec(config, parsed.base, parsed.instanceId);
  if (spec) return normalizeRunnersForInstance(spec, config);
  return normalizeRunners(config);
}

export function defaultRunnerIdForChannelType(config: Config, channelType: string): string | undefined {
  const runners = normalizeRunnersForChannelType(config, channelType);
  const first = runners[0]?.id;
  const parsed = parseImBaseAndInstanceId(channelType);
  if (parsed) {
    const spec = findImInstanceSpec(config, parsed.base, parsed.instanceId);
    if (spec?.defaultRunnerId) return spec.defaultRunnerId;
  }
  return config.defaultRunnerId ?? first;
}

/**
 * Prefix for IM LLM map keys: `__legacy__` when no `imBot`, else `base:instanceId`
 * (matches {@link collectImLlmBuildEntries}).
 */
export function imLlmKeyPrefix(config: Config, channelType: string): string {
  if (!config.imBot) return "__legacy__";
  const p = parseImBaseAndInstanceId(channelType);
  if (!p) return "__legacy__";
  return `${p.base}:${getImBotInstanceId()}`;
}

/** One provider per `(keyPrefix, runner.id)` — one bridge process hosts one bot (`imBot`). */
export function collectImLlmBuildEntries(
  config: Config,
): Array<{ keyPrefix: string; runner: RunnerConfig }> {
  const out: Array<{ keyPrefix: string; runner: RunnerConfig }> = [];
  if (!config.imBot) {
    for (const r of normalizeRunners(config)) {
      out.push({ keyPrefix: "__legacy__", runner: r });
    }
    return out;
  }
  const spec = config.imBot;
  const channels = new Set<ImInstanceChannel>();
  channels.add(spec.channel);
  for (const ch of config.enabledChannels) {
    if (IM_BASE_CHANNEL_SET.has(ch)) channels.add(ch as ImInstanceChannel);
  }
  const runners = normalizeRunnersForInstance(spec, config);
  for (const channel of channels) {
    const keyPrefix = `${channel}:${getImBotInstanceId()}`;
    for (const r of runners) {
      out.push({ keyPrefix, runner: r });
    }
  }
  return out;
}

export function defaultImLlmCompositeKey(config: Config): string {
  const runners = normalizeRunners(config);
  const id = config.defaultRunnerId ?? runners[0]?.id ?? "default";
  if (!config.imBot) {
    return `__legacy__\0${id}`;
  }
  const spec = config.imBot;
  const ct = `${spec.channel}:${getImBotInstanceId()}`;
  const eff = defaultRunnerIdForChannelType(config, ct) ?? id;
  return `${ct}\0${eff}`;
}

/** Runtime used by the IM bridge (default runner, or first runner). */
export function resolveEffectiveRuntime(config: Config): RuntimeKind {
  const runners = normalizeRunners(config);
  const id = config.defaultRunnerId ?? runners[0]?.id;
  const p = runners.find((x) => x.id === id) ?? runners[0];
  return normalizeRuntimeKind(p?.runtime ?? config.runtime);
}

/** Effective runtime for a platform agent instance (runner id overrides stored `runtime`). */
export function resolveRuntimeForPlatformInstance(
  config: Config,
  instance: { runtime: string; runtimeProfileId?: string },
): RuntimeKind {
  if (instance.runtimeProfileId) {
    const p = normalizeRunnersWithProcessEnvOverride(config).find(
      (x) => x.id === instance.runtimeProfileId,
    );
    if (p) return normalizeRuntimeKind(p.runtime);
  }
  return normalizeRuntimeKind(instance.runtime);
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Merge `imBot` bridge fields into top-level `Config` for code paths that read `config.proxy`, etc. */
function applyImBotToFlatConfig(c: Config, env: Map<string, string> = new Map()): void {
  const b = c.imBot;
  if (!b) return;
  const slave = isSlaveBridgeProcess();
  if (b.defaultWorkDir !== undefined && b.defaultWorkDir !== "" && !(slave && env.has("CTI_DEFAULT_WORKDIR"))) {
    c.defaultWorkDir = b.defaultWorkDir;
  }
  if (b.proxy !== undefined && !(slave && env.has("CTI_PROXY"))) c.proxy = b.proxy;
  if (b.autoApprove !== undefined && !(slave && env.has("CTI_AUTO_APPROVE"))) c.autoApprove = b.autoApprove;
  if (!(slave && env.has("CTI_RUNNERS"))) {
    c.runners = normalizeRunners(c).map((x) => ({ ...x }));
  }
  if (b.defaultRunnerId && !(slave && env.has("CTI_DEFAULT_RUNNER"))) c.defaultRunnerId = b.defaultRunnerId;
}

/**
 * After removing `imBot`, clear top-level `CTI_*` mirrors that still matched the old bot so
 * `saveConfig` does not leave stale duplicates. Only strips when the removed bot had an
 * explicit value for that field (or runners matched the effective bot list).
 */
function stripFlatFieldsMirroredFromRemovedImBot(prev: Config, next: Config): void {
  const b = prev.imBot;
  if (!b) return;

  const prevNorm = normalizeRunners(prev).map((r) => ({ ...r }));
  const botNormRaw = b.runners?.length
    ? b.runners
    : normalizeRunners({ ...prev, imBot: undefined });
  const botNorm = botNormRaw.map((r) => ({ ...r }));
  if (JSON.stringify(prevNorm) === JSON.stringify(botNorm)) {
    next.runners = undefined;
  }

  if (b.defaultWorkDir !== undefined && b.defaultWorkDir !== "" && next.defaultWorkDir === b.defaultWorkDir) {
    next.defaultWorkDir = process.cwd();
  }
  if (b.proxy !== undefined && next.proxy === b.proxy) {
    next.proxy = undefined;
  }
  if (b.autoApprove !== undefined && next.autoApprove === b.autoApprove) {
    next.autoApprove = false;
  }
  if (b.defaultModel !== undefined && next.defaultModel === b.defaultModel) {
    next.defaultModel = undefined;
  }
  if (b.defaultMode !== undefined && next.defaultMode === b.defaultMode) {
    next.defaultMode = "code";
  }
  if (b.defaultRunnerId !== undefined && next.defaultRunnerId === b.defaultRunnerId) {
    next.defaultRunnerId = undefined;
  }
}

/** File `config.env` value, overridden by `process.env.CTI_AUTO_APPROVE` when set (e.g. CI / e2e). */
function resolveAutoApproveFromEnvMaps(fileEnv: Map<string, string>): boolean {
  const fromFile = fileEnv.get("CTI_AUTO_APPROVE") === "true";
  const oa = process.env.CTI_AUTO_APPROVE?.trim();
  if (oa === "true" || oa === "1") return true;
  if (oa === "false" || oa === "0") return false;
  return fromFile;
}

export function loadConfig(ctiHomeOverride?: string): Config {
  const configPath = ctiHomeOverride?.trim()
    ? path.join(path.resolve(ctiHomeOverride.trim()), "config.env")
    : getConfigPath();
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }
  overlaySlaveEnv(env, ctiHomeOverride);

  const rawRuntime = env.get("CTI_RUNTIME")?.trim() || "claude";
  const runtime = normalizeRuntimeKind(rawRuntime);

  const runners = parseRunnerJsonArray(env.get("CTI_RUNNERS"));
  const defaultRunnerId = env.get("CTI_DEFAULT_RUNNER")?.trim() || undefined;

  const base: Config = {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir: env.get("CTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    // Agent - collect all agent instance configs
    agentRedisUrl: env.get("CTI_AGENT_REDIS_URL") || undefined,
    agentFirstPrompt: env.get("CTI_AGENT_FIRST_PROMPT") || undefined,
    agentOpenAIBaseUrl: env.get("CTI_AGENT_OPENAI_BASE_URL") || undefined,
    agentOpenAIModel: env.get("CTI_AGENT_OPENAI_MODEL") || undefined,
    agentOpenAIApiKey: env.get("CTI_AGENT_OPENAI_API_KEY") || undefined,
    agentMaxTurns: env.get("CTI_AGENT_MAX_TURNS")
      ? Number(env.get("CTI_AGENT_MAX_TURNS"))
      : undefined,
    proxy: env.get("CTI_PROXY") || undefined,
    autoMasterReplyTimeoutMs: (() => {
      const raw = env.get("CTI_AUTO_MASTER_REPLY_TIMEOUT_MS")?.trim();
      if (!raw) return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    autoSlaveReplyTimeoutMs: (() => {
      const raw = env.get("CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS")?.trim();
      if (!raw) return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    autoLogStreamChunks: env.has("CTI_AUTO_LOG_STREAM_CHUNKS")
      ? env.get("CTI_AUTO_LOG_STREAM_CHUNKS")?.trim() !== "0"
      : true,
    autoApprove: resolveAutoApproveFromEnvMaps(env),
    agentEnvSlots: parseAgentSlotsFromEnv(env),
    runners,
    defaultRunnerId,
    imBot: parseImBot(env),
  };

  if (runners && runners.length > 0) {
    if (isSlaveBridgeProcess() && env.has("CTI_RUNNERS")) {
      const id = defaultRunnerId ?? runners[0]?.id;
      const p = runners.find((x) => x.id === id) ?? runners[0];
      base.runtime = normalizeRuntimeKind(p?.runtime ?? base.runtime);
    } else {
      base.runtime = resolveEffectiveRuntime(base);
    }
  }

  if (base.imBot) {
    const fallback = normalizeRunners({ ...base, imBot: undefined });
    if (!base.imBot.runners?.length) {
      base.imBot.runners = fallback.map((r) => ({ ...r }));
    }
  }

  applyImBotToFlatConfig(base, env);
  base.enabledChannels = effectiveEnabledChannels(base);
  return base;
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config, ctiHomeOverride?: string): void {
  validateConfigRunners(config);
  let out = "";
  const runnerList = normalizeRunners(config);
  out += formatEnvLine("CTI_RUNNERS", JSON.stringify(runnerList));
  out += formatEnvLine("CTI_DEFAULT_RUNNER", config.defaultRunnerId);
  out += formatEnvLine("CTI_RUNTIME", resolveEffectiveRuntime(config));
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    effectiveEnabledChannels(config).join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (!config.imBot) {
    if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
    out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  }
  out += formatEnvLine("CTI_AUTO_APPROVE", config.autoApprove ? "true" : "");
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_CHANNELS",
    config.discordAllowedChannels?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_GUILDS",
    config.discordAllowedGuilds?.join(",")
  );
  out += formatEnvLine("CTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("CTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine(
    "CTI_QQ_ALLOWED_USERS",
    config.qqAllowedUsers?.join(",")
  );
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  out += formatEnvLine("CTI_PROXY", config.proxy);
  if (config.autoMasterReplyTimeoutMs !== undefined && config.autoMasterReplyTimeoutMs > 0) {
    out += formatEnvLine(
      "CTI_AUTO_MASTER_REPLY_TIMEOUT_MS",
      String(config.autoMasterReplyTimeoutMs),
    );
  }
  if (config.autoSlaveReplyTimeoutMs !== undefined && config.autoSlaveReplyTimeoutMs > 0) {
    out += formatEnvLine(
      "CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS",
      String(config.autoSlaveReplyTimeoutMs),
    );
  }
  if (config.autoLogStreamChunks === false) {
    out += formatEnvLine("CTI_AUTO_LOG_STREAM_CHUNKS", "0");
  }

  // Agent
  out += formatEnvLine("CTI_AGENT_REDIS_URL", config.agentRedisUrl);
  out += formatEnvLine("CTI_AGENT_FIRST_PROMPT", config.agentFirstPrompt);
  out += formatEnvLine("CTI_AGENT_OPENAI_BASE_URL", config.agentOpenAIBaseUrl);
  out += formatEnvLine("CTI_AGENT_OPENAI_MODEL", config.agentOpenAIModel);
  out += formatEnvLine("CTI_AGENT_OPENAI_API_KEY", config.agentOpenAIApiKey);
  if (config.agentMaxTurns !== undefined)
    out += formatEnvLine("CTI_AGENT_MAX_TURNS", String(config.agentMaxTurns));

  if (config.imBot) {
    out += formatEnvLine("CTI_IM_BOT", JSON.stringify(config.imBot));
  }

  const slots = config.agentEnvSlots ?? [];
  for (const slot of slots) {
    if (slot.slot < 1 || slot.slot > 10) continue;
    const p = `CTI_AGENT_${slot.slot}_`;
    out += formatEnvLine(`${p}OPENAI_API_KEY`, slot.openaiApiKey);
    out += formatEnvLine(`${p}REDIS_URL`, slot.redisUrl);
    out += formatEnvLine(`${p}FIRST_PROMPT`, slot.firstPrompt);
    out += formatEnvLine(`${p}OPENAI_BASE_URL`, slot.openaiBaseUrl);
    out += formatEnvLine(`${p}OPENAI_MODEL`, slot.openaiModel);
    if (slot.maxTurns !== undefined)
      out += formatEnvLine(`${p}MAX_TURNS`, String(slot.maxTurns));
  }

  const targetHome = ctiHomeOverride?.trim()
    ? path.resolve(ctiHomeOverride.trim())
    : getCtiHome();
  fs.mkdirSync(targetHome, { recursive: true });
  const cfgPath = path.join(targetHome, "config.env");
  const tmpPath = cfgPath + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, cfgPath);
}

function validateRunnerList(runners: RunnerConfig[] | undefined, pathLabel: string): void {
  if (!runners) return;
  for (let index = 0; index < runners.length; index += 1) {
    const runner = runners[index];
    const runtime = runner.runtime;
    if (runtime !== 'claude' && runtime !== 'codex' && runtime !== 'cursor' && runtime !== 'copilot' && runtime !== 'opencode') {
      throw new Error(
        `${pathLabel}[${index}] has unsupported runtime "${String(runtime)}". ` +
          'Allowed values: claude, codex, cursor, copilot, opencode.',
      );
    }
  }
}

function normalizeImBotAutoFields(spec: ImInstanceSpec): ImInstanceSpec {
  if (spec.channel === 'telegram') return spec;
  if (spec.autoSlaveExternal === undefined) return spec;
  return {
    ...spec,
    autoSlaveExternal: undefined,
  };
}

export function validateConfigRunners(config: Config): void {
  validateRunnerList(config.runners, 'runners');
  validateRunnerList(config.imBot?.runners, 'imBot.runners');
  if (config.imBot?.autoSlaveRunner) {
    validateRunnerList([config.imBot.autoSlaveRunner], 'imBot.autoSlaveRunner');
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

const CONFIG_SECRET_KEYS = [
  "tgBotToken",
  "feishuAppSecret",
  "discordBotToken",
  "qqAppSecret",
  "agentOpenAIApiKey",
] as const;

export type ConfigSecretKey = (typeof CONFIG_SECRET_KEYS)[number];

export function isMaskedSecretPlaceholder(value: string | undefined): boolean {
  return !!value && value.startsWith("*") && value.length >= 4;
}

function mergeImSecret(
  incoming: string | undefined,
  prev: string | undefined,
): string | undefined {
  if (incoming === undefined || incoming === "" || isMaskedSecretPlaceholder(incoming)) {
    return prev;
  }
  return incoming;
}

/** Merge a PATCH body into the previous config; masked secrets and empty strings keep prior values. */
export function mergeConfigPatch(
  prev: Config,
  patch: Partial<Config> & { imBot?: ImInstanceSpec | null },
): Config {
  const next: Config = { ...prev, ...patch };
  for (const key of CONFIG_SECRET_KEYS) {
    const incoming = patch[key];
    if (incoming === undefined || incoming === "" || isMaskedSecretPlaceholder(incoming as string)) {
      next[key] = prev[key];
    }
  }
  if (patch.agentEnvSlots !== undefined) {
    next.agentEnvSlots = patch.agentEnvSlots
      .map((slot) => {
        const prevSlot = prev.agentEnvSlots?.find((s) => s.slot === slot.slot);
        let openaiApiKey = slot.openaiApiKey;
        if (!openaiApiKey || isMaskedSecretPlaceholder(openaiApiKey)) {
          openaiApiKey = prevSlot?.openaiApiKey ?? openaiApiKey;
        }
        return { ...slot, openaiApiKey };
      })
      .filter((s) => !!s.openaiApiKey?.trim());
  }
  if (patch.imBot !== undefined) {
    if (patch.imBot === null) {
      next.imBot = undefined;
      stripFlatFieldsMirroredFromRemovedImBot(prev, next);
    } else {
      const prevSpec = prev.imBot;
      const spec = patch.imBot;
      const fallback = normalizeRunners({ ...next, imBot: undefined });
      const runners = spec.runners?.length
        ? spec.runners
        : prevSpec?.runners?.length
          ? prevSpec.runners
          : [...fallback];
      if (!runners.length) {
        throw new Error(
          `IM bot (${spec.channel}): 至少配置一个 Runner（runners 不能为空）`,
        );
      }
      next.imBot = {
        ...prevSpec,
        ...spec,
        runners,
        defaultRunnerId: spec.defaultRunnerId ?? prevSpec?.defaultRunnerId,
        tgBotToken: mergeImSecret(spec.tgBotToken, prevSpec?.tgBotToken),
        discordBotToken: mergeImSecret(spec.discordBotToken, prevSpec?.discordBotToken),
        feishuAppSecret: mergeImSecret(spec.feishuAppSecret, prevSpec?.feishuAppSecret),
        qqAppSecret: mergeImSecret(spec.qqAppSecret, prevSpec?.qqAppSecret),
      };
      next.imBot = normalizeImBotAutoFields(next.imBot);
      delete next.imBot.enabled;
      delete next.imBot.defaultModel;
      delete next.imBot.defaultMode;
      next.defaultModel = undefined;
      next.imBot.id = getImBotInstanceId();
    }
  }
  applyImBotToFlatConfig(next);
  next.enabledChannels = effectiveEnabledChannels(next);
  return next;
}

export function configForAdminResponse(config: Config): {
  config: Config;
  secretFields: ConfigSecretKey[];
} {
  const secretFields: ConfigSecretKey[] = [];
  const clone: Config = {
    ...config,
    agentEnvSlots: config.agentEnvSlots?.map((s) => ({ ...s })),
  };
  const mutable = clone as unknown as Record<string, unknown>;
  for (const key of CONFIG_SECRET_KEYS) {
    const v = clone[key];
    if (typeof v === "string" && v.length > 0) {
      mutable[key] = maskSecret(v);
      secretFields.push(key);
    }
  }
  if (clone.agentEnvSlots?.length) {
    clone.agentEnvSlots = clone.agentEnvSlots.map((s) => ({
      ...s,
      openaiApiKey: s.openaiApiKey ? maskSecret(s.openaiApiKey) : undefined,
    }));
  }
  if (clone.imBot) {
    const fallback = normalizeRunners(clone).map((r) => ({ ...r }));
    const spec = clone.imBot;
    clone.imBot = {
      ...spec,
      runners: spec.runners?.length ? spec.runners : [...fallback],
      tgBotToken: spec.tgBotToken ? maskSecret(spec.tgBotToken) : undefined,
      discordBotToken: spec.discordBotToken ? maskSecret(spec.discordBotToken) : undefined,
      feishuAppSecret: spec.feishuAppSecret ? maskSecret(spec.feishuAppSecret) : undefined,
      qqAppSecret: spec.qqAppSecret ? maskSecret(spec.qqAppSecret) : undefined,
    };
  }
  clone.enabledChannels = effectiveEnabledChannels(clone);
  return { config: clone, secretFields };
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  const imBot = config.imBot;
  const enabledCh = effectiveEnabledChannels(config);
  const hasTelegramIm = imBot?.channel === "telegram";
  const hasDiscordIm = imBot?.channel === "discord";
  const hasFeishuIm = imBot?.channel === "feishu";
  const hasQqIm = imBot?.channel === "qq";

  if (imBot) {
    applyImBotToSettings(m, config);
  }

  // ── Telegram (flat CTI_* when no imBot for this channel) ──
  if (!hasTelegramIm) {
    m.set(
      "bridge_telegram_enabled",
      enabledCh.includes("telegram") ? "true" : "false",
    );
    if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
    if (config.tgAllowedUsers)
      m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
    if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);
  }

  // ── Discord ──
  if (!hasDiscordIm) {
    m.set(
      "bridge_discord_enabled",
      enabledCh.includes("discord") ? "true" : "false",
    );
    if (config.discordBotToken)
      m.set("bridge_discord_bot_token", config.discordBotToken);
    if (config.discordAllowedUsers)
      m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
    if (config.discordAllowedChannels)
      m.set(
        "bridge_discord_allowed_channels",
        config.discordAllowedChannels.join(","),
      );
    if (config.discordAllowedGuilds)
      m.set(
        "bridge_discord_allowed_guilds",
        config.discordAllowedGuilds.join(","),
      );
  }

  // ── Feishu ──
  if (!hasFeishuIm) {
    m.set(
      "bridge_feishu_enabled",
      enabledCh.includes("feishu") ? "true" : "false",
    );
    if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
    if (config.feishuAppSecret)
      m.set("bridge_feishu_app_secret", config.feishuAppSecret);
    if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
    if (config.feishuAllowedUsers)
      m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  }

  // ── QQ ──
  if (!hasQqIm) {
    m.set(
      "bridge_qq_enabled",
      enabledCh.includes("qq") ? "true" : "false",
    );
    if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
    if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
    if (config.qqAllowedUsers)
      m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
    if (config.qqImageEnabled !== undefined)
      m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
    if (config.qqMaxImageSize !== undefined)
      m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));
  }

  // ── Agent ──
  m.set(
    "bridge_agent_enabled",
    enabledCh.includes("agent") ? "true" : "false"
  );
  if (config.agentRedisUrl) m.set("bridge_agent_redis_url", config.agentRedisUrl);
  if (config.agentFirstPrompt) m.set("bridge_agent_first_prompt", config.agentFirstPrompt);
  if (config.agentOpenAIBaseUrl) m.set("bridge_agent_openai_base_url", config.agentOpenAIBaseUrl);
  if (config.agentOpenAIModel) m.set("bridge_agent_openai_model", config.agentOpenAIModel);
  if (config.agentOpenAIApiKey) m.set("bridge_agent_openai_api_key", config.agentOpenAIApiKey);
  if (config.agentMaxTurns !== undefined)
    m.set("bridge_agent_max_turns", String(config.agentMaxTurns));

  // Multi-instance agent configs are passed through from env directly
  // The adapter parses bridge_agent_1_*, bridge_agent_2_*, bridge_agent_name_*, etc.

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_model, default_model
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);
  if (config.defaultRunnerId) {
    m.set("bridge_default_runner_profile_id", config.defaultRunnerId);
  }

  return m;
}
