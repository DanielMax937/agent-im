/**
 * Redis transport for **Auto mode**:
 * - **Master** queues (no `:slave`): coordinator path; hybrid Telegram LPUSHes user text to `master:input`.
 * - **Slave** queues (`:slave:`): tool runner path; master handoff LPUSHes to `slave:input`.
 *
 * Keys via {@link buildAutoRedisKey}:
 *   cti:auto:{bridge}:{channel}:{runnerId}:input|out|turns|resp
 *   cti:auto:{bridge}:{channel}:{runnerId}:slave:input|out|turns|resp
 */

import crypto from 'node:crypto';

import type { BridgeStore } from './host';
import type { InboundMessage } from './types';
import type { ImBaseChannel } from './im-instance-settings';
import { imScopedGet } from './im-instance-settings';
import { getBridgeContext } from './context';
import { appendMasterMessage, appendSlaveMessage } from '../monitor-messages';
import {
  buildAutoRedisKey,
  type AutoRedisQueueSuffix,
} from './auto-redis-keys';
import { MASTER_VERIFICATION_WALKTHROUGH_PREFIX } from './master-verification-walkthrough';

interface RedisClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lPush(key: string, value: string): Promise<number>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  rPop(key: string): Promise<string | null>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lLen(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<string>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments?: string[] }): Promise<unknown>;
}

export interface AutoModeStoreSettings {
  redisUrl: string;
  maxTurns: number;
  /** Telegram + Redis hybrid: skip LPUSH seed; user text comes from IM instead. */
  hybridMode?: boolean;
}

interface AutoModeQueueEnvelope {
  text: string;
  outboundChatId?: string;
}

function encodeQueuePayload(payload: AutoModeQueueEnvelope): string {
  return JSON.stringify(payload);
}

function encodeChatSegment(chatId: string): string {
  return encodeURIComponent(chatId);
}

/** Queued Telegram user text while the single task slot is busy (hybrid). */
export interface PendingTelegramUserMessage {
  text: string;
  outboundChatId?: string;
  masterRunnerId: string;
}

function encodePendingTelegramUserMessage(p: PendingTelegramUserMessage): string {
  return JSON.stringify(p);
}

function decodePendingTelegramUserMessage(raw: string): PendingTelegramUserMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (typeof o.text === 'string' && typeof o.masterRunnerId === 'string') {
        const outboundChatId = o.outboundChatId;
        return {
          text: o.text,
          masterRunnerId: o.masterRunnerId,
          outboundChatId:
            typeof outboundChatId === 'string' && outboundChatId.trim()
              ? outboundChatId
              : undefined,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function decodeQueuePayload(raw: string): AutoModeQueueEnvelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { text?: unknown }).text === 'string'
    ) {
      const outboundChatId = (parsed as { outboundChatId?: unknown }).outboundChatId;
      return {
        text: (parsed as { text: string }).text,
        outboundChatId:
          typeof outboundChatId === 'string' && outboundChatId.trim()
            ? outboundChatId
            : undefined,
      };
    }
  } catch {
    // Backward-compatible: legacy producers push plain text.
  }
  return { text: raw };
}

function storeGetWithLegacy(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
  newKey: string,
  legacyKey: string,
): string | null {
  const v = imScopedGet(store, base, instanceId, newKey);
  if (v !== null && v !== '') return v;
  return imScopedGet(store, base, instanceId, legacyKey);
}

/**
 * True when Auto mode is on (`bridge_*_auto_mode`) or legacy store flag
 * (`bridge_*_local_agent_enabled`).
 */
export function isAutoModeIntentEnabled(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): boolean {
  const auto = imScopedGet(store, base, instanceId, `bridge_${base}_auto_mode`);
  if (auto === 'true' || auto === 'false') {
    return auto === 'true';
  }
  return imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_enabled`) === 'true';
}

/** Auto mode Redis pipeline is active (enabled + Redis URL + settings readable). */
export function isAutoModePipelineActive(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): boolean {
  return readAutoModeSettings(store, base, instanceId) !== null;
}

/**
 * Returns Auto mode settings when enabled **and** a per-instance Redis URL is set.
 */
export function readAutoModeSettings(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): AutoModeStoreSettings | null {
  if (!isAutoModeIntentEnabled(store, base, instanceId)) return null;
  const redisUrl = storeGetWithLegacy(
    store,
    base,
    instanceId,
    `bridge_${base}_auto_redis_url`,
    `bridge_${base}_local_agent_redis_url`,
  )?.trim();
  if (!redisUrl) return null;
  const maxTurnsRaw = storeGetWithLegacy(
    store,
    base,
    instanceId,
    `bridge_${base}_auto_max_turns`,
    `bridge_${base}_local_agent_max_turns`,
  );
  const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : 100;
  return {
    redisUrl,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 100,
  };
}

/**
 * Hybrid Auto mode: IM token + Redis together; outbound replies get `[master]` / `[slave]` prefixes.
 */
export function isHybridAutoModeEnabled(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): boolean {
  if (!readAutoModeSettings(store, base, instanceId)) return false;
  // Only Telegram currently implements the full hybrid master/slave pipeline.
  return (
    base === 'telegram' &&
    Boolean(imScopedGet(store, base, instanceId, 'telegram_bot_token')?.trim())
  );
}

export class AutoModeRedisTransport {
  private client: RedisClient | null = null;
  private readonly sessionId = crypto.randomUUID();
  private initialized = false;

  constructor(
    /** Full adapter channel key, e.g. `telegram` or `telegram:instanceId`. */
    public readonly channelType: string,
    public readonly settings: AutoModeStoreSettings,
    public readonly bridgeSlug: string,
    /** All runner ids that may host a master queue (kept for synthetic chatId). */
    private readonly masterRunnerIds: string[],
    private readonly slaveRunnerId: string,
    private readonly getMirrorChatId?: () => string | null,
    /** Preferred master runner id (from defaultRunnerId config). Falls back to masterRunnerIds[0]. */
    private readonly defaultRunnerId?: string,
  ) {}

  private keyMaster(suffix: AutoRedisQueueSuffix): string {
    return buildAutoRedisKey({
      bridgeSlug: this.bridgeSlug,
      channelType: this.channelType,
      role: 'master',
      suffix,
    });
  }

  private keySlave(suffix: AutoRedisQueueSuffix): string {
    return buildAutoRedisKey({
      bridgeSlug: this.bridgeSlug,
      channelType: this.channelType,
      role: 'slave',
      suffix,
    });
  }

  async connect(): Promise<void> {
    if (this.client) return;
    try {
      const { createClient } = await import('redis');
      const client = createClient({ url: this.settings.redisUrl });
      client.on('error', (err: Error) => {
        console.error(`[auto-mode-redis:${this.channelType}]`, err.message);
      });
      await client.connect();
      this.client = client as unknown as RedisClient;
    } catch (err: unknown) {
      throw new Error(
        `Redis connect failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.disconnect();
    } catch {
      /* noop */
    }
    this.client = null;
  }

  /** Seed first user message once; skip if Redis already has state (restart-safe). */
  async seedFirstPromptIfNeeded(): Promise<void> {
    if (!this.client || this.initialized) return;
    // Slave bridges wait for master to forward real user input — never self-seed.
    if (this.settings.hybridMode || process.env.CTI_SLAVE_BRIDGE === '1') {
      this.initialized = true;
      return;
    }
    const turns = await this.client.get(this.keySlave('turns'));
    if (turns !== null) {
      this.initialized = true;
      return;
    }
    await this.client.lPush(this.keySlave('input'), 'Hello');
    await this.client.set(this.keySlave('turns'), '0');
    this.initialized = true;
  }

  /**
   * Fan-out user text from IM into the **master** `input` list (hybrid Telegram).
   * `masterRunnerId` is the chat’s current runner (`/runner`), not a separate config field.
   * @returns false when Redis is unavailable, master turn cap is reached, or push did not occur.
   */
  async pushMasterInput(
    text: string,
    _masterRunnerId: string,
    outboundChatId?: string,
  ): Promise<boolean> {
    if (!this.client) return false;
    const turns = await this.getMasterTurns();
    if (turns >= this.settings.maxTurns) {
      console.warn(
        `[auto-mode-redis] pushMasterInput skipped: masterTurns=${turns} >= maxTurns=${this.settings.maxTurns} ` +
          `(bridge=${this.bridgeSlug}).`,
      );
      return false;
    }
    const key = this.keyMaster('input');
    await this.client.lPush(
      key,
      encodeQueuePayload({ text, outboundChatId }),
    );
    const isReport = text.startsWith('## Slave Execution Report');
    console.log(
      `[auto-mode-redis] Pushed to master:input (${this.bridgeSlug}), ` +
      `key=${key}, type=${isReport ? 'slave-report' : 'other'}, ` +
      `len=${text.length}, preview=${JSON.stringify(text.slice(0, 100))}`,
    );
    return true;
  }

  /**
   * Hybrid Telegram only: atomically take the single user-message slot (next Telegram→master input).
   * Missing key or value `'1'` means idle; `'0'` means a task is in progress.
   */
  async tryAcquireTelegramUserInputSlot(): Promise<boolean> {
    if (!this.client) return false;
    const idleKey = this.keyMaster('user_input_idle');
    const raw = await this.client.eval(
      `
      local cur = redis.call('GET', KEYS[1])
      if (not cur) or (cur == '1') then
        redis.call('SET', KEYS[1], '0')
        return 1
      end
      return 0
      `,
      { keys: [idleKey], arguments: [] },
    );
    return raw === 1 || raw === '1';
  }

  /** Allow the next user message from Telegram into `master:input` (task finished or bridge reset). */
  async releaseTelegramUserInputSlot(): Promise<void> {
    if (!this.client) return;
    await this.client.set(this.keyMaster('user_input_idle'), '1');
  }

  /**
   * Hybrid: append a user message while the task slot is busy (FIFO: RPUSH, drain with LPOP).
   * @returns list length after enqueue
   */
  async enqueuePendingTelegramUserMessage(
    payload: PendingTelegramUserMessage,
  ): Promise<number> {
    if (!this.client) return 0;
    const key = this.keyMaster('user_pending');
    await this.client.rPush(key, encodePendingTelegramUserMessage(payload));
    return this.client.lLen(key);
  }

  async getPendingTelegramUserMessageCount(): Promise<number> {
    if (!this.client) return 0;
    return this.client.lLen(this.keyMaster('user_pending'));
  }

  async dequeueOnePendingTelegramUserMessage(): Promise<PendingTelegramUserMessage | null> {
    if (!this.client) return null;
    const raw = await this.client.lPop(this.keyMaster('user_pending'));
    if (!raw) return null;
    return decodePendingTelegramUserMessage(raw);
  }

  /** Re-queue at the front when pushMasterInput failed after dequeue (LPUSH). */
  async prependPendingTelegramUserMessage(payload: PendingTelegramUserMessage): Promise<void> {
    if (!this.client) return;
    await this.client.lPush(
      this.keyMaster('user_pending'),
      encodePendingTelegramUserMessage(payload),
    );
  }

  /** Legacy: push to slave input (redis-only / non-hybrid paths). */
  async pushUserInput(text: string): Promise<void> {
    if (!this.client) return;
    const turns = await this.getSlaveTurns();
    if (turns >= this.settings.maxTurns) {
      console.warn(
        `[auto-mode-redis] pushUserInput skipped: slaveTurns=${turns} >= maxTurns=${this.settings.maxTurns} ` +
          `(bridge=${this.bridgeSlug}).`,
      );
      return;
    }
    await this.client.lPush(this.keySlave('input'), encodeQueuePayload({ text }));
  }

  async getMasterTurns(): Promise<number> {
    if (!this.client) return 0;
    const t = await this.client.get(this.keyMaster('turns'));
    return t ? parseInt(t, 10) : 0;
  }

  async incrMasterTurns(): Promise<number> {
    if (!this.client) return 0;
    return this.client.incr(this.keyMaster('turns'));
  }

  async getSlaveTurns(): Promise<number> {
    if (!this.client) return 0;
    const t = await this.client.get(this.keySlave('turns'));
    return t ? parseInt(t, 10) : 0;
  }

  /** @deprecated Prefer {@link getSlaveTurns} */
  async getTurns(): Promise<number> {
    return this.getSlaveTurns();
  }

  async incrSlaveTurns(): Promise<number> {
    if (!this.client) return 0;
    return this.client.incr(this.keySlave('turns'));
  }

  /** @deprecated Prefer {@link incrSlaveTurns} */
  async incrTurns(): Promise<number> {
    return this.incrSlaveTurns();
  }

  async getSlaveResponseCount(): Promise<number> {
    if (!this.client) return 0;
    const v = await this.client.get(this.keySlave('resp'));
    return v ? parseInt(v, 10) : 0;
  }

  async incrSlaveResponseCount(): Promise<number> {
    if (!this.client) return 0;
    return this.client.incr(this.keySlave('resp'));
  }

  // ── Session summary (rolling context for master→slave handoff) ──

  /** Read the rolling session summary for the master→slave handoff. */
  async getSessionSummary(): Promise<string | null> {
    if (!this.client) return null;
    return this.client.get(this.keyMaster('summary'));
  }

  /** Update the rolling session summary (master writes after each turn). */
  async setSessionSummary(summary: string): Promise<void> {
    if (!this.client) return;
    await this.client.set(this.keyMaster('summary'), summary);
  }

  /** Last user message forwarded from Telegram→slave (hybrid path), for Slave report goal fallback. */
  async getLastUserRequest(): Promise<string | null> {
    if (!this.client) return null;
    return this.client.get(this.keyMaster('last_user'));
  }

  async setLastUserRequest(text: string): Promise<void> {
    if (!this.client) return;
    await this.client.set(this.keyMaster('last_user'), text.slice(0, 4000));
  }

  /**
   * When set, the slave was asked to fix something (review or failed verification).
   * After the next acceptable static review, master must run the verification walkthrough again;
   * loop until {@link clearReverifyPending} (verification PASSED) or user resets the task.
   */
  async setReverifyPending(pending: boolean): Promise<void> {
    if (!this.client) return;
    if (pending) {
      await this.client.set(this.keyMaster('reverify'), '1');
    } else {
      await this.client.del(this.keyMaster('reverify'));
    }
  }

  async isReverifyPending(): Promise<boolean> {
    if (!this.client) return false;
    const v = await this.client.get(this.keyMaster('reverify'));
    return v === '1';
  }

  // ── Per-task review loop counter (kanbanConfirmationMaxLoops analogue) ──

  /** Increment the review-loop counter and return the new value. */
  async incrReviewLoops(): Promise<number> {
    if (!this.client) return 0;
    return this.client.incr(this.keyMaster('review_loops'));
  }

  /** Get the current review-loop count. */
  async getReviewLoops(): Promise<number> {
    if (!this.client) return 0;
    const v = await this.client.get(this.keyMaster('review_loops'));
    return v ? parseInt(v, 10) : 0;
  }

  /** Reset the review-loop counter (call on task completion or new user message). */
  async resetReviewLoops(): Promise<void> {
    if (!this.client) return;
    await this.client.del(this.keyMaster('review_loops'));
  }

  // ── Coverage baseline (persists across tasks, updated only when coverage improves) ──

  /**
   * Get the stored peak coverage percentage for this bridge.
   * Returns `null` when no baseline has been recorded yet.
   */
  async getCoverageBaseline(): Promise<number | null> {
    if (!this.client) return null;
    const v = await this.client.get(this.keyMaster('coverage_baseline'));
    if (v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  /**
   * Update the coverage baseline only if `newCoverage` is strictly greater than the stored value.
   * Returns `true` when the baseline was updated, `false` when it was not (new value not higher).
   */
  async updateCoverageBaseline(newCoverage: number): Promise<boolean> {
    if (!this.client) return false;
    const current = await this.getCoverageBaseline();
    if (current !== null && newCoverage <= current) return false;
    await this.client.set(this.keyMaster('coverage_baseline'), String(newCoverage));
    return true;
  }

  // ── Slave busy lock (prevents concurrent handoffs) ──

  /** Check if slave is currently processing a task. */
  async isSlaveBusy(): Promise<boolean> {
    if (!this.client) return false;
    const v = await this.client.get(this.keySlave('busy'));
    return v === '1';
  }

  /** Mark slave as busy (set before handoff). TTL as safety net. */
  async setSlaveBusy(ttlSeconds = 600): Promise<void> {
    if (!this.client) return;
    await this.client.set(this.keySlave('busy'), '1', { EX: ttlSeconds });
  }

  /** Clear slave busy flag (after slave turn completes). */
  async clearSlaveBusy(): Promise<void> {
    if (!this.client) return;
    await this.client.del(this.keySlave('busy'));
  }

  /**
   * Delete all master + slave Redis keys, resetting auto mode to a clean state.
   * Includes `last_user` and `summary` — use after deploy if rolling summary still contains pre-fix placeholders.
   */
  async resetAll(): Promise<void> {
    if (!this.client) return;
    const suffixes: AutoRedisQueueSuffix[] = [
      'input',
      'out',
      'turns',
      'resp',
      'summary',
      'busy',
      'last_user',
      'reverify',
      'review_loops',
      'user_input_idle',
      'user_pending',
    ];
    for (const suffix of suffixes) {
      await this.client.del(this.keyMaster(suffix));
      await this.client.del(this.keySlave(suffix));
    }
    this.initialized = false;
  }

  /**
   * Clear master/slave input lists after abort (drop in-flight pipeline work).
   * Does not delete `user_pending` — Hybrid Telegram backlog is preserved for /stop → next message.
   */
  async drainInFlightInputQueues(): Promise<void> {
    if (!this.client) return;
    await this.client.del(this.keyMaster('input'));
    await this.client.del(this.keySlave('input'));
  }

  /** Drain master and slave input queues and Hybrid `user_pending` (full discard). */
  async drainInputQueues(): Promise<void> {
    if (!this.client) return;
    await this.drainInFlightInputQueues();
    await this.client.del(this.keyMaster('user_pending'));
  }

  // ── Monitor peek methods (read without consuming) ──

  /** Peek at master output queue (newest first). */
  async peekMasterOut(count = 50): Promise<string[]> {
    if (!this.client) return [];
    return this.client.lRange(this.keyMaster('out'), 0, count - 1);
  }

  /** Peek at slave output queue (newest first). */
  async peekSlaveOut(count = 50): Promise<string[]> {
    if (!this.client) return [];
    return this.client.lRange(this.keySlave('out'), 0, count - 1);
  }

  /** Get queue lengths for monitoring. */
  async getQueueStats(): Promise<{
    masterInput: number; masterOut: number;
    slaveInput: number; slaveOut: number;
    masterTurns: number; slaveTurns: number;
    slaveBusy: boolean;
  }> {
    if (!this.client) return {
      masterInput: 0, masterOut: 0, slaveInput: 0, slaveOut: 0,
      masterTurns: 0, slaveTurns: 0, slaveBusy: false,
    };
    const [masterInput, masterOut, slaveInput, slaveOut, masterTurns, slaveTurns, slaveBusy] =
      await Promise.all([
        this.client.lLen(this.keyMaster('input')),
        this.client.lLen(this.keyMaster('out')),
        this.client.lLen(this.keySlave('input')),
        this.client.lLen(this.keySlave('out')),
        this.getMasterTurns(),
        this.getSlaveTurns(),
        this.isSlaveBusy(),
      ]);
    return { masterInput, masterOut, slaveInput, slaveOut, masterTurns, slaveTurns, slaveBusy };
  }

  /**
   * After Claude replies: push to slave `out`, optionally to peer's slave `input`, increment turns.
   */
  async deliverClaudeReply(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: 'redis not connected' };
    try {
      const turns = await this.getSlaveTurns();
      if (turns >= this.settings.maxTurns) {
        console.warn(
          `[auto-mode-redis] deliverClaudeReply skipped: slaveTurns=${turns} >= maxTurns=${this.settings.maxTurns} ` +
            `(bridge=${this.bridgeSlug}). Reply not written to slave:out.`,
        );
        return { ok: true };
      }
      await this.client.lPush(this.keySlave('out'), text);
      await this.incrSlaveTurns();
      appendSlaveMessage(text, this.bridgeSlug);
      console.log(
        `[auto-mode-redis] Slave delivered reply to Redis (${this.bridgeSlug}), ` +
        `key=${this.keySlave('out')}, len=${text.length}, preview=${JSON.stringify(text.slice(0, 100))}`,
      );
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** LPUSH master `out` after a master assistant reply (hybrid + external consumers). */
  async duplicateMasterOut(text: string, _masterRunnerId: string): Promise<void> {
    if (!this.client) return;
    await this.client.lPush(this.keyMaster('out'), text);
    appendMasterMessage(text, this.bridgeSlug);
  }

  /** Hand off work to the slave runner (LPUSH `slave:input`). */
  async pushSlaveHandoff(text: string, outboundChatId?: string): Promise<void> {
    if (!this.client) return;
    const turns = await this.getSlaveTurns();
    if (turns >= this.settings.maxTurns) {
      console.warn(
        `[auto-mode-redis] pushSlaveHandoff skipped: slaveTurns=${turns} >= maxTurns=${this.settings.maxTurns} ` +
          `(bridge=${this.bridgeSlug}). Verification follow-up / master handoff will NOT be queued for the slave.`,
      );
      return;
    }
    const key = this.keySlave('input');
    await this.client.lPush(
      key,
      encodeQueuePayload({ text, outboundChatId }),
    );
    console.log(
      `[auto-mode-redis] Pushed to slave:input (${this.bridgeSlug}), ` +
      `key=${key}, len=${text.length}, preview=${JSON.stringify(text.slice(0, 100))}`,
    );
  }

  async pollOnceMaster(): Promise<InboundMessage | null> {
    if (!this.client) return null;
    const turns = await this.getMasterTurns();
    if (turns >= this.settings.maxTurns) {
      return null;
    }
    const raw = await this.client.rPop(this.keyMaster('input'));
    if (!raw) return null;
    const payload = decodeQueuePayload(raw);
    const rid =
      (this.defaultRunnerId && this.masterRunnerIds.includes(this.defaultRunnerId)
        ? this.defaultRunnerId
        : this.masterRunnerIds[0]) ?? 'default';
    const chatId = payload.outboundChatId
      ? `auto:master:${this.bridgeSlug}:${this.channelType}:${encodeChatSegment(payload.outboundChatId)}:${rid}`
      : `auto:master:${this.bridgeSlug}:${this.channelType}:${rid}`;
    const mirror = payload.outboundChatId || this.getMirrorChatId?.() || null;
    return {
      messageId: crypto.randomUUID(),
      address: {
        channelType: this.channelType,
        chatId,
        userId: `automaster-${this.bridgeSlug}-${this.channelType}-${rid}`,
        displayName: `Auto master ${this.channelType}/${rid}`,
      },
      text: payload.text,
      timestamp: Date.now(),
      deliverySource: 'master',
      outboundChatId: mirror ?? undefined,
    };
  }

  async pollOnce(): Promise<InboundMessage | null> {
    if (!this.client) return null;
    const turns = await this.getSlaveTurns();
    if (turns >= this.settings.maxTurns) {
      const backlog = await this.client.lLen(this.keySlave('input'));
      if (backlog > 0) {
        console.warn(
          `[auto-mode-redis] pollOnce blocked: slaveTurns=${turns} >= maxTurns=${this.settings.maxTurns} ` +
            `but slave:input has ${backlog} message(s) (bridge=${this.bridgeSlug}).`,
        );
      }
      return null;
    }
    const raw = await this.client.rPop(this.keySlave('input'));
    if (!raw) return null;
    const payload = decodeQueuePayload(raw);
    const chatId = payload.outboundChatId
      ? `auto:${this.bridgeSlug}:${this.channelType}:${encodeChatSegment(payload.outboundChatId)}:${this.slaveRunnerId}`
      : `auto:${this.bridgeSlug}:${this.channelType}:${this.slaveRunnerId}`;
    const mirror = payload.outboundChatId || this.getMirrorChatId?.() || null;
    return {
      messageId: crypto.randomUUID(),
      address: {
        channelType: this.channelType,
        chatId,
        userId: `autoslave-${this.bridgeSlug}-${this.channelType}-${this.slaveRunnerId}`,
        displayName: `Auto slave ${this.channelType}/${this.slaveRunnerId}`,
      },
      text: payload.text,
      timestamp: Date.now(),
      deliverySource: 'slave',
      outboundChatId: mirror ?? undefined,
    };
  }

  get syntheticChatId(): string {
    return `auto:${this.bridgeSlug}:${this.channelType}:${this.slaveRunnerId}`;
  }

  buildSyntheticSlaveChatId(outboundChatId?: string): string {
    return outboundChatId
      ? `auto:${this.bridgeSlug}:${this.channelType}:${encodeChatSegment(outboundChatId)}:${this.slaveRunnerId}`
      : this.syntheticChatId;
  }

  get pollSessionId(): string {
    return this.sessionId;
  }
}

/**
 * Shared inbound poll loop for IM adapters in Auto mode (slave runner).
 */
export async function runAutoModeRedisInboundLoop(
  transport: AutoModeRedisTransport,
  adapterChannelType: string,
  enqueue: (msg: InboundMessage) => void,
  isRunning: () => boolean,
  onMaxTurnsReached: () => Promise<void>,
  onSlaveTaskReceived?: (msg: InboundMessage) => void,
): Promise<void> {
  const { store } = getBridgeContext();
  while (isRunning()) {
    try {
      const turns = await transport.getTurns();
      if (turns >= transport.settings.maxTurns) {
        const stats = await transport.getQueueStats();
        if (stats.slaveInput > 0) {
          console.warn(
            `[auto-mode-redis] Slave inbound loop exiting: slaveTurns=${turns} >= maxTurns=${transport.settings.maxTurns} ` +
              `but slave:input still has ${stats.slaveInput} message(s) (bridge=${transport.bridgeSlug}).`,
          );
        }
        await onMaxTurnsReached();
        break;
      }
      const msg = await transport.pollOnce();
      if (!msg) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.log(
        `[auto-mode-redis] Slave got message from Redis (${transport.bridgeSlug}), ` +
        `len=${msg.text.length}, preview=${JSON.stringify(msg.text.slice(0, 120))}`,
      );
      try {
        store.insertAuditLog({
          channelType: adapterChannelType,
          chatId: msg.address.chatId,
          direction: 'inbound',
          messageId: msg.messageId,
          summary: msg.text.slice(0, 200),
        });
      } catch {
        /* best effort */
      }
      if (onSlaveTaskReceived) onSlaveTaskReceived(msg);
      enqueue(msg);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      console.warn(
        '[auto-mode-redis] poll error:',
        err instanceof Error ? err.message : err,
      );
      if (isRunning()) await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * Master runner poll loop (hybrid Telegram): RPOP master:input → optional mirror hook → enqueue.
 */
export async function runAutoModeMasterRedisInboundLoop(
  transport: AutoModeRedisTransport,
  adapterChannelType: string,
  onMasterFetchFromRedis: (msg: InboundMessage) => Promise<void>,
  enqueue: (msg: InboundMessage) => void,
  isRunning: () => boolean,
  onMaxTurnsReached: () => Promise<void>,
): Promise<void> {
  const { store } = getBridgeContext();
  while (isRunning()) {
    try {
      const turns = await transport.getMasterTurns();
      if (turns >= transport.settings.maxTurns) {
        await onMaxTurnsReached();
        break;
      }
      // Wait while slave is busy to prevent overlapping handoffs
      if (await transport.isSlaveBusy()) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const msg = await transport.pollOnceMaster();
      if (!msg) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const isReport = msg.text.startsWith('## Slave Execution Report');
      const isVerification = msg.text.startsWith(MASTER_VERIFICATION_WALKTHROUGH_PREFIX);
      const masterType = isReport ? 'slave-report' : isVerification ? 'verification' : 'user-message';
      console.log(
        `[auto-mode-redis] Master got message from Redis (${transport.bridgeSlug}), ` +
        `type=${masterType}, ` +
        `len=${msg.text.length}, preview=${JSON.stringify(msg.text.slice(0, 120))}`,
      );
      await onMasterFetchFromRedis(msg);
      try {
        store.insertAuditLog({
          channelType: adapterChannelType,
          chatId: msg.address.chatId,
          direction: 'inbound',
          messageId: msg.messageId,
          summary: msg.text.slice(0, 200),
        });
      } catch {
        /* best effort */
      }
      enqueue(msg);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      console.warn(
        '[auto-mode-redis] master poll error:',
        err instanceof Error ? err.message : err,
      );
      if (isRunning()) await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
