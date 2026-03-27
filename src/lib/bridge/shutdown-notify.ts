/**
 * On bridge start / graceful shutdown, send a short HTTP notification to the configured IM
 * (Telegram / Discord) using the same outbound rules as the bot: optional HTTP proxy
 * from `imBot.proxy` (else `CTI_PROXY` / config.proxy).
 *
 * Feishu / QQ require SDK or reply context — skipped here (extend when a stable HTTP path exists).
 *
 * Disable: `CTI_STARTUP_NOTIFY_DISABLED=1` / `CTI_SHUTDOWN_NOTIFY_DISABLED=1`
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

import type { Config } from '../../config-shared';
import { getCtiBotDisplayName, loadConfig } from '../../config';
import { getBridgeContext } from './context';
import { imScopedGet, listInstanceIdsForChannel } from './im-instance-settings';

const NOTIFY_TIMEOUT_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveShutdownProxy(config: Config): string | undefined {
  const fromBot = config.imBot?.proxy?.trim();
  if (fromBot) return fromBot;
  return config.proxy?.trim() || undefined;
}

function buildShutdownText(reason: string): string {
  const bot = getCtiBotDisplayName();
  return `[claude-to-im] 桥接已关闭（${reason}）。当前桥接：${bot}`;
}

function buildStartupText(pid: number, channels: string[]): string {
  const bot = getCtiBotDisplayName();
  const ch = channels.length ? channels.join(', ') : '—';
  return `[claude-to-im] 桥接已启动（PID: ${pid}，频道: ${ch}）。当前桥接：${bot}`;
}

async function fetchWithOptionalProxy(
  url: string,
  init: Parameters<typeof undiciFetch>[1],
  proxyUrl: string | undefined,
) {
  if (proxyUrl) {
    return undiciFetch(url, {
      ...init,
      dispatcher: new ProxyAgent(proxyUrl),
    });
  }
  return undiciFetch(url, init);
}

/**
 * JsonFileStore often holds the live token/chat_id while config.env may be masked or stale.
 * Adapters read `imScopedGet` — match that so startup/shutdown notify actually sends.
 */
function tryPickTelegramFromStore(): { token: string; chatId: string } | null {
  try {
    const { store } = getBridgeContext();
    for (const instanceId of listInstanceIdsForChannel('telegram', store)) {
      const token =
        imScopedGet(store, 'telegram', instanceId, 'telegram_bot_token')?.trim() || '';
      const chatId =
        imScopedGet(store, 'telegram', instanceId, 'telegram_chat_id')?.trim() || '';
      if (token && chatId) return { token, chatId };
    }
  } catch {
    /* bridge context not initialized (e.g. tests) */
  }
  return null;
}

function tryPickDiscordFromStore(): { token: string; channelId: string } | null {
  try {
    const { store } = getBridgeContext();
    for (const instanceId of listInstanceIdsForChannel('discord', store)) {
      const token =
        imScopedGet(store, 'discord', instanceId, 'bridge_discord_bot_token')?.trim() || '';
      const raw =
        imScopedGet(store, 'discord', instanceId, 'bridge_discord_allowed_channels')?.trim() || '';
      const channelId = raw.split(',').map((s) => s.trim()).filter(Boolean)[0] || '';
      if (token && channelId) return { token, channelId };
    }
  } catch {
    /* bridge context not initialized */
  }
  return null;
}

function pickTelegram(config: Config): { token: string; chatId: string } | null {
  const im = config.imBot;
  if (im?.channel === 'telegram') {
    const token = im.tgBotToken ?? '';
    const chatId = im.tgChatId ?? '';
    if (token && chatId) return { token, chatId };
  } else if (
    !im &&
    config.enabledChannels.includes('telegram') &&
    config.tgBotToken &&
    config.tgChatId
  ) {
    return { token: config.tgBotToken, chatId: config.tgChatId };
  }
  return tryPickTelegramFromStore();
}

function pickDiscord(config: Config): { token: string; channelId: string } | null {
  const im = config.imBot;
  if (im?.channel === 'discord') {
    const token = im.discordBotToken ?? '';
    const channelId = im.discordAllowedChannels?.[0] ?? '';
    if (token && channelId) return { token, channelId };
  } else if (!im && config.enabledChannels.includes('discord') && config.discordBotToken) {
    const channelId = config.discordAllowedChannels?.[0];
    if (channelId) return { token: config.discordBotToken, channelId };
  }
  return tryPickDiscordFromStore();
}

async function sendTelegramNotify(
  token: string,
  chatId: string,
  text: string,
  proxyUrl: string | undefined,
): Promise<void> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
    proxyUrl,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(
      `[claude-to-im] Telegram IM notify failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
}

async function sendDiscordNotify(
  token: string,
  channelId: string,
  text: string,
  proxyUrl: string | undefined,
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: text }),
    },
    proxyUrl,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(
      `[claude-to-im] Discord IM notify failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
}

/**
 * Fire-and-forget friendly: catches errors, respects CTI_SHUTDOWN_NOTIFY_DISABLED=1.
 * Call before `bridgeManager.stop()` so outbound settings are still valid.
 */
export async function notifyBridgeClosing(reason: string): Promise<void> {
  if (process.env.CTI_SHUTDOWN_NOTIFY_DISABLED?.trim() === '1') {
    console.log('[claude-to-im] Shutdown IM notify skipped (CTI_SHUTDOWN_NOTIFY_DISABLED=1)');
    return;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    console.warn('[claude-to-im] Shutdown notify: loadConfig failed:', e instanceof Error ? e.message : e);
    return;
  }

  const proxyUrl = resolveShutdownProxy(config);
  const text = buildShutdownText(reason);

  const tg = pickTelegram(config);
  const dc = pickDiscord(config);

  if (!tg && !dc) {
    console.log(
      '[claude-to-im] Shutdown IM notify skipped (no Telegram/Discord credentials in config.env or store).',
    );
    return;
  }

  const tasks: Promise<void>[] = [];
  if (tg) {
    tasks.push(
      sendTelegramNotify(tg.token, tg.chatId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Shutdown Telegram notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }
  if (dc) {
    tasks.push(
      sendDiscordNotify(dc.token, dc.channelId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Shutdown Discord notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }

  await Promise.race([Promise.all(tasks), delay(NOTIFY_TIMEOUT_MS)]);
}

/**
 * After adapters successfully start — same destinations as shutdown notify.
 * Prefer credentials from {@link loadConfig} plus JsonFileStore (same as IM adapters).
 */
export async function notifyBridgeStarted(pid: number, channels: string[]): Promise<void> {
  if (process.env.CTI_STARTUP_NOTIFY_DISABLED?.trim() === '1') {
    console.log('[claude-to-im] Startup IM notify skipped (CTI_STARTUP_NOTIFY_DISABLED=1)');
    return;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    console.warn('[claude-to-im] Startup notify: loadConfig failed:', e instanceof Error ? e.message : e);
    return;
  }

  const proxyUrl = resolveShutdownProxy(config);
  const text = buildStartupText(pid, channels);

  const tg = pickTelegram(config);
  const dc = pickDiscord(config);

  if (!tg && !dc) {
    console.log(
      '[claude-to-im] Startup IM notify skipped (no Telegram/Discord credentials in config.env or store).',
    );
    return;
  }

  const tasks: Promise<void>[] = [];
  if (tg) {
    tasks.push(
      sendTelegramNotify(tg.token, tg.chatId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Startup Telegram notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }
  if (dc) {
    tasks.push(
      sendDiscordNotify(dc.token, dc.channelId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Startup Discord notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }

  await Promise.race([Promise.all(tasks), delay(NOTIFY_TIMEOUT_MS)]);
}
