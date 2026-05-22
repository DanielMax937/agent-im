/**
 * Telegram notifications for Research mode.
 *
 * Uses the same bot token / chat id as Auto-mode Telegram (`telegram_bot_token`,
 * `telegram_chat_id` on the IM bot config, typically `mybot`). Each agent reply
 * is mirrored to Telegram with `[researcher]` / `[reviewer]` prefixes (parallel
 * to Auto mode `[master]` / `[slave]`). Never throws — failures are logged.
 */

import type { Config } from '../../../config';
import {
  getCtiHomeForBridgeSlug,
  listBridgeSlugs,
  loadConfig,
  loadResearchBridgeConfig,
} from '../../../config';
import { callTelegramApi, escapeHtml } from '../adapters/telegram-utils';
import { getBridgeContext } from '../context';
import { imScopedGet, listInstanceIdsForChannel } from '../im-instance-settings';
import { isAutoModeIntentEnabled, isHybridAutoModeEnabled } from '../redis-local-transport';
import { getLogger } from '../../../logger';
import type { ResearchSessionState } from './session-store';

const TELEGRAM_TEXT_MAX = 3900;

/** Resolved Telegram destination (token + chat + trace metadata). */
export interface ResearchTelegramTarget {
  token: string;
  chatId: string;
  instanceId: string;
  /** Bridge slug whose `config.env` supplied credentials, when known. */
  bridgeSlug?: string;
}

/** Optional override from `POST /api/research` (`notifyTelegram`). */
export interface ResearchTelegramOverride {
  chatId?: string;
  instanceId?: string;
  bridgeSlug?: string;
}

export interface NotifyTelegramCompletionInput {
  target: ResearchTelegramTarget;
  state: ResearchSessionState;
  outcome: 'completed' | 'timeout' | 'aborted' | 'failed';
  reason: string;
  resultPath: string;
}

export interface NotifyTelegramAgentReplyInput {
  target: ResearchTelegramTarget;
  role: 'researcher' | 'reviewer';
  sessionId: string;
  turn: number;
  text: string;
  /** Short status line (e.g. `phase=plan`, `verdict=approve-plan`). */
  meta?: string;
}

function pickTelegramFromConfig(config: Config): { token: string; chatId: string; instanceId: string } | null {
  const im = config.imBot;
  if (im?.channel === 'telegram') {
    const token = im.tgBotToken?.trim() ?? '';
    const chatId = im.tgChatId?.trim() ?? '';
    if (token && chatId) {
      return { token, chatId, instanceId: im.id?.trim() || 'default' };
    }
  }
  if (
    !im &&
    config.enabledChannels.includes('telegram') &&
    config.tgBotToken?.trim() &&
    config.tgChatId?.trim()
  ) {
    return {
      token: config.tgBotToken.trim(),
      chatId: config.tgChatId.trim(),
      instanceId: 'default',
    };
  }
  return null;
}

function scoreTelegramBridge(slug: string, config: Config): number {
  const picked = pickTelegramFromConfig(config);
  if (!picked) return -1;
  const im = config.imBot;
  let score = 0;
  if (slug === 'mybot') score += 100;
  if (im?.autoMode) score += 50;
  if (im?.autoRedisUrl?.trim()) score += 40;
  if (slug === 'kanban') score += 10;
  return score;
}

function resolveFromBridgeConfigs(override?: ResearchTelegramOverride): ResearchTelegramTarget | null {
  const slugs = listBridgeSlugs();
  const prefer = override?.bridgeSlug?.trim();
  const ordered = prefer
    ? [prefer, ...slugs.filter((s) => s !== prefer)]
    : ['mybot', 'kanban', ...slugs.filter((s) => s !== 'mybot' && s !== 'kanban')];

  let best: { target: ResearchTelegramTarget; score: number } | null = null;
  for (const slug of ordered) {
    if (!slugs.includes(slug) && slug !== prefer) continue;
    let cfg: Config;
    try {
      cfg = loadConfig(getCtiHomeForBridgeSlug(slug));
    } catch {
      continue;
    }
    const picked = pickTelegramFromConfig(cfg);
    if (!picked) continue;
    const score = scoreTelegramBridge(slug, cfg);
    const target: ResearchTelegramTarget = { ...picked, bridgeSlug: slug };
    if (!best || score > best.score) best = { target, score };
  }
  return best?.target ?? null;
}

function resolveFromBridgeStore(hintInstanceId?: string): ResearchTelegramTarget | null {
  try {
    const { store } = getBridgeContext();
    const tryInstance = (instanceId: string, requireAuto: boolean): ResearchTelegramTarget | null => {
      if (requireAuto && !isAutoModeIntentEnabled(store, 'telegram', instanceId)) return null;
      const token = imScopedGet(store, 'telegram', instanceId, 'telegram_bot_token')?.trim() ?? '';
      const chatId = imScopedGet(store, 'telegram', instanceId, 'telegram_chat_id')?.trim() ?? '';
      if (!token || !chatId) return null;
      return { token, chatId, instanceId };
    };

    if (hintInstanceId?.trim()) {
      const direct = tryInstance(hintInstanceId.trim(), false);
      if (direct) return direct;
    }

    for (const instanceId of listInstanceIdsForChannel('telegram', store)) {
      if (!isHybridAutoModeEnabled(store, 'telegram', instanceId)) continue;
      const hit = tryInstance(instanceId, false);
      if (hit) return hit;
    }
    for (const instanceId of listInstanceIdsForChannel('telegram', store)) {
      if (!isAutoModeIntentEnabled(store, 'telegram', instanceId)) continue;
      const hit = tryInstance(instanceId, false);
      if (hit) return hit;
    }
    for (const instanceId of listInstanceIdsForChannel('telegram', store)) {
      const hit = tryInstance(instanceId, false);
      if (hit) return hit;
    }
  } catch {
    /* bridge context not initialized */
  }
  return null;
}

function resolveTokenFromEnv(): string | null {
  const token =
    process.env.CTI_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  return token || null;
}

/**
 * Resolve Telegram credentials from the dedicated Research bridge config.
 * This takes priority over all other sources when configured.
 */
function resolveFromResearchBridgeConfig(): ResearchTelegramTarget | null {
  const researchConfig = loadResearchBridgeConfig();
  if (!researchConfig?.research?.telegram) return null;

  const { botToken, chatId } = researchConfig.research.telegram;
  const trimmedToken = botToken?.trim();
  const trimmedChatId = chatId?.trim();

  if (!trimmedToken || !trimmedChatId) return null;

  return {
    token: trimmedToken,
    chatId: trimmedChatId,
    instanceId: 'research',
    bridgeSlug: 'research',
  };
}

/**
 * Resolve Telegram credentials for Research mode notifications.
 *
 * Priority:
 * 1. Dedicated Research bridge config (`Config.research.telegram`) - takes precedence
 * 2. Explicit `notifyTelegram.chatId` from POST body (+ optional `instanceId` / `bridgeSlug` for token lookup)
 * 3. Best matching bridge `config.env` (prefers `mybot`, then Auto-mode flags, then `kanban`)
 * 4. Bridge JsonFileStore (`telegram_bot_token` / `telegram_chat_id`, hybrid Auto first)
 * 5. `CTI_TELEGRAM_BOT_TOKEN` + `CTI_TG_CHAT_ID` env fallbacks
 */
export function resolveResearchTelegramTarget(
  override?: ResearchTelegramOverride,
): ResearchTelegramTarget | null {
  // Priority 1: Use dedicated Research bridge Telegram config
  const fromResearchBridge = resolveFromResearchBridgeConfig();
  if (fromResearchBridge) {
    // If POST body specifies a chatId, override only that
    if (override?.chatId?.trim()) {
      return { ...fromResearchBridge, chatId: override.chatId.trim() };
    }
    return fromResearchBridge;
  }

  const explicitChatId = override?.chatId?.trim();
  if (explicitChatId && override) {
    const fromBridge = resolveFromBridgeConfigs(override);
    if (fromBridge) return { ...fromBridge, chatId: explicitChatId };
    const fromStore = resolveFromBridgeStore(override.instanceId);
    if (fromStore) return { ...fromStore, chatId: explicitChatId };
    const token = resolveTokenFromEnv();
    if (token) {
      return {
        token,
        chatId: explicitChatId,
        instanceId: override.instanceId?.trim() || 'default',
        bridgeSlug: override.bridgeSlug,
      };
    }
    return null;
  }

  const fromBridge = resolveFromBridgeConfigs(override);
  if (fromBridge) return fromBridge;

  const fromStore = resolveFromBridgeStore(override?.instanceId);
  if (fromStore) return fromStore;

  const token = resolveTokenFromEnv();
  const chatId = process.env.CTI_TG_CHAT_ID?.trim() || '';
  if (token && chatId) {
    return {
      token,
      chatId,
      instanceId: override?.instanceId?.trim() || 'default',
    };
  }

  return null;
}

async function sendTelegramHtml(target: ResearchTelegramTarget, text: string): Promise<void> {
  const body = text.slice(0, TELEGRAM_TEXT_MAX);
  const result = await callTelegramApi(target.token, 'sendMessage', {
    chat_id: target.chatId,
    text: body,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  if (!result.ok) {
    getLogger().warn(
      {
        event: 'research_telegram_notify_http_error',
        status: result.httpStatus,
        error: result.error,
        chatId: target.chatId,
        bridgeSlug: target.bridgeSlug,
      },
      '[research-telegram-notify] sendMessage failed',
    );
  }
}

function roleLabel(role: NotifyTelegramAgentReplyInput['role']): string {
  return role === 'researcher' ? 'researcher' : 'reviewer';
}

/**
 * Mirror one agent reply to Telegram (Auto-mode style `[researcher]` / `[reviewer]` tags).
 */
export async function notifyTelegramAgentReply(input: NotifyTelegramAgentReplyInput): Promise<void> {
  const preview =
    input.text.length > 3400 ? `${input.text.slice(0, 3400)}…` : input.text;
  const metaLine = input.meta ? `\n<i>${escapeHtml(input.meta)}</i>` : '';
  const header = `<b>[${roleLabel(input.role)}]</b> turn ${input.turn} · <code>${escapeHtml(input.sessionId.slice(0, 8))}</code>${metaLine}`;
  const text = `${header}\n\n${escapeHtml(preview)}`;
  try {
    await sendTelegramHtml(input.target, text);
  } catch (err) {
    getLogger().warn(
      {
        event: 'research_telegram_agent_reply_exception',
        role: input.role,
        err: err instanceof Error ? err.message : err,
      },
      '[research-telegram-notify] agent reply notify failed',
    );
  }
}

function outcomeEmoji(outcome: NotifyTelegramCompletionInput['outcome']): string {
  switch (outcome) {
    case 'completed':
      return '✅';
    case 'timeout':
      return '⏱';
    case 'aborted':
      return '⛔';
    case 'failed':
      return '⚠️';
  }
}

/** Session-end summary (same channel as per-turn agent replies). */
export async function notifyTelegramCompletion(
  input: NotifyTelegramCompletionInput,
): Promise<void> {
  const lines = [
    `${outcomeEmoji(input.outcome)} <b>Research mode</b> — ${escapeHtml(input.outcome)}`,
    '',
    `<b>folder:</b> <code>${escapeHtml(input.state.folder)}</code>`,
    `<b>session:</b> <code>${escapeHtml(input.state.sessionId)}</code>`,
    `<b>turns:</b> ${input.state.turn} / ${input.state.maxTurns}`,
    `<b>reason:</b> ${escapeHtml(input.reason)}`,
    `<b>result:</b> <code>${escapeHtml(input.resultPath)}</code>`,
  ];
  if (input.state.lastVerdict?.verdict) {
    lines.push(`<b>final verdict:</b> ${escapeHtml(input.state.lastVerdict.verdict)}`);
  }

  try {
    await sendTelegramHtml(input.target, lines.join('\n'));
  } catch (err) {
    getLogger().warn(
      { event: 'research_telegram_notify_exception', err: err instanceof Error ? err.message : err },
      '[research-telegram-notify] completion notify failed',
    );
  }
}
