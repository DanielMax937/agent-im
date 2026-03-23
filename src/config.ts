import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { imScopedStoreKey, type ImBaseChannel } from "./lib/bridge/im-instance-settings";

/** Single selectable backend for bridge or platform (matches `CTI_RUNTIME` values). */
export type RuntimeKind = 'claude' | 'codex' | 'cursor' | 'auto';

/**
 * Named runtime profile — “多实例” here means multiple configured runtimes; pick one per bridge default or per task.
 */
export interface RuntimeProfile {
  id: string;
  runtime: RuntimeKind;
  label?: string;
}

export interface Config {
  runtime: RuntimeKind;
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // Agent
  agentRedisUrl?: string;
  agentFirstPrompt?: string;
  agentOpenAIBaseUrl?: string;
  agentOpenAIModel?: string;
  agentOpenAIApiKey?: string;
  agentMaxTurns?: number;
  // HTTP(S) proxy URL for outbound API calls (Telegram, Feishu, etc.)
  proxy?: string;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
  // Jira (platform agents; also exposed to process via config.env)
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  jiraPollIntervalMs?: number;
  jiraBotAccountId?: string;
  /** Base URL for approval links (e.g. http://127.0.0.1:3000) */
  webBaseUrl?: string;
  /**
   * Numbered Agent bridge instances (CTI_AGENT_1_*, …). Written to config.env;
   * use with `syncConfigFileToProcessEnv()` so the agent adapter sees them.
   */
  agentEnvSlots?: AgentEnvSlot[];
  /**
   * Multiple runtime profiles (JSON array in `CTI_RUNTIME_PROFILES`).
   * If empty, a single implicit profile `{ id: default, runtime: CTI_RUNTIME }` is used.
   */
  runtimeProfiles?: RuntimeProfile[];
  /** Which profile the IM bridge uses (`CTI_DEFAULT_RUNTIME_PROFILE`). Defaults to first profile. */
  defaultRuntimeProfileId?: string;
  /**
   * Multiple IM bots in one bridge (`CTI_IM_INSTANCES` JSON array).
   * When non-empty for a channel, that channel uses per-instance store keys instead of legacy single-token fields.
   */
  imInstances?: ImInstanceSpec[];
}

/** One IM connection (bot) inside the bridge; see docs/IM_BRIDGE_MULTI_INSTANCE.md */
export interface ImInstanceSpec {
  id: string;
  channel: ImInstanceChannel;
  enabled?: boolean;
  tgBotToken?: string;
  tgAllowedUsers?: string[];
  tgChatId?: string;
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
}

export type ImInstanceChannel = "telegram" | "discord" | "feishu" | "qq";

/** Redis + OpenAI profile for `CTI_AGENT_{slot}_*` multi-instance bridge configs. */
export interface AgentEnvSlot {
  slot: number;
  openaiApiKey?: string;
  redisUrl?: string;
  firstPrompt?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  maxTurns?: number;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

const IM_INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const IM_INSTANCE_CHANNELS: ImInstanceChannel[] = ["telegram", "discord", "feishu", "qq"];

function parseImInstances(raw: string | undefined): ImInstanceSpec[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return undefined;
    const byKey = new Map<string, ImInstanceSpec>();
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const id = o.id;
      const channel = o.channel;
      if (typeof id !== "string" || !IM_INSTANCE_ID_RE.test(id)) continue;
      if (
        typeof channel !== "string" ||
        !IM_INSTANCE_CHANNELS.includes(channel as ImInstanceChannel)
      ) {
        continue;
      }
      const ch = channel as ImInstanceChannel;
      const spec: ImInstanceSpec = {
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
      };
      byKey.set(`${ch}:${id}`, spec);
    }
    const out = Array.from(byKey.values());
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

function applyImInstancesToSettings(m: Map<string, string>, config: Config): void {
  const specs = config.imInstances ?? [];
  if (specs.length === 0) return;

  const by = new Map<ImInstanceChannel, ImInstanceSpec[]>();
  for (const s of specs) {
    const list = by.get(s.channel) ?? [];
    list.push(s);
    by.set(s.channel, list);
  }

  for (const [ch, list] of by) {
    const base = ch as ImBaseChannel;
    m.set(
      `bridge_${base}_instances`,
      list.map((x) => x.id).join(","),
    );
    const anyOn = list.some((x) => x.enabled !== false);
    m.set(`bridge_${base}_enabled`, anyOn ? "true" : "false");

    for (const spec of list) {
      const id = spec.id;
      const en = spec.enabled !== false;
      m.set(
        imScopedStoreKey(base, id, `bridge_${base}_enabled`),
        en ? "true" : "false",
      );

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
    }
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
 * Loads `~/.claude-to-im/config.env` entries into `process.env` so modules that
 * only read `process.env` (e.g. agent-adapter `CTI_AGENT_1_*`) see the file.
 */
export function syncConfigFileToProcessEnv(): void {
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const env = parseEnvFile(content);
    for (const [key, value] of env) {
      if (value !== undefined) process.env[key] = value;
    }
    try {
      process.env.CTI_RUNTIME = resolveEffectiveRuntime(loadConfig());
    } catch {
      /* ignore */
    }
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

function parseRuntimeProfiles(env: Map<string, string>): RuntimeProfile[] | undefined {
  const raw = env.get("CTI_RUNTIME_PROFILES");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out: RuntimeProfile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      const rt = (item as { runtime?: unknown }).runtime;
      if (typeof id !== "string" || typeof rt !== "string") continue;
      if (!["claude", "codex", "cursor", "auto"].includes(rt)) continue;
      const label = (item as { label?: unknown }).label;
      out.push({
        id,
        runtime: rt as RuntimeKind,
        label: typeof label === "string" ? label : undefined,
      });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Ensures at least one profile exists (derived from legacy `runtime` when unset). */
export function normalizeRuntimeProfiles(config: Config): RuntimeProfile[] {
  if (config.runtimeProfiles && config.runtimeProfiles.length > 0) {
    return config.runtimeProfiles;
  }
  return [{ id: "default", runtime: config.runtime, label: "Default" }];
}

/** Runtime used by the IM bridge (default profile, or first profile). */
export function resolveEffectiveRuntime(config: Config): RuntimeKind {
  const profiles = normalizeRuntimeProfiles(config);
  const id = config.defaultRuntimeProfileId ?? profiles[0]?.id;
  const p = profiles.find((x) => x.id === id) ?? profiles[0];
  return p?.runtime ?? config.runtime;
}

/** Effective runtime for a platform agent instance (profile overrides stored `runtime`). */
export function resolveRuntimeForPlatformInstance(
  config: Config,
  instance: { runtime: string; runtimeProfileId?: string },
): RuntimeKind {
  if (instance.runtimeProfileId) {
    const p = normalizeRuntimeProfiles(config).find((x) => x.id === instance.runtimeProfileId);
    if (p) return p.runtime;
  }
  const r = instance.runtime as RuntimeKind;
  return ["claude", "codex", "cursor", "auto"].includes(r) ? r : "claude";
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  const rawRuntime = env.get("CTI_RUNTIME") || "claude";
  const runtime = (["claude", "codex", "cursor", "auto"].includes(rawRuntime) ? rawRuntime : "claude") as Config["runtime"];

  const runtimeProfiles = parseRuntimeProfiles(env);
  const defaultRuntimeProfileId = env.get("CTI_DEFAULT_RUNTIME_PROFILE") || undefined;

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
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
    jiraBaseUrl: env.get("CTI_JIRA_BASE_URL") || undefined,
    jiraEmail: env.get("CTI_JIRA_EMAIL") || undefined,
    jiraApiToken: env.get("CTI_JIRA_API_TOKEN") || undefined,
    jiraPollIntervalMs: env.get("CTI_JIRA_POLL_INTERVAL_MS")
      ? Number(env.get("CTI_JIRA_POLL_INTERVAL_MS"))
      : undefined,
    jiraBotAccountId: env.get("CTI_JIRA_BOT_ACCOUNT_ID") || undefined,
    webBaseUrl: env.get("CTI_WEB_BASE_URL") || undefined,
    agentEnvSlots: parseAgentSlotsFromEnv(env),
    runtimeProfiles,
    defaultRuntimeProfileId,
    imInstances: parseImInstances(env.get("CTI_IM_INSTANCES")),
  };

  if (runtimeProfiles && runtimeProfiles.length > 0) {
    base.runtime = resolveEffectiveRuntime(base);
  }

  return base;
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  const profiles = normalizeRuntimeProfiles(config);
  out += formatEnvLine("CTI_RUNTIME_PROFILES", JSON.stringify(profiles));
  out += formatEnvLine("CTI_DEFAULT_RUNTIME_PROFILE", config.defaultRuntimeProfileId);
  out += formatEnvLine("CTI_RUNTIME", resolveEffectiveRuntime(config));
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_AUTO_APPROVE", config.autoApprove ? "true" : "");
  out += formatEnvLine("CTI_WEB_BASE_URL", config.webBaseUrl);
  out += formatEnvLine("CTI_JIRA_BASE_URL", config.jiraBaseUrl);
  out += formatEnvLine("CTI_JIRA_EMAIL", config.jiraEmail);
  out += formatEnvLine("CTI_JIRA_API_TOKEN", config.jiraApiToken);
  if (config.jiraPollIntervalMs !== undefined) {
    out += formatEnvLine("CTI_JIRA_POLL_INTERVAL_MS", String(config.jiraPollIntervalMs));
  }
  out += formatEnvLine("CTI_JIRA_BOT_ACCOUNT_ID", config.jiraBotAccountId);
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

  // Agent
  out += formatEnvLine("CTI_AGENT_REDIS_URL", config.agentRedisUrl);
  out += formatEnvLine("CTI_AGENT_FIRST_PROMPT", config.agentFirstPrompt);
  out += formatEnvLine("CTI_AGENT_OPENAI_BASE_URL", config.agentOpenAIBaseUrl);
  out += formatEnvLine("CTI_AGENT_OPENAI_MODEL", config.agentOpenAIModel);
  out += formatEnvLine("CTI_AGENT_OPENAI_API_KEY", config.agentOpenAIApiKey);
  if (config.agentMaxTurns !== undefined)
    out += formatEnvLine("CTI_AGENT_MAX_TURNS", String(config.agentMaxTurns));

  if (config.imInstances?.length) {
    out += formatEnvLine("CTI_IM_INSTANCES", JSON.stringify(config.imInstances));
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

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
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
  "jiraApiToken",
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
export function mergeConfigPatch(prev: Config, patch: Partial<Config>): Config {
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
  if (patch.imInstances !== undefined) {
    if (patch.imInstances.length === 0) {
      next.imInstances = undefined;
    } else {
      const prevSpecs = prev.imInstances ?? [];
      next.imInstances = patch.imInstances.map((spec) => {
        const prevSpec = prevSpecs.find((p) => p.id === spec.id && p.channel === spec.channel);
        return {
          ...spec,
          tgBotToken: mergeImSecret(spec.tgBotToken, prevSpec?.tgBotToken),
          discordBotToken: mergeImSecret(spec.discordBotToken, prevSpec?.discordBotToken),
          feishuAppSecret: mergeImSecret(spec.feishuAppSecret, prevSpec?.feishuAppSecret),
          qqAppSecret: mergeImSecret(spec.qqAppSecret, prevSpec?.qqAppSecret),
        };
      });
    }
  }
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
  if (clone.imInstances?.length) {
    clone.imInstances = clone.imInstances.map((spec) => ({
      ...spec,
      tgBotToken: spec.tgBotToken ? maskSecret(spec.tgBotToken) : undefined,
      discordBotToken: spec.discordBotToken ? maskSecret(spec.discordBotToken) : undefined,
      feishuAppSecret: spec.feishuAppSecret ? maskSecret(spec.feishuAppSecret) : undefined,
      qqAppSecret: spec.qqAppSecret ? maskSecret(spec.qqAppSecret) : undefined,
    }));
  }
  return { config: clone, secretFields };
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  const im = config.imInstances ?? [];
  const hasTelegramIm = im.some((i) => i.channel === "telegram");
  const hasDiscordIm = im.some((i) => i.channel === "discord");
  const hasFeishuIm = im.some((i) => i.channel === "feishu");
  const hasQqIm = im.some((i) => i.channel === "qq");

  if (im.length > 0) {
    applyImInstancesToSettings(m, config);
  }

  // ── Telegram (legacy single-token when no CTI_IM_INSTANCES for telegram) ──
  if (!hasTelegramIm) {
    m.set(
      "bridge_telegram_enabled",
      config.enabledChannels.includes("telegram") ? "true" : "false",
    );
    if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
    if (config.tgAllowedUsers)
      m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
    if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);
  }

  // ── Discord (legacy) ──
  if (!hasDiscordIm) {
    m.set(
      "bridge_discord_enabled",
      config.enabledChannels.includes("discord") ? "true" : "false",
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

  // ── Feishu (legacy) ──
  if (!hasFeishuIm) {
    m.set(
      "bridge_feishu_enabled",
      config.enabledChannels.includes("feishu") ? "true" : "false",
    );
    if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
    if (config.feishuAppSecret)
      m.set("bridge_feishu_app_secret", config.feishuAppSecret);
    if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
    if (config.feishuAllowedUsers)
      m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  }

  // ── QQ (legacy) ──
  if (!hasQqIm) {
    m.set(
      "bridge_qq_enabled",
      config.enabledChannels.includes("qq") ? "true" : "false",
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
  // For backward compatibility, set single instance settings
  // The adapter will parse all agent_* settings directly from store
  m.set(
    "bridge_agent_enabled",
    config.enabledChannels.includes("agent") ? "true" : "false"
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
  if (config.defaultRuntimeProfileId) {
    m.set("bridge_default_runner_profile_id", config.defaultRuntimeProfileId);
  }

  return m;
}
