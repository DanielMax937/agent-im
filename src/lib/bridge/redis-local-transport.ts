/**
 * Redis transport for per-bot Local Agent mode: Runner (Claude) talks to Redis only;
 * no Telegram/Discord/etc. API. External "local agent" processes or peer bots read/write
 * the same keys for multi-agent dialogue.
 *
 * Keys (per base channel + instance id):
 *   cti:localagent:{base}:{id}:input  — list: producers LPUSH, bridge RPOPs as user text to Claude
 *   cti:localagent:{base}:{id}:out    — list: bridge LPUSHes Claude replies; local agents RPOP
 *   cti:localagent:{base}:{id}:turns  — turn counter (string)
 */

import crypto from 'node:crypto';

import type { BridgeStore } from './host';
import type { InboundMessage } from './types';
import type { ImBaseChannel } from './im-instance-settings';
import { imScopedGet } from './im-instance-settings';
import { getBridgeContext } from './context';

interface RedisClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lPush(key: string, value: string): Promise<number>;
  rPop(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  incr(key: string): Promise<number>;
}

export interface LocalAgentStoreSettings {
  redisUrl: string;
  firstPrompt: string;
  maxTurns: number;
  peerInstanceId?: string;
  /** Telegram + Redis hybrid: skip LPUSH seed; user text comes from IM instead. */
  hybridMode?: boolean;
}

const KEY_PREFIX = 'cti:localagent';

export function redisLocalKey(base: ImBaseChannel, instanceId: string, suffix: 'input' | 'out' | 'turns'): string {
  return `${KEY_PREFIX}:${base}:${instanceId}:${suffix}`;
}

/** True when this IM instance intends Local Agent mode (Redis I/O instead of platform API). */
export function isLocalAgentIntentEnabled(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): boolean {
  return imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_enabled`) === 'true';
}

/**
 * Returns Local Agent settings when enabled **and** a per-instance Redis URL is set.
 * Redis is only used for Local Agent; there is no global `CTI_AGENT_REDIS_URL` fallback.
 */
export function readLocalAgentSettings(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): LocalAgentStoreSettings | null {
  if (!isLocalAgentIntentEnabled(store, base, instanceId)) return null;
  const redisUrl = imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_redis_url`)?.trim();
  if (!redisUrl) return null;
  const firstPrompt =
    imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_first_prompt`)?.trim() ||
    'Hello';
  const maxTurnsRaw = imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_max_turns`);
  const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : 100;
  const peer = imScopedGet(store, base, instanceId, `bridge_${base}_local_agent_peer_instance_id`)?.trim();
  return {
    redisUrl,
    firstPrompt,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 100,
    peerInstanceId: peer || undefined,
  };
}

/**
 * Local Agent + same bot token (e.g. Telegram): IM and Redis pipelines run together; outbound replies get `[runner]` / `[local-agent]` prefixes.
 */
export function isHybridLocalAgentEnabled(
  store: BridgeStore,
  base: ImBaseChannel,
  instanceId: string,
): boolean {
  if (!readLocalAgentSettings(store, base, instanceId)) return false;
  if (base === 'telegram') {
    return Boolean(imScopedGet(store, base, instanceId, 'telegram_bot_token')?.trim());
  }
  if (base === 'discord') {
    return Boolean(imScopedGet(store, base, instanceId, 'bridge_discord_bot_token')?.trim());
  }
  if (base === 'feishu') {
    return Boolean(imScopedGet(store, base, instanceId, 'bridge_feishu_app_id')?.trim());
  }
  if (base === 'qq') {
    return Boolean(imScopedGet(store, base, instanceId, 'bridge_qq_app_id')?.trim());
  }
  return false;
}

export class RedisLocalTransport {
  private client: RedisClient | null = null;
  private readonly sessionId = crypto.randomUUID();
  private initialized = false;

  constructor(
    private readonly base: ImBaseChannel,
    private readonly instanceId: string,
    public readonly settings: LocalAgentStoreSettings,
    private readonly getMirrorChatId?: () => string | null,
  ) {}

  private key(suffix: 'input' | 'out' | 'turns'): string {
    return redisLocalKey(this.base, this.instanceId, suffix);
  }

  peerInputKey(peerId: string): string {
    return redisLocalKey(this.base, peerId, 'input');
  }

  async connect(): Promise<void> {
    if (this.client) return;
    try {
      const { createClient } = await import('redis');
      const client = createClient({ url: this.settings.redisUrl });
      client.on('error', (err: Error) => {
        console.error(`[redis-local-transport:${this.base}:${this.instanceId}]`, err.message);
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
    const turns = await this.client.get(this.key('turns'));
    if (turns !== null) {
      this.initialized = true;
      return;
    }
    await this.client.lPush(this.key('input'), this.settings.firstPrompt);
    await this.client.set(this.key('turns'), '0');
    this.initialized = true;
  }

  /** Fan-out user text from IM into the Local Agent `input` list (hybrid mode). */
  async pushUserInput(text: string): Promise<void> {
    if (!this.client) return;
    const turns = await this.getTurns();
    if (turns >= this.settings.maxTurns) return;
    await this.client.lPush(this.key('input'), text);
  }

  async getTurns(): Promise<number> {
    if (!this.client) return 0;
    const t = await this.client.get(this.key('turns'));
    return t ? parseInt(t, 10) : 0;
  }

  async incrTurns(): Promise<number> {
    if (!this.client) return 0;
    return this.client.incr(this.key('turns'));
  }

  /**
   * After Claude replies: push to `out`, optionally to peer's `input`, increment turns.
   */
  async deliverClaudeReply(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: 'redis not connected' };
    try {
      const turns = await this.getTurns();
      if (turns >= this.settings.maxTurns) {
        return { ok: true };
      }
      await this.client.lPush(this.key('out'), text);
      if (this.settings.peerInstanceId) {
        await this.client.lPush(this.peerInputKey(this.settings.peerInstanceId), text);
      }
      await this.incrTurns();
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async pollOnce(): Promise<InboundMessage | null> {
    if (!this.client) return null;
    const turns = await this.getTurns();
    if (turns >= this.settings.maxTurns) {
      return null;
    }
    const input = await this.client.rPop(this.key('input'));
    if (!input) return null;
    const chatId = `la:${this.base}:${this.instanceId}`;
    const mirror = this.getMirrorChatId?.() ?? null;
    return {
      messageId: crypto.randomUUID(),
      address: {
        channelType: this.instanceId === 'default' ? this.base : `${this.base}:${this.instanceId}`,
        chatId,
        userId: `localagent-${this.base}-${this.instanceId}`,
        displayName: `LocalAgent ${this.base}/${this.instanceId}`,
      },
      text: input,
      timestamp: Date.now(),
      deliverySource: 'local-agent',
      outboundChatId: mirror ?? undefined,
    };
  }

  get syntheticChatId(): string {
    return `la:${this.base}:${this.instanceId}`;
  }

  get pollSessionId(): string {
    return this.sessionId;
  }
}

/**
 * Shared inbound poll loop for IM adapters in Local Agent mode.
 */
export async function runRedisLocalInboundLoop(
  transport: RedisLocalTransport,
  adapterChannelType: string,
  enqueue: (msg: InboundMessage) => void,
  isRunning: () => boolean,
  onMaxTurnsReached: () => Promise<void>,
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
      enqueue(msg);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      console.warn(
        '[redis-local-transport] poll error:',
        err instanceof Error ? err.message : err,
      );
      if (isRunning()) await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
