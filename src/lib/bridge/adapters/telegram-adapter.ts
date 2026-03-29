/**
 * Telegram Adapter — implements BaseChannelAdapter for Telegram Bot API.
 *
 * Uses long polling to consume updates, persists offset watermark to DB,
 * and routes messages/callbacks through an internal async queue.
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types';
import type { FileAttachment } from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getBridgeContext } from '../context';
import { imScopedGet, resolveAutoSlaveRunnerId } from '../im-instance-settings';
import * as router from '../channel-router';
import {
  loadConfig,
  normalizeRunnersForChannelType,
  resolveAutoRedisBridgeSlug,
} from '../../../config';
import {
  isAutoModeIntentEnabled,
  readAutoModeSettings,
  AutoModeRedisTransport,
  runAutoModeMasterRedisInboundLoop,
  runAutoModeRedisInboundLoop,
} from '../redis-local-transport';
import { callTelegramApi, escapeHtml, sendMessageDraft } from './telegram-utils';
import { startSlaveProcess, stopSlaveProcess } from '../slave-process';
import {
  isImageEnabled,
  downloadPhoto,
  downloadDocumentImage,
  isSupportedImageMime,
  inferMimeType,
} from './telegram-media';
import type { TelegramPhotoSize, TelegramDocument, MediaDownloadResult } from './telegram-media';

const TELEGRAM_API = 'https://api.telegram.org';

/** Max number of recent update_ids to keep for idempotency dedup on restart. */
const DEDUP_SET_MAX = 1000;

/** Derive a short token-specific hash for per-bot offset isolation. */
function tokenShortHash(botToken: string): string {
  return crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 8);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; first_name?: string; title?: string; username?: string };
    from?: { id: number; first_name: string; username?: string };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    media_group_id?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

/** Media group debounce buffer entry for album messages. */
interface MediaGroupBufferEntry {
  updates: TelegramUpdate[];
  updateIds: number[];
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
  userId: string;
  displayName: string;
}

/** Debounce window for media group messages (ms). */
const MEDIA_GROUP_DEBOUNCE_MS = 500;

export class TelegramAdapter extends BaseChannelAdapter {
  private running = false;
  private abortController: AbortController | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private mediaGroupBuffers = new Map<string, MediaGroupBufferEntry>();
  /** Chat IDs where sendMessageDraft has permanently failed (method not found / 400 / 404). */
  private previewDegraded = new Set<string>();

  /** Committed offset — the highest update_id that has been safely enqueued or skipped. */
  private committedOffset = 0;
  /** In-memory set of recently processed update_ids for idempotency on restart. */
  private recentUpdateIds = new Set<number>();
  /** Stable bot user ID from Telegram's getMe, used for offset key identity. */
  private botUserId: string | null = null;

  /** Redis-only mode: no Telegram API; Runner ↔ Redis (see ImInstanceSpec auto fields). */
  private autoModeRedis: AutoModeRedisTransport | null = null;
  /** Telegram + Redis hybrid: IM user text is forwarded to Redis master `input`, then processed by the master loop. */
  private hybridAutoMode = false;
  /** Last Telegram chat id for mirroring Redis LA replies to the same conversation. */
  private hybridMirrorChatId: string | null = null;

  constructor(instanceId = 'default') {
    super('telegram', instanceId);
  }

  private imGet(key: string): string | null {
    return imScopedGet(getBridgeContext().store, 'telegram', this.instanceId, key);
  }

  get botToken(): string {
    return this.imGet('telegram_bot_token') || '';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const store = getBridgeContext().store;
    const la = readAutoModeSettings(store, 'telegram', this.instanceId);
    const isSlaveBridge = process.env.CTI_SLAVE_BRIDGE === '1';
    const token = isSlaveBridge ? '' : this.botToken;
    const defaultRunner = getBridgeContext().getDefaultRunnerIdForChannelType?.(this.channelType);
    const cfg = loadConfig();
    const masterIds = normalizeRunnersForChannelType(cfg, this.channelType).map((r) => r.id);
    const masterRunnerIds = masterIds.length > 0 ? masterIds : ['default'];
    const slaveRunnerId = resolveAutoSlaveRunnerId(
      store,
      this.channelType,
      defaultRunner,
      cfg.imBot?.autoSlaveRunner?.id,
    );
    const bridgeSlug = resolveAutoRedisBridgeSlug(cfg);

    if (la && token) {
      const configError = this.validateConfig();
      if (configError) {
        console.warn('[telegram-adapter] Cannot start (hybrid auto mode):', configError);
        return;
      }
      this.hybridAutoMode = true;
      this.autoModeRedis = new AutoModeRedisTransport(
        this.channelType,
        { ...la, hybridMode: true },
        bridgeSlug,
        masterRunnerIds,
        slaveRunnerId,
        () => this.hybridMirrorChatId || this.imGet('telegram_chat_id') || null,
      );
      try {
        await this.autoModeRedis.connect();
        await this.autoModeRedis.seedFirstPromptIfNeeded();
      } catch (err) {
        console.error('[telegram-adapter] Auto mode Redis connect failed:', err);
        this.autoModeRedis = null;
        this.hybridAutoMode = false;
        return;
      }
      await this.resolveBotIdentity();
      this.running = true;
      this.abortController = new AbortController();
      this.registerCommands().catch(() => {});
      this.pollLoop().catch((err) => {
        console.error('[telegram-adapter] Poll loop error:', err);
      });
      if (!cfg.imBot?.autoSlaveExternal) {
        console.log(
          `[telegram-adapter] Slave Redis consumer disabled — slave runs as a separate bridge (config.slave.env)`,
        );
      }
      this.autoModeMasterRedisPollLoop().catch((err) => {
        console.error('[telegram-adapter] Master Redis poll loop error:', err);
      });
      // Auto-start the slave bridge child process
      try {
        startSlaveProcess(this.instanceId);
      } catch (err) {
        console.warn('[telegram-adapter] Failed to start slave process:', err);
      }
      console.log(
        `[telegram-adapter] Hybrid Auto mode (Telegram + Redis), instance=${this.instanceId}`,
      );
      return;
    }

    if (la) {
      const configError = this.validateConfig();
      if (configError) {
        console.warn('[telegram-adapter] Cannot start (auto mode redis-only):', configError);
        return;
      }
      this.autoModeRedis = new AutoModeRedisTransport(
        this.channelType,
        la,
        bridgeSlug,
        masterRunnerIds,
        slaveRunnerId,
      );
      try {
        await this.autoModeRedis.connect();
        await this.autoModeRedis.seedFirstPromptIfNeeded();
      } catch (err) {
        console.error('[telegram-adapter] Auto mode Redis connect failed:', err);
        this.autoModeRedis = null;
        return;
      }
      this.running = true;
      this.abortController = new AbortController();
      this.autoModeRedisPollLoop().catch((err) => {
        console.error('[telegram-adapter] Redis poll loop error:', err);
      });
      console.log(`[telegram-adapter] Auto mode (Redis-only), instance=${this.instanceId}`);
      return;
    }

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[telegram-adapter] Cannot start:', configError);
      return;
    }

    // Resolve bot identity via getMe before starting the poll loop.
    // This provides a stable offset key that survives token rotation.
    await this.resolveBotIdentity();

    this.running = true;
    this.abortController = new AbortController();

    // Register bot commands menu with Telegram
    this.registerCommands().catch(() => {});

    // Start polling in background (no await — runs until stop())
    this.pollLoop().catch(err => {
      console.error('[telegram-adapter] Poll loop error:', err);
    });

    console.log('[telegram-adapter] Started (botUserId:', this.botUserId || 'fallback-to-hash', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    // Always stop slave process if one was started for this instance
    await stopSlaveProcess(this.instanceId).catch((err) => {
      console.warn('[telegram-adapter] Error stopping slave process:', err);
    });

    if (this.autoModeRedis) {
      await this.autoModeRedis.disconnect();
      this.autoModeRedis = null;
    }
    this.hybridAutoMode = false;
    this.hybridMirrorChatId = null;

    // Persist committed offset before shutdown
    this.persistCommittedOffset();

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Stop all typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear media group debounce timers
    for (const [, entry] of this.mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    this.mediaGroupBuffers.clear();

    // Reset preview degradation state
    this.previewDegraded.clear();

    console.log('[telegram-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    // If there's a queued message, return it immediately
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    // If not running, return null
    if (!this.running) return Promise.resolve(null);

    // Otherwise, wait for the poll loop to enqueue a message
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.autoModeRedis && !this.hybridAutoMode) {
      const r = await this.autoModeRedis.deliverClaudeReply(message.text);
      // Mirror slave response to Telegram (text already has [slave] prefix from bridge-manager)
      const realChatId = message.address.chatId.startsWith('auto:')
        ? (this.hybridMirrorChatId ?? this.imGet('telegram_chat_id'))
        : message.address.chatId;
      const token = this.imGet('telegram_bot_token');
      if (realChatId && token) {
        await callTelegramApi(token, 'sendMessage', {
          chat_id: realChatId,
          text: message.text,
          disable_web_page_preview: true,
        }).catch(() => {});
      }
      return r.ok ? { ok: true, messageId: crypto.randomUUID() } : { ok: false, error: r.error };
    }

    const token = this.botToken;
    if (!token) return { ok: false, error: 'No bot token configured' };

    const params: Record<string, unknown> = {
      chat_id: message.address.chatId,
      text: message.text,
      disable_web_page_preview: true,
    };

    if (message.parseMode === 'HTML') {
      params.parse_mode = 'HTML';
    } else if (message.parseMode === 'Markdown') {
      params.parse_mode = 'Markdown';
    }

    if (message.replyToMessageId) {
      params.reply_to_message_id = message.replyToMessageId;
    }

    // Inline keyboard buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      params.reply_markup = {
        inline_keyboard: message.inlineButtons.map(row =>
          row.map(btn => ({
            text: btn.text,
            callback_data: btn.callbackData,
          }))
        ),
      };
    }

    return callTelegramApi(token, 'sendMessage', params);
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (this.autoModeRedis && !this.hybridAutoMode) return;
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || 'OK',
    });
  }

  validateConfig(): string | null {
    const store = getBridgeContext().store;
    if (isAutoModeIntentEnabled(store, 'telegram', this.instanceId)) {
      if (!readAutoModeSettings(store, 'telegram', this.instanceId)) {
        return 'auto mode enabled but bridge_telegram_auto_redis_url is required';
      }
      const bridgeEnabled = this.imGet('bridge_telegram_enabled');
      if (bridgeEnabled !== 'true') return 'bridge_telegram_enabled is not true';
      return null;
    }

    const token = this.imGet('telegram_bot_token');
    if (!token) return 'telegram_bot_token not configured';

    const bridgeEnabled = this.imGet('bridge_telegram_enabled');
    if (bridgeEnabled !== 'true') return 'bridge_telegram_enabled is not true';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (this.autoModeRedis && !this.hybridAutoMode) return true;
    // Check bridge-specific allowed users first
    const allowedUsers = this.imGet('telegram_bridge_allowed_users') || '';
    if (allowedUsers) {
      const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        return allowed.includes(userId) || allowed.includes(chatId);
      }
    }

    // Fallback: check notification bot's chat_id
    const notifyChatId = this.imGet('telegram_chat_id') || '';
    if (notifyChatId) {
      return chatId === notifyChatId;
    }

    // No auth configured — deny by default
    return false;
  }

  /**
   * Start a typing indicator that fires every 5 seconds.
   */
  startTyping(chatId: string): void {
    if (this.autoModeRedis && !this.hybridAutoMode) return;
    this.stopTyping(chatId); // Clear any existing
    const token = this.botToken;
    if (!token) return;

    // Send immediately
    callTelegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // Repeat every 5s
    const interval = setInterval(() => {
      callTelegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    }, 5000);
    this.typingIntervals.set(chatId, interval);
  }

  /**
   * Stop the typing indicator for a chat.
   */
  stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  /**
   * Acknowledge that an update has been fully processed by the bridge-manager.
   * Only at this point do we advance the committed offset and persist it.
   * This ensures no message is lost if the process crashes between enqueue and processing.
   */
  acknowledgeUpdate(updateId: number): void {
    this.markUpdateProcessed(updateId);
    this.persistCommittedOffset();
  }

  // ── Streaming preview ────────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    const la = readAutoModeSettings(getBridgeContext().store, 'telegram', this.instanceId);
    // Disable streaming in any auto mode (hybrid or redis-only)
    if (la) return null;
    // Global kill switch
    if (this.imGet('bridge_telegram_stream_enabled') === 'false') return null;

    // Private-only check: positive chatId = private, negative = group/channel
    const privateOnly = this.imGet('bridge_telegram_stream_private_only') !== 'false';
    if (privateOnly && parseInt(chatId, 10) < 0) return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly };
  }

  async sendPreview(chatId: string, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (this.autoModeRedis) return 'skip';
    const token = this.botToken;
    if (!token) return 'skip';

    const result = await sendMessageDraft(token, chatId, text, draftId);
    if (result.ok) return 'sent';

    // Classify failure
    const status = result.httpStatus;
    if (status === 400 || status === 404) {
      // Method not found or bad request — permanent degradation
      this.previewDegraded.add(chatId);
      return 'degrade';
    }
    // 429 (rate limit) or transient — skip this update but don't degrade
    return 'skip';
  }

  endPreview(_chatId: string, _draftId: number): void {
    // No-op: the final sendMessage naturally replaces the draft
  }

  async hybridDuplicateAssistantToRedis(
    text: string,
    deliverySource: 'runner' | 'slave',
  ): Promise<void> {
    if (!this.hybridAutoMode || !this.autoModeRedis) return;
    if (deliverySource !== 'slave') return;
    const prefix = '[slave]\n\n';
    const body = text.startsWith(prefix) ? text.slice(prefix.length) : text;
    await this.autoModeRedis.deliverClaudeReply(body).catch(() => {});

    // Feed slave's result back to master for evaluation
    const slaveReport =
      `## Slave Execution Report\n\n` +
      `The slave runner has completed its task. Below is the slave's response:\n\n` +
      `---\n${body.slice(0, 2000)}\n---\n\n` +
      `### Your Role (Master Coordinator)\n` +
      `You are the master coordinator. Evaluate the slave's work above and decide:\n\n` +
      `1. **Quality check**: Did the slave complete the task correctly and thoroughly?\n` +
      `2. **Completeness**: Is anything missing or incomplete?\n` +
      `3. **Next action**: Choose ONE:\n` +
      `   - If the result is satisfactory, summarize the outcome for the user in a clear, friendly message.\n` +
      `   - If the result needs improvement, provide specific follow-up instructions (these will be sent to the slave as a new task).\n` +
      `   - If there was an error, diagnose it and provide corrective instructions.\n\n` +
      `Reply with your evaluation and decision. Keep it concise — your response will be shown to the user via Telegram.`;
    const chatId = this.hybridMirrorChatId || this.imGet('telegram_chat_id') || undefined;
    await this.autoModeRedis.pushMasterInput(slaveReport, 'default', chatId).catch(() => {});
  }

  override async hybridDuplicateMasterAssistantToRedis(
    text: string,
    masterRunnerId: string,
  ): Promise<void> {
    if (!this.hybridAutoMode || !this.autoModeRedis) return;
    let body = text;
    if (body.startsWith('[master]\n\n')) body = body.slice('[master]\n\n'.length);
    await this.autoModeRedis.duplicateMasterOut(body, masterRunnerId).catch(() => {});
  }

  override async afterAutoModeMasterTurn(payload: {
    userPrompt: string;
    responseText: string;
    outboundChatId?: string;
  }): Promise<void> {
    if (!this.autoModeRedis) return;

    const isSlaveReport = payload.userPrompt.startsWith('## Slave Execution Report');

    // Build a rolling summary to prevent handoff context bloat
    const prevSummary = await this.autoModeRedis.getSessionSummary().catch(() => null);
    const label = isSlaveReport ? 'SlaveReport→Master' : 'User→Master';
    const newSummary = prevSummary
      ? `${prevSummary}\n---\n${label}: ${payload.userPrompt.slice(0, 300)}\nMaster: ${payload.responseText.slice(0, 300)}`
      : `${label}: ${payload.userPrompt.slice(0, 300)}\nMaster: ${payload.responseText.slice(0, 300)}`;
    const trimmed = newSummary.length > 2000
      ? '...' + newSummary.slice(newSummary.length - 1997)
      : newSummary;
    await this.autoModeRedis.setSessionSummary(trimmed).catch(() => {});

    // If this was a slave report evaluation, only hand off again if master
    // explicitly requests follow-up work (contains action keywords).
    if (isSlaveReport) {
      const resp = payload.responseText.toLowerCase();
      const needsFollowUp =
        resp.includes('follow-up') || resp.includes('follow up') ||
        resp.includes('please fix') || resp.includes('please improve') ||
        resp.includes('try again') || resp.includes('redo') ||
        resp.includes('not complete') || resp.includes('incomplete') ||
        resp.includes('needs improvement') || resp.includes('need improvement') ||
        resp.includes('missing') || resp.includes('incorrect') ||
        resp.includes('## follow-up instructions');
      if (!needsFollowUp) {
        // Master accepted the slave's work — no further handoff needed
        await this.autoModeRedis.incrMasterTurns().catch(() => {});
        return;
      }
    }

    // Set slave busy before handoff
    await this.autoModeRedis.setSlaveBusy(600).catch(() => {});

    const handoff = isSlaveReport
      ? `## Follow-up Instructions from Master\n\n` +
        `### Session Context\n${trimmed}\n\n` +
        `### Master's Feedback & Corrections\n${payload.responseText.slice(0, 1500)}\n\n` +
        `### Your Mission (Slave Runner)\n` +
        `The master coordinator reviewed your previous work and found issues that need to be addressed.\n\n` +
        `**Requirements:**\n` +
        `1. Carefully read the master's feedback above — address every point raised.\n` +
        `2. Fix the issues identified, then re-verify your work.\n` +
        `3. Be more thorough this time — double-check edge cases and test your changes.\n` +
        `4. Provide a clear summary of what you fixed and how you verified it.\n\n` +
        `Do better this time. The master found problems with your previous attempt.`
      : `## Task Handoff from Master\n\n` +
        `### Session Context\n${trimmed}\n\n` +
        `### User's Original Request\n${payload.userPrompt.slice(0, 800)}\n\n` +
        `### Master's Analysis & Instructions\n${payload.responseText.slice(0, 1500)}\n\n` +
        `### Your Mission (Slave Runner)\n` +
        `You are the execution agent. The user sent the request above via Telegram, and the master coordinator has analyzed it.\n\n` +
        `**Requirements:**\n` +
        `1. Complete the task described above to the highest quality possible.\n` +
        `2. Be thorough — check edge cases, validate your work, and verify the outcome matches the user's intent.\n` +
        `3. If the task involves code, run tests/linting to confirm correctness before finishing.\n` +
        `4. If the task is ambiguous, interpret it in the way most helpful to the user rather than doing nothing.\n` +
        `5. Provide a clear, concise summary of what you did and the result.\n\n` +
        `Do your best work. The user is waiting for your response.`;
    await this.autoModeRedis
      .pushSlaveHandoff(handoff, payload.outboundChatId)
      .catch(() => {});
    await this.autoModeRedis.incrMasterTurns().catch(() => {});
  }

  override async recordAutoModeSlaveTurnCompleted(): Promise<void> {
    if (!this.autoModeRedis) return;
    await this.autoModeRedis.incrSlaveResponseCount();
    await this.autoModeRedis.clearSlaveBusy().catch(() => {});
  }

  // ── Lifecycle hooks (called generically by bridge-manager) ───

  onMessageStart(chatId: string): void {
    this.startTyping(chatId);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Register slash commands with Telegram Bot API so they appear in the menu.
   */
  private async registerCommands(): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'setMyCommands', {
      commands: [
        { command: 'new', description: 'Start new session (optionally specify path)' },
        { command: 'bind', description: 'Bind to existing session' },
        { command: 'cwd', description: 'Change working directory' },
        { command: 'mode', description: 'Switch mode: plan / code / ask' },
        { command: 'runner', description: 'List or switch LLM runner for this chat' },
        { command: 'status', description: 'Show current session status' },
        { command: 'sessions', description: 'List recent sessions' },
        { command: 'stop', description: 'Stop current task' },
        { command: 'help', description: 'Show available commands' },
      ],
    });
  }

  private enqueue(msg: InboundMessage): void {
    if (
      this.hybridAutoMode &&
      this.autoModeRedis &&
      (!msg.deliverySource || msg.deliverySource === 'runner') &&
      msg.text?.trim()
    ) {
      const t = msg.text.trim();
      const isCommand = t.startsWith('/');
      if (!isCommand && !msg.callbackData && !msg.attachments?.length) {
        this.hybridMirrorChatId = msg.address.chatId;
        if (!msg.deliverySource) msg.deliverySource = 'runner';
        const binding = router.resolve(msg.address);
        // Check if slave is busy before pushing to master
        void this.autoModeRedis.isSlaveBusy().then((busy) => {
          if (busy) {
            void callTelegramApi(this.botToken!, 'sendMessage', {
              chat_id: msg.address.chatId,
              text: '⏳ Slave 正在处理中，已排队等待...',
            }).catch(() => {});
          }
          void this.autoModeRedis!.pushMasterInput(
            t,
            binding.runnerProfileId ?? getBridgeContext().getDefaultRunnerIdForChannelType?.(this.channelType) ?? 'default',
            msg.address.chatId,
          );
        });
        return;
      }
    }
    if (this.hybridAutoMode) {
      this.hybridMirrorChatId = msg.address.chatId;
      if (!msg.deliverySource) {
        msg.deliverySource = 'runner';
      }
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Redis inbound loop for Auto mode slave (no Telegram polling when Redis-only). */
  private async autoModeRedisPollLoop(): Promise<void> {
    const rt = this.autoModeRedis;
    if (!rt) return;
    await runAutoModeRedisInboundLoop(
      rt,
      this.channelType,
      (msg) => this.enqueue(msg),
      () => this.running,
      async () => {
        console.log(`[telegram-adapter] Auto mode max turns/responses (${this.instanceId})`);
        await this.stop();
      },
      (msg) => {
        // Send typing indicator when slave receives a task
        const chatId = msg.address?.chatId || this.hybridMirrorChatId;
        if (chatId && this.botToken) {
          void callTelegramApi(this.botToken, 'sendChatAction', {
            chat_id: chatId,
            action: 'typing',
          }).catch(() => {});
          void callTelegramApi(this.botToken, 'sendMessage', {
            chat_id: chatId,
            text: '🤖 [Slave] 正在处理中...',
          }).catch(() => {});
        }
      },
    );
  }

  /** Mirror master Redis fetch to Telegram, then enqueue master pipeline message. */
  private async autoModeMasterRedisPollLoop(): Promise<void> {
    const rt = this.autoModeRedis;
    if (!rt || !this.hybridAutoMode) return;
    await runAutoModeMasterRedisInboundLoop(
      rt,
      this.channelType,
      (msg) => this.notifyTelegramMasterRedisFetch(msg),
      (msg) => this.enqueue(msg),
      () => this.running,
      async () => {
        console.log(`[telegram-adapter] Auto mode master max turns (${this.instanceId})`);
        await this.stop();
      },
    );
  }

  private async notifyTelegramMasterRedisFetch(msg: InboundMessage): Promise<void> {
    const chatId = msg.outboundChatId || this.hybridMirrorChatId || this.imGet('telegram_chat_id');
    const token = this.botToken;
    if (!token || !chatId) return;
    const fetchedText = msg.text;
    const preview =
      fetchedText.length > 3500 ? `${fetchedText.slice(0, 3500)}…` : fetchedText;
    await callTelegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `<b>[master·Redis→]</b>\n${escapeHtml(preview)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch(() => {});
  }

  /**
   * Return the DB key used to store the offset, scoped to the bot's stable identity.
   * Uses the bot user ID (from getMe) which survives token rotation.
   * Falls back to the token hash if getMe was not successful.
   */
  private offsetKey(): string {
    if (this.botUserId) {
      return 'telegram:bot' + this.botUserId;
    }
    const token = this.botToken;
    if (!token) return 'telegram';
    return 'telegram:' + tokenShortHash(token);
  }

  /**
   * Resolve the bot's stable user ID via Telegram's getMe API.
   * On first startup with bot-ID-based key, migrates the offset from the
   * old token-hash-based key so no messages are re-fetched.
   */
  private async resolveBotIdentity(): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    try {
      const url = `${TELEGRAM_API}/bot${token}/getMe`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await res.json();
      if (data.ok && data.result?.id) {
        this.botUserId = String(data.result.id);

        // Migrate offset from old token-hash key to new bot-ID key
        const newKey = 'telegram:bot' + this.botUserId;
        const oldKey = 'telegram:' + tokenShortHash(token);
        const existingNew = getBridgeContext().store.getChannelOffset(newKey);
        if (!existingNew || existingNew === '0') {
          const existingOld = getBridgeContext().store.getChannelOffset(oldKey);
          if (existingOld && existingOld !== '0') {
            getBridgeContext().store.setChannelOffset(newKey, existingOld);
            console.log(`[telegram-adapter] Migrated offset from ${oldKey} to ${newKey}: ${existingOld}`);
          }
        }
      } else {
        console.warn('[telegram-adapter] getMe did not return a valid bot ID, falling back to token hash');
      }
    } catch (err) {
      console.warn('[telegram-adapter] getMe failed, falling back to token hash:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Mark an update as safely processed (enqueued or intentionally skipped).
   *
   * Uses contiguous watermark advancement: committedOffset only advances when
   * there are no gaps (e.g., media-group updates still buffered) below it.
   * This prevents offset from jumping past un-flushed album messages.
   */
  private markUpdateProcessed(updateId: number): void {
    this.recentUpdateIds.add(updateId);

    // Walk committedOffset forward contiguously — only advance while
    // the current position has been confirmed as processed.
    while (this.recentUpdateIds.has(this.committedOffset)) {
      this.committedOffset++;
    }

    // Prune dedup set when it exceeds capacity
    if (this.recentUpdateIds.size > DEDUP_SET_MAX) {
      const excess = this.recentUpdateIds.size - DEDUP_SET_MAX;
      let removed = 0;
      for (const id of this.recentUpdateIds) {
        if (removed >= excess) break;
        this.recentUpdateIds.delete(id);
        removed++;
      }
    }
  }

  /**
   * Persist the committed offset to DB. Safe to call at any time.
   */
  private persistCommittedOffset(): void {
    if (this.committedOffset <= 0) return;
    try {
      getBridgeContext().store.setChannelOffset(this.offsetKey(), String(this.committedOffset));
    } catch { /* best effort */ }
  }

  private async pollLoop(): Promise<void> {
    const key = this.offsetKey();

    // Load persisted committed offset
    this.committedOffset = parseInt(getBridgeContext().store.getChannelOffset(key), 10) || 0;

    // fetchOffset is used for the getUpdates API call; starts at committed offset
    let fetchOffset = this.committedOffset;

    while (this.running) {
      try {
        const token = this.botToken;
        if (!token) {
          console.warn('[telegram-adapter] No bot token, waiting...');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const url = `${TELEGRAM_API}/bot${token}/getUpdates`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: fetchOffset,
            timeout: 30,
            allowed_updates: ['message', 'callback_query'],
          }),
          signal: this.abortController?.signal,
        });

        if (!this.running) break;

        const data: any = await res.json();
        if (!data.ok || !Array.isArray(data.result)) {
          console.warn('[telegram-adapter] getUpdates failed:', JSON.stringify(data).slice(0, 200));
          continue;
        }
        const updates: TelegramUpdate[] = data.result;
        for (const update of updates) {
          // Advance fetchOffset so the next getUpdates call skips this update
          if (update.update_id >= fetchOffset) {
            fetchOffset = update.update_id + 1;
          }

          // Idempotency: skip updates already processed (dedup on restart)
          if (this.recentUpdateIds.has(update.update_id)) {
            this.markUpdateProcessed(update.update_id);
            continue;
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat.id ? String(cb.message.chat.id) : '';
            const userId = String(cb.from.id);

            if (!this.isAuthorized(userId, chatId)) {
              console.warn('[telegram-adapter] Unauthorized callback from userId:', userId, 'chatId:', chatId);
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const msg: InboundMessage = {
              messageId: cb.id,
              address: {
                channelType: this.channelType,
                chatId,
                userId,
                displayName: cb.from.username || cb.from.first_name,
              },
              text: '',
              timestamp: Date.now(),
              callbackData: cb.data,
              callbackMessageId: cb.message?.message_id ? String(cb.message.message_id) : undefined,
              raw: update,
              updateId: update.update_id,
            };

            this.enqueue(msg);

            // Answer callback to dismiss the loading state
            this.answerCallback(cb.id).catch(() => {});
          } else if (update.message) {
            const m = update.message;
            const chatId = String(m.chat.id);
            const userId = m.from ? String(m.from.id) : chatId;
            const displayName = m.from?.username || m.from?.first_name || chatId;

            if (!this.isAuthorized(userId, chatId)) {
              console.warn('[telegram-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const hasPhoto = m.photo && m.photo.length > 0;
            const hasDocImage = m.document && this.isDocumentImage(m.document);
            const hasMedia = hasPhoto || hasDocImage;

            // Unified text extraction: text for regular messages, caption for media messages
            const messageText = m.text ?? m.caption ?? '';

            if (hasMedia && isImageEnabled()) {
              if (m.media_group_id) {
                // Album message — buffer for debounce, advance fetchOffset immediately
                this.bufferMediaGroup(m.media_group_id, update, chatId, userId, displayName);
                // Don't markUpdateProcessed yet — offset will be committed on flush
              } else {
                // Single image message — process immediately
                await this.processSingleImageMessage(update, chatId, userId, displayName);
              }
            } else if (messageText) {
              // Text/caption message (covers: pure text, image_enabled=false + caption,
              // unsupported document + caption)
              const msg: InboundMessage = {
                messageId: String(m.message_id),
                address: {
                  channelType: this.channelType,
                  chatId,
                  userId,
                  displayName,
                },
                text: messageText,
                timestamp: m.date * 1000,
                raw: update,
                updateId: update.update_id,
              };

              // Audit log
              try {
                getBridgeContext().store.insertAuditLog({
                  channelType: this.channelType,
                  chatId,
                  direction: 'inbound',
                  messageId: String(m.message_id),
                  summary: messageText.slice(0, 200),
                });
              } catch { /* best effort */ }

              this.enqueue(msg);
            } else {
              // Unhandled message type (sticker, voice, etc.) — skip
              this.markUpdateProcessed(update.update_id);
            }
          } else {
            // Unhandled update type — still safe to advance past it
            this.markUpdateProcessed(update.update_id);
          }
        }

        // Persist committed offset after processing the batch
        this.persistCommittedOffset();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
        console.warn('[telegram-adapter] Polling error:', err instanceof Error ? err.message : err);
        // Persist whatever we've safely committed before backing off
        this.persistCommittedOffset();
        if (this.running) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  /**
   * Check if a Telegram document is a supported image type.
   */
  private isDocumentImage(doc: TelegramDocument): boolean {
    if (doc.mime_type && isSupportedImageMime(doc.mime_type)) return true;
    if (doc.file_name) {
      const mime = inferMimeType(doc.file_name);
      if (mime && isSupportedImageMime(mime)) return true;
    }
    return false;
  }

  /**
   * Process a single image message (no media_group_id).
   * Downloads the image and enqueues a message with attachments.
   * Sends rejection notifications directly to Telegram on failure.
   */
  private async processSingleImageMessage(
    update: TelegramUpdate,
    chatId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    const m = update.message!;
    const token = this.botToken;
    const address = { channelType: this.channelType, chatId, userId, displayName };

    if (!token) {
      this.markUpdateProcessed(update.update_id);
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];

    if (m.photo && m.photo.length > 0) {
      const result = await downloadPhoto(token, m.photo, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    } else if (m.document) {
      const result = await downloadDocumentImage(token, m.document, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    }

    // Send rejection notification directly to user
    if (rejections.length > 0) {
      const notice = rejections.map(r => r.rejectedMessage || 'Image processing failed').join('\n');
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = m.caption || m.text || '';
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // Nothing usable (all images failed, no text) — mark processed
      this.markUpdateProcessed(update.update_id);
      return;
    }

    const summary = attachments.length > 0
      ? `[${attachments.length} image(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    // Audit log
    try {
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        chatId,
        direction: 'inbound',
        messageId: String(m.message_id),
        summary,
      });
    } catch { /* best effort */ }

    const msg: InboundMessage = {
      messageId: String(m.message_id),
      address,
      text,
      timestamp: m.date * 1000,
      raw: update,
      updateId: update.update_id,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }

  /**
   * Buffer a media group update for debounced processing.
   * Resets the 500ms timer on each new update in the same group.
   */
  private bufferMediaGroup(
    mediaGroupId: string,
    update: TelegramUpdate,
    chatId: string,
    userId: string,
    displayName: string,
  ): void {
    const existing = this.mediaGroupBuffers.get(mediaGroupId);

    if (existing) {
      // Add to existing buffer, reset timer
      clearTimeout(existing.timer);
      existing.updates.push(update);
      existing.updateIds.push(update.update_id);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      // New buffer
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroupBuffers.set(mediaGroupId, {
        updates: [update],
        updateIds: [update.update_id],
        timer,
        chatId,
        userId,
        displayName,
      });
    }
  }

  /**
   * Flush a media group buffer — download all images and enqueue a single message.
   */
  private async flushMediaGroup(mediaGroupId: string): Promise<void> {
    const entry = this.mediaGroupBuffers.get(mediaGroupId);
    if (!entry) return;
    this.mediaGroupBuffers.delete(mediaGroupId);

    const address = {
      channelType: this.channelType,
      chatId: entry.chatId,
      userId: entry.userId,
      displayName: entry.displayName,
    };

    const token = this.botToken;
    if (!token) {
      // Can't download — mark all as processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];
    let caption = '';
    let firstMessageId = '';
    let firstDate = 0;

    // Download all images in the group
    for (const update of entry.updates) {
      const m = update.message!;
      if (!firstMessageId) {
        firstMessageId = String(m.message_id);
        firstDate = m.date;
      }
      // Use caption from whichever update has it (Telegram only sends caption on one)
      if (m.caption && !caption) {
        caption = m.caption;
      }

      if (m.photo && m.photo.length > 0) {
        const result = await downloadPhoto(token, m.photo, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      } else if (m.document && this.isDocumentImage(m.document)) {
        const result = await downloadDocumentImage(token, m.document, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      }
    }

    // Send rejection notification if any images failed
    if (rejections.length > 0) {
      const reasons = rejections.map(r => r.rejectedMessage || 'Image processing failed').join('\n');
      const notice = rejections.length === 1
        ? reasons
        : `${rejections.length} image(s) failed:\n${reasons}`;
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = caption;
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // All downloads failed and no caption — mark all processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const summary = attachments.length > 0
      ? `[Album: ${attachments.length} image(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        chatId: entry.chatId,
        direction: 'inbound',
        messageId: firstMessageId,
        summary,
      });
    } catch { /* best effort */ }

    // Use the max updateId so acknowledgeUpdate advances offset past all buffered updates
    const maxUpdateId = Math.max(...entry.updateIds);

    // Pre-register all buffered IDs in recentUpdateIds so the contiguous
    // watermark walk can advance past them when bridge-manager acks maxUpdateId.
    for (const uid of entry.updateIds) {
      this.recentUpdateIds.add(uid);
    }

    const msg: InboundMessage = {
      messageId: firstMessageId,
      address,
      text,
      timestamp: firstDate * 1000,
      updateId: maxUpdateId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }
}

// Self-register so bridge-manager can create TelegramAdapter via the registry.
registerAdapterFactory('telegram', (instanceId: string) => new TelegramAdapter(instanceId));
