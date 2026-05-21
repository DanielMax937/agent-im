/**
 * Optional Telegram completion notice for research mode.
 *
 * Looks up the configured Telegram bot token from the bridge store (same key
 * Auto-mode adapters use) and posts a single message summarising the outcome
 * of the research session. Never throws — failures are logged and swallowed.
 */

import { getBridgeContext } from '../context';
import { imScopedGet } from '../im-instance-settings';
import { getLogger } from '../../../logger';
import type { ResearchSessionState } from './session-store';

export interface NotifyTelegramCompletionInput {
  chatId: string;
  instanceId?: string;
  state: ResearchSessionState;
  outcome: 'completed' | 'timeout' | 'aborted' | 'failed';
  reason: string;
  resultPath: string;
}

function resolveTelegramBotToken(instanceId: string): string | null {
  const { store } = getBridgeContext();
  const fromStore = imScopedGet(store, 'telegram', instanceId, 'telegram_bot_token')?.trim();
  if (fromStore) return fromStore;
  // Env fallbacks mirror telegram-adapter for parity with other auto-mode tooling.
  const fromEnv =
    process.env.CTI_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    '';
  return fromEnv || null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

export async function notifyTelegramCompletion(
  input: NotifyTelegramCompletionInput,
): Promise<void> {
  const instanceId = input.instanceId ?? 'default';
  const token = resolveTelegramBotToken(instanceId);
  if (!token) {
    getLogger().info(
      { event: 'research_telegram_notify_skipped', reason: 'no-token' },
      '[research-telegram-notify] no telegram bot token configured; skipping notice',
    );
    return;
  }

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

  const text = lines.join('\n').slice(0, 3900);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      getLogger().warn(
        {
          event: 'research_telegram_notify_http_error',
          status: res.status,
          body: body.slice(0, 200),
        },
        '[research-telegram-notify] sendMessage non-2xx',
      );
    }
  } catch (err) {
    getLogger().warn(
      { event: 'research_telegram_notify_exception', err: err instanceof Error ? err.message : err },
      '[research-telegram-notify] sendMessage failed',
    );
  }
}
