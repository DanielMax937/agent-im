import type { TaskConversationEntry } from './types';

/**
 * Optional Telegram fan-out for Kanban / workflow comments.
 * Set `CTI_KANBAN_TELEGRAM_BOT_TOKEN` + `CTI_KANBAN_TELEGRAM_CHAT_ID` (or topic thread id as string).
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.warn(`[kanban-notify] Telegram send failed: ${res.status} ${t}`);
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
