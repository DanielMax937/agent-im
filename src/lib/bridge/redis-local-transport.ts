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

interface RedisClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lPush(key: string, value: string): Promise<number>;
  rPop(key: string): Promise<string | null>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lLen(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<string>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
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
    if (this.settings.hybridMode) {
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
   */
  async pushMasterInput(
    text: string,
    _masterRunnerId: string,
    outboundChatId?: string,
  ): Promise<void> {
    if (!this.client) return;
    const turns = await this.getMasterTurns();
    if (turns >= this.settings.maxTurns) return;
    await this.client.lPush(
      this.keyMaster('input'),
      encodeQueuePayload({ text, outboundChatId }),
    );
  }

  /** Legacy: push to slave input (redis-only / non-hybrid paths). */
  async pushUserInput(text: string): Promise<void> {
    if (!this.client) return;
    const turns = await this.getSlaveTurns();
    if (turns >= this.settings.maxTurns) return;
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
        return { ok: true };
      }
      await this.client.lPush(this.keySlave('out'), text);
      await this.incrSlaveTurns();
      appendSlaveMessage(text, this.bridgeSlug);
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
    if (turns >= this.settings.maxTurns) return;
    await this.client.lPush(
      this.keySlave('input'),
      encodeQueuePayload({ text, outboundChatId }),
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
    const rid = this.masterRunnerIds[0] ?? 'default';
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
        await onMaxTurnsReached();
        break;
      }
      const msg = await transport.pollOnce();
      if (!msg) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
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
