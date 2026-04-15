import type { Dispatcher } from 'undici';
import { fetch, ProxyAgent } from 'undici';

import { callTelegramApi, escapeHtml } from '../lib/bridge/adapters/telegram-utils';
import { getKanbanLogger } from './kanban-logger';
import type { TaskConversationEntry } from './types';

/** Prefix for inline keyboard callback_data (must stay ≤64 bytes with approval id). */
export const KANBAN_PERM_CALLBACK_PREFIX = 'kperm:';

export function parseKanbanPermCallbackData(data: string): { behavior: 'allow' | 'deny'; approvalId: string } | null {
  const m = /^kperm:(allow|deny):(.+)$/.exec(data.trim());
  if (!m) return null;
  return { behavior: m[1] as 'allow' | 'deny', approvalId: m[2] };
}

/**
 * When `true`, tool approvals use HTML + inline buttons (requires HTTPS webhook → `/api/telegram/kanban-webhook`).
 * Default **off** — plain text + POST URL only (no callback handling needed).
 */
export function isKanbanTelegramApprovalButtonsEnabled(): boolean {
  const v = process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS?.trim();
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/** Format tool input for Telegram HTML (never [object Object]). */
export function formatKanbanToolInputForTelegram(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return '';
  if (typeof toolInput === 'string') return toolInput;
  try {
    const s = JSON.stringify(toolInput, null, 2);
    return s.length > 1200 ? `${s.slice(0, 1200)}…` : s;
  } catch {
    return String(toolInput);
  }
}

function buildKanbanPermCallbackData(action: 'allow' | 'deny', approvalId: string): string {
  const data = `${KANBAN_PERM_CALLBACK_PREFIX}${action}:${approvalId}`;
  if (data.length > 64) {
    getKanbanLogger().warn(
      { len: data.length, approvalIdPrefix: approvalId.slice(0, 16) },
      'Kanban Telegram callback_data exceeds 64 bytes; button may fail',
    );
  }
  return data;
}

let memoProxyUrl: string | undefined;
let memoProxyAgent: ProxyAgent | undefined;

/** Collapse consecutive newlines so Telegram messages stay readable. */
export function normalizeTelegramOutboundText(text: string): string {
  return text.replace(/\n{2,}/g, '\n');
}

/** Matches the opening line of `src/prompts/kanban/system-check.md` (after trim). */
const KANBAN_SYSTEM_CHECK_CONTENT_PREFIX = '[Kanban system check';

/**
 * Omit Telegram fan-out for automated system-check user prompts (see `system-check.md`).
 * Those lines use `source: workflow` + `role: user` and are noisy in chat; other `workflow/user`
 * lines (e.g. kickoff directives) still send.
 */
export function shouldSkipKanbanTelegramConversationEntry(
  entry: Pick<TaskConversationEntry, 'role' | 'source' | 'content'>,
): boolean {
  if (entry.source !== 'workflow' || entry.role !== 'user') return false;
  return entry.content.trimStart().startsWith(KANBAN_SYSTEM_CHECK_CONTENT_PREFIX);
}

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

/** Minimum delay between consecutive Kanban `sendMessage` calls (global queue). */
export const KANBAN_TELEGRAM_MIN_SEND_INTERVAL_MS = 5000;

const telegramSendQueue: Array<() => Promise<void>> = [];
let telegramSendDraining = false;

/**
 * Serializes all outbound Kanban Telegram `sendMessage` traffic: at most one message every
 * {@link KANBAN_TELEGRAM_MIN_SEND_INTERVAL_MS} ms (gap applies between sends, not after the last).
 */
function enqueueKanbanTelegramSend(job: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    telegramSendQueue.push(async () => {
      try {
        await job();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    void drainKanbanTelegramSendQueue();
  });
}

async function drainKanbanTelegramSendQueue(): Promise<void> {
  if (telegramSendDraining) return;
  telegramSendDraining = true;
  try {
    while (telegramSendQueue.length > 0) {
      const job = telegramSendQueue.shift()!;
      await job();
      if (telegramSendQueue.length > 0) {
        await new Promise((r) => setTimeout(r, KANBAN_TELEGRAM_MIN_SEND_INTERVAL_MS));
      }
    }
  } finally {
    telegramSendDraining = false;
    if (telegramSendQueue.length > 0) {
      void drainKanbanTelegramSendQueue();
    }
  }
}

/**
 * Outbound Telegram only (`sendMessage`); no getUpdates / long polling.
 * Optional env: `CTI_KANBAN_TELEGRAM_BOT_TOKEN`, `CTI_KANBAN_TELEGRAM_CHAT_ID`,
 * optional `CTI_KANBAN_TELEGRAM_MESSAGE_THREAD_ID` (forum topic),
 * optional `CTI_KANBAN_TELEGRAM_PROXY` (HTTP(S) proxy for this send only; omit = direct).
 * Sends are rate-limited globally (see {@link KANBAN_TELEGRAM_MIN_SEND_INTERVAL_MS}).
 */
export async function notifyKanbanTelegram(message: string): Promise<void> {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  return enqueueKanbanTelegramSend(async () => {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: normalizeTelegramOutboundText(message).slice(0, 4000),
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
    } catch (error) {
      getKanbanLogger().warn(
        { err: error, messagePreview: message.slice(0, 240) },
        'Kanban Telegram sendMessage threw; continuing without blocking workflow',
      );
    }
  });
}

/**
 * Tool permission notice: plain text by default; HTML + inline buttons when
 * `CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS=1` (requires public HTTPS webhook).
 */
export async function notifyKanbanTelegramToolApproval(params: {
  issueId: string;
  permissionRequestId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<void> {
  const { issueId, permissionRequestId, toolName, toolInput } = params;

  if (!isKanbanTelegramApprovalButtonsEnabled()) {
    const inputStr = formatKanbanToolInputForTelegram(toolInput);
    const lines = [
      `Approval required for ${toolName}.`,
      `Approval ID: ${permissionRequestId}`,
      ...(inputStr ? [`Tool input:\n${inputStr}`] : []),
      `Approve via POST /api/approvals/${permissionRequestId}`,
    ];
    await notifyKanbanTelegram(`[Kanban][${issueId}] ${lines.join('\n')}`);
    return;
  }

  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  const inputBlock = formatKanbanToolInputForTelegram(toolInput);
  const pre = inputBlock
    ? `<pre>${escapeHtml(inputBlock)}</pre>`
    : '<i>(no input)</i>';

  const text = [
    `<b>[Kanban][${escapeHtml(issueId)}] 需要工具授权</b>`,
    '',
    `工具: <code>${escapeHtml(toolName)}</code>`,
    `ID: <code>${escapeHtml(permissionRequestId)}</code>`,
    '',
    pre,
    '',
    '点击下方按钮同意或拒绝（也可 POST /api/approvals/&lt;id&gt;）。',
  ].join('\n');

  const thread = process.env.CTI_KANBAN_TELEGRAM_MESSAGE_THREAD_ID?.trim();
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 同意', callback_data: buildKanbanPermCallbackData('allow', permissionRequestId) },
          { text: '❌ 拒绝', callback_data: buildKanbanPermCallbackData('deny', permissionRequestId) },
        ],
      ],
    },
  };
  if (thread && /^\d+$/.test(thread)) {
    payload.message_thread_id = Number(thread);
  }

  return enqueueKanbanTelegramSend(async () => {
    try {
      const dispatcher = kanbanTelegramDispatcher();
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!res.ok) {
        const t = await res.text();
        getKanbanLogger().warn(
          { httpStatus: res.status, bodyPreview: t.slice(0, 800) },
          'Kanban Telegram tool approval sendMessage failed',
        );
      }
    } catch (error) {
      getKanbanLogger().warn(
        { err: error, issueId, permissionRequestId },
        'Kanban Telegram tool approval sendMessage threw; continuing without blocking workflow',
      );
    }
  });
}

/** Ack a callback query so Telegram removes the loading spinner. */
export async function answerKanbanTelegramCallbackQuery(
  callbackQueryId: string,
  opts: { text?: string; showAlert?: boolean },
): Promise<void> {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  await callTelegramApi(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(opts.text ? { text: opts.text.slice(0, 200) } : {}),
    ...(opts.showAlert ? { show_alert: true } : {}),
  });
}

/**
 * Fan-out **every** persisted conversation line (workflow, compensation, agent user/assistant, etc.)
 * when Telegram env is configured. Set `CTI_KANBAN_TELEGRAM_SKIP_ASSISTANT=1` to omit assistant replies (noise).
 * Automated system-check prompts (`[Kanban system check…]`, tagged `workflow`/`user`) are not sent to Telegram.
 */
export function scheduleConversationEntryTelegram(
  issueId: string,
  entry: Pick<TaskConversationEntry, 'role' | 'source' | 'content'>,
): void {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;
  if (shouldSkipKanbanTelegramConversationEntry(entry)) {
    return;
  }
  if (process.env.CTI_KANBAN_TELEGRAM_SKIP_ASSISTANT === '1' && entry.role === 'assistant') {
    return;
  }
  const prefix = `[Kanban][${issueId}] [${entry.source}/${entry.role}]`;
  void notifyKanbanTelegram(`${prefix} ${entry.content}`);
}
