/**
 * Client-safe config types + pure helpers (no `node:fs` / Node builtins).
 * Import from here in Client Components; server code may use `config.ts` which re-exports these.
 */

/** Single selectable backend for bridge or platform (matches `CTI_RUNTIME` values). */
export type RuntimeKind = "claude" | "codex" | "cursor" | "auto";

/**
 * One **runner** under a single bridge/bot: which CLI/backend handles turns for a chat or task.
 * Multiple runners may share the same `runtime` kind (e.g. two Claude profiles with different labels).
 * Stored in `$CTI_HOME/config.env` as `CTI_RUNNERS` JSON array, or on the single `imBot` in `CTI_IM_BOT`.
 */
export interface RunnerConfig {
  id: string;
  runtime: RuntimeKind;
  label?: string;
  /** Default model for chats using this runner when binding/session omit model. */
  defaultModel?: string;
  /** Suggested chat mode for new bindings: code | plan | ask */
  defaultMode?: "code" | "plan" | "ask";
  /** Override bridge-level CTI_AUTO_APPROVE for this runner. */
  autoApprove?: boolean;
  /** Claude Code CLI path (overrides CTI_CLAUDE_CODE_EXECUTABLE for this runner). */
  claudeExecutable?: string;
  /** When true, pass model into Claude SDK (same idea as setting CTI_DEFAULT_MODEL globally). */
  passModelToCli?: boolean;
  /** Codex: use `codex login` token instead of API keys. */
  codexUseLogin?: boolean;
  /** Codex: pass model into thread options. */
  codexPassModel?: boolean;
  /** Codex wrapper path (overrides CTI_CODEX_EXECUTABLE for this runner). */
  codexExecutable?: string;
  /** Cursor `agent` binary path. */
  cursorExecutable?: string;
  /** Cursor default model when binding has none (overrides CTI_CURSOR_MODEL for this runner). */
  cursorDefaultModel?: string;
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
   * Bridge-level runner list (`CTI_RUNNERS`). Used when **no** `imBot`, or as fallback
   * when `imBot.runners` is empty, and for platform/Jira.
   */
  runners?: RunnerConfig[];
  /** Default runner id for legacy flat config / platform (`CTI_DEFAULT_RUNNER`). */
  defaultRunnerId?: string;
  /**
   * Single IM bot for this bridge (one process = one bot). Serialized as `CTI_IM_BOT` JSON.
   * Legacy `CTI_IM_INSTANCES` array loads **first element only** for migration.
   */
  imBot?: ImInstanceSpec;
}

/** One IM connection (bot) inside the bridge; see docs/IM_BRIDGE_MULTI_INSTANCE.md */
export interface ImInstanceSpec {
  id: string;
  channel: ImInstanceChannel;
  enabled?: boolean;
  /**
   * Runners **for this bot only** (duplicated per bot is intentional: isolates CLI sessions and options).
   * If omitted on load, it is filled from bridge-level `CTI_RUNNERS` / implicit default.
   */
  runners?: RunnerConfig[];
  /** Default runner id for new chats on this bot (`/runner default`). */
  defaultRunnerId?: string;
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
  /**
   * When true, this bot does not use the platform API for I/O; Runner ↔ Redis only
   * (`cti:localagent:{channel}:{id}:*`). Optional peer id routes Claude replies to another bot's input.
   */
  localAgentEnabled?: boolean;
  localAgentRedisUrl?: string;
  localAgentFirstPrompt?: string;
  localAgentMaxTurns?: number;
  /** Same `channel` only: forward Claude text to this instance id's Redis `input` (multi-agent dialogue). */
  localAgentPeerInstanceId?: string;
  /** Bridge: default workdir (`CTI_DEFAULT_WORKDIR`) when this bot is the only IM source. */
  defaultWorkDir?: string;
  /** Bridge: HTTP proxy (`CTI_PROXY`). */
  proxy?: string;
  /** Bridge: approval links base (`CTI_WEB_BASE_URL`). */
  webBaseUrl?: string;
  /** Bridge: default auto-approve tools (`CTI_AUTO_APPROVE`) when set on bot. */
  autoApprove?: boolean;
  /** Bridge: default model (`CTI_DEFAULT_MODEL`). */
  defaultModel?: string;
  /** Bridge: default mode (`CTI_DEFAULT_MODE`). */
  defaultMode?: string;
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

/** Ensures at least one runner exists (derived from `runtime` when `runners` is unset). */
export function normalizeRunners(config: Config): RunnerConfig[] {
  if (config.imBot?.runners && config.imBot.runners.length > 0) {
    return config.imBot.runners;
  }
  if (config.runners && config.runners.length > 0) {
    return config.runners;
  }
  return [{ id: "default", runtime: config.runtime, label: "Default" }];
}
