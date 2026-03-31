import type { Dispatcher } from 'undici';
import { fetch, ProxyAgent } from 'undici';

import { getKanbanLogger } from './kanban-logger';
import type { TaskConversationEntry } from './types';

let memoProxyUrl: string | undefined;
let memoProxyAgent: ProxyAgent | undefined;

function kanbanTelegramDispatcher(): Dispatcher | undefined {
  const raw = process.env.CTI_KANBAN_TELEGRAM_PROXY?.trim();
  if (!raw) {
    memoProxyUrl = undefined;
    memoProxyAgent = undefined;
    return undefined;
  }
  if (memoProxyUrl !== raw) {
    memoProxyUrl = raw;
    memoProxyAgent = new ProxyAgent(raw);
  }
  return memoProxyAgent;
}

/**
 * Outbound Telegram only (`sendMessage`); no getUpdates / long polling.
 * Optional env: `CTI_KANBAN_TELEGRAM_BOT_TOKEN`, `CTI_KANBAN_TELEGRAM_CHAT_ID`,
 * optional `CTI_KANBAN_TELEGRAM_MESSAGE_THREAD_ID` (forum topic),
 * optional `CTI_KANBAN_TELEGRAM_PROXY` (HTTP(S) proxy for this send only; omit = direct).
 */
export async function notifyKanbanTelegram(message: string): Promise<void> {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, string | number | boolean> = {
    chat_id: chatId,
    text: message.slice(0, 4000),
    disable_web_page_preview: true,
  };
  const thread = process.env.CTI_KANBAN_TELEGRAM_MESSAGE_THREAD_ID?.trim();
  if (thread && /^\d+$/.test(thread)) {
    body.message_thread_id = Number(thread);
  }

  const dispatcher = kanbanTelegramDispatcher();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    const t = await res.text();
    getKanbanLogger().warn(
      { httpStatus: res.status, bodyPreview: t.slice(0, 800) },
      'Kanban Telegram sendMessage failed',
    );
  }
}

/**
 * Fan-out **every** persisted conversation line (workflow, compensation, agent user/assistant, etc.)
 * when Telegram env is configured. Set `CTI_KANBAN_TELEGRAM_SKIP_ASSISTANT=1` to omit assistant replies (noise).
 */
export function scheduleConversationEntryTelegram(
  issueId: string,
  entry: Pick<TaskConversationEntry, 'role' | 'source' | 'content'>,
): void {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;
  if (process.env.CTI_KANBAN_TELEGRAM_SKIP_ASSISTANT === '1' && entry.role === 'assistant') {
    return;
  }
  const prefix = `[Kanban][${issueId}] [${entry.source}/${entry.role}]`;
  void notifyKanbanTelegram(`${prefix} ${entry.content}`);
}
