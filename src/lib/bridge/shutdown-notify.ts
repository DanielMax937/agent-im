/**
 * On graceful bridge shutdown, send a short HTTP notification to the configured IM
 * (Telegram / Discord) using the same outbound rules as the bot: optional HTTP proxy
 * from `imBot.proxy` (else `CTI_PROXY` / config.proxy).
 *
 * Feishu / QQ require SDK or reply context — skipped here (extend when a stable HTTP path exists).
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

import type { Config } from '../../config-shared';
import { getCtiBotDisplayName, loadConfig } from '../../config';

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

function pickTelegram(config: Config): { token: string; chatId: string } | null {
  const im = config.imBot;
  if (im?.channel === 'telegram') {
    const token = im.tgBotToken ?? '';
    const chatId = im.tgChatId ?? '';
    if (token && chatId) return { token, chatId };
    return null;
  }
  if (
    !im &&
    config.enabledChannels.includes('telegram') &&
    config.tgBotToken &&
    config.tgChatId
  ) {
    return { token: config.tgBotToken, chatId: config.tgChatId };
  }
  return null;
}

function pickDiscord(config: Config): { token: string; channelId: string } | null {
  const im = config.imBot;
  if (im?.channel === 'discord') {
    const token = im.discordBotToken ?? '';
    const channelId = im.discordAllowedChannels?.[0] ?? '';
    if (token && channelId) return { token, channelId };
    return null;
  }
  if (!im && config.enabledChannels.includes('discord') && config.discordBotToken) {
    const channelId = config.discordAllowedChannels?.[0];
    if (channelId) return { token: config.discordBotToken, channelId };
  }
  return null;
}

async function sendTelegramShutdown(
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
      `[claude-to-im] Shutdown Telegram notify failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
}

async function sendDiscordShutdown(
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
      `[claude-to-im] Shutdown Discord notify failed: HTTP ${res.status} ${body.slice(0, 200)}`,
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
      '[claude-to-im] Shutdown IM notify skipped (no Telegram tgChatId+token or Discord channel+token).',
    );
    return;
  }

  const tasks: Promise<void>[] = [];
  if (tg) {
    tasks.push(
      sendTelegramShutdown(tg.token, tg.chatId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Shutdown Telegram notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }
  if (dc) {
    tasks.push(
      sendDiscordShutdown(dc.token, dc.channelId, text, proxyUrl).catch((e) =>
        console.warn('[claude-to-im] Shutdown Discord notify error:', e instanceof Error ? e.message : e),
      ),
    );
  }

  await Promise.race([Promise.all(tasks), delay(NOTIFY_TIMEOUT_MS)]);
}
