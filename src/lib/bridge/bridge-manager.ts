/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type {
  BridgeStatus,
  ChannelBinding,
  ChannelAddress,
  InboundMessage,
  SendResult,
  OutboundMessage,
  StreamingPreviewState,
} from './types';
import type { BridgeStore } from './host';
import { createAdapter, getRegisteredTypes } from './channel-adapter';
import type { BaseChannelAdapter } from './channel-adapter';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index';
import * as router from './channel-router';
import * as engine from './conversation-engine';
import * as broker from './permission-broker';
import { deliver, deliverRendered } from './delivery-layer';
import { markdownToTelegramChunks } from './markdown/telegram';
import { markdownToDiscordChunks } from './markdown/discord';
import { getBridgeContext } from './context';
import { escapeHtml } from './adapters/telegram-utils';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators';
import { startBridgeDaemonChild } from '../bridge-app-child';
import { getLogger } from '../../logger';
import {
  listInstanceIdsForChannel,
  isInstanceImEnabled,
  resolveRunnerForChannelBinding,
  parseImBaseAndInstanceId,
  resolveAutoSlaveRunnerId,
  type ImBaseChannel,
} from './im-instance-settings';
import { isHybridAutoModeEnabled, readAutoModeSettings } from './redis-local-transport';
import { loadConfig, normalizeRunnersForChannelType, resolveAutoRedisBridgeSlug } from '../../config';
import { startSlaveProcess, stopSlaveProcess } from './slave-process';
const GLOBAL_KEY = '__bridge_manager__';

function effectiveInboundAddress(msg: InboundMessage): ChannelAddress {
  if (msg.outboundChatId) {
    return { ...msg.address, chatId: msg.outboundChatId };
  }
  return msg.address;
}

function effectiveInboundChatId(msg: InboundMessage): string {
  return msg.outboundChatId ?? msg.address.chatId;
}

function effectiveReplyToMessageId(msg: InboundMessage): string | undefined {
  // Auto-mode master/slave messages are synthesized from Redis queues. Their
  // `messageId` values are bridge-local IDs, not real Telegram message IDs, so
  // mirroring them back as replies can thread onto unrelated messages.
  if (msg.deliverySource === 'master' || msg.deliverySource === 'slave') {
    return undefined;
  }
  return msg.messageId;
}

/** Match {@link redis-local-transport} queue encoding for outbound chat segments. */
function encodeAutoChatSegment(chatId: string): string {
  return encodeURIComponent(chatId);
}

/**
 * Hybrid Telegram Auto: `/cwd` updates the IM chat binding; Redis master/slave turns use
 * synthetic `auto:*` addresses. Mirror the working directory there and restart the slave
 * child so `CTI_DEFAULT_WORKDIR` matches.
 */
async function syncHybridAutoModeSyntheticWorkingDirectory(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  workingDirectory: string,
): Promise<void> {
  const { store } = getBridgeContext();
  const parsed = parseImBaseAndInstanceId(adapter.channelType);
  if (!parsed) return;
  if (!isHybridAutoModeEnabled(store, parsed.base, parsed.instanceId)) return;

  const mirrorChat = effectiveInboundChatId(msg);
  if (mirrorChat.startsWith('auto:')) {
    getLogger().info(
      {
        event: 'cwd_hybrid_skip_sync',
        reason: 'synthetic_chat_id',
        chatId: mirrorChat,
      },
      '[bridge] /cwd hybrid sync skipped (no real IM chat id)',
    );
    return;
  }

  const cfg = loadConfig();
  const bridgeSlug = resolveAutoRedisBridgeSlug(cfg);
  const channelType = adapter.channelType;
  const masterRows = normalizeRunnersForChannelType(cfg, channelType);
  const masterIds = masterRows.map((r) => r.id);
  const masterRid = masterIds[0] ?? 'default';
  const defaultRunner = getBridgeContext().getDefaultRunnerIdForChannelType?.(channelType);
  const slaveRunnerId = resolveAutoSlaveRunnerId(
    store,
    channelType,
    defaultRunner,
    cfg.imBot?.autoSlaveRunner?.id,
  );

  const masterChatIdScoped = `auto:master:${bridgeSlug}:${channelType}:${encodeAutoChatSegment(mirrorChat)}:${masterRid}`;
  const slaveChatIdScoped = `auto:${bridgeSlug}:${channelType}:${encodeAutoChatSegment(mirrorChat)}:${slaveRunnerId}`;
  /** Same Redis transport when queue payload has no `outboundChatId` (see pollOnce / pollOnceMaster). */
  const masterChatIdShort = `auto:master:${bridgeSlug}:${channelType}:${masterRid}`;
  const slaveChatIdShort = `auto:${bridgeSlug}:${channelType}:${slaveRunnerId}`;

  const touch = (chatId: string, userId: string, displayName: string) => {
    const b = router.resolve({ channelType, chatId, userId, displayName });
    router.updateBinding(b.id, { workingDirectory });
  };

  touch(
    masterChatIdScoped,
    `automaster-${bridgeSlug}-${channelType}-${masterRid}`,
    'Auto master',
  );
  touch(
    slaveChatIdScoped,
    `autoslave-${bridgeSlug}-${channelType}-${slaveRunnerId}`,
    'Auto slave',
  );
  touch(
    masterChatIdShort,
    `automaster-${bridgeSlug}-${channelType}-${masterRid}`,
    'Auto master (short)',
  );
  touch(
    slaveChatIdShort,
    `autoslave-${bridgeSlug}-${channelType}-${slaveRunnerId}`,
    'Auto slave (short)',
  );

  getLogger().info(
    {
      event: 'cwd_hybrid_synced',
      mirrorChat,
      masterChatIdScoped,
      slaveChatIdScoped,
      masterChatIdShort,
      slaveChatIdShort,
      workingDirectory,
      instanceId: parsed.instanceId,
    },
    '[bridge] /cwd hybrid: synced auto master/slave bindings (scoped + short); restarting slave process',
  );

  try {
    await stopSlaveProcess(parsed.instanceId);
    startSlaveProcess(parsed.instanceId, { CTI_DEFAULT_WORKDIR: workingDirectory });
  } catch (err) {
    getLogger().warn(
      {
        event: 'slave_restart_after_cwd_failed',
        err: err instanceof Error ? err.message : String(err),
        instanceId: parsed.instanceId,
      },
      '[bridge] /cwd hybrid: slave restart failed (bindings were updated)',
    );
  }
}

function applyHybridDeliveryPrefix(adapter: BaseChannelAdapter, msg: InboundMessage, text: string): string {
  if (!msg.deliverySource) return text;
  const parsed = parseImBaseAndInstanceId(adapter.channelType);
  if (!parsed) return text;
  if (!isHybridAutoModeEnabled(getBridgeContext().store, parsed.base, parsed.instanceId)) {
    return text;
  }
  const prefix = msg.deliverySource === 'slave' ? '[slave]' : '[master]';
  return `${prefix}\n\n${text}`;
}

/** Runners for IM /runner for this adapter channel (per-bot list from config). */
function getImRunnerList(channelType: string): Array<{ id: string; runtime: string; label?: string }> {
  const { getRunnerConfigsForChannelType, imRunners } = getBridgeContext();
  const fromCfg = getRunnerConfigsForChannelType?.(channelType);
  if (fromCfg && fromCfg.length > 0) {
    return fromCfg.map((p) => ({
      id: p.id,
      runtime: p.runtime,
      label: p.label,
    }));
  }
  if (imRunners && imRunners.length > 0) {
    return [...imRunners];
  }
  return [{ id: 'default', runtime: 'claude' }];
}

/** Effective runner profile id for this chat (binding override, per-bot default, store default). */
function effectiveRunnerProfileId(binding: ChannelBinding, store: BridgeStore): string {
  const profiles = getImRunnerList(binding.channelType);
  const allIds = profiles.map((p) => p.id);
  const storeDefault = store.getSetting('bridge_default_runner_profile_id')?.trim() || undefined;
  const globalDef =
    getBridgeContext().getDefaultRunnerIdForChannelType?.(binding.channelType) ??
    storeDefault ??
    profiles[0]?.id ??
    'default';
  return resolveRunnerForChannelBinding(
    store,
    binding.channelType,
    binding.runnerProfileId,
    globalDef,
    allIds,
  );
}

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  deliverySource?: 'runner' | 'master' | 'slave',
  masterRunnerId?: string,
): Promise<SendResult> {
  if (adapter.baseChannelType === 'telegram') {
    if (deliverySource === 'slave' && adapter.hybridDuplicateAssistantToRedis) {
      await adapter.hybridDuplicateAssistantToRedis(responseText, deliverySource);
    }
    if (deliverySource === 'master' && adapter.hybridDuplicateMasterAssistantToRedis) {
      await adapter.hybridDuplicateMasterAssistantToRedis(
        responseText,
        masterRunnerId ?? 'default',
      );
    }
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.baseChannelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.baseChannelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate registered adapter factories — multiple instances per base channel (see CTI_IM_INSTANCES)
  for (const channelType of getRegisteredTypes()) {
    const instanceIds = listInstanceIdsForChannel(channelType, store);

    for (const instanceId of instanceIds) {
      if (!isInstanceImEnabled(store, channelType as ImBaseChannel, instanceId)) {
        continue;
      }

      const adapter = createAdapter(channelType, instanceId);
      if (!adapter) continue;

      const configError = adapter.validateConfig();
      if (!configError) {
        registerAdapter(adapter);
      } else {
        console.warn(
          `[bridge-manager] ${channelType} (${instanceId}) adapter not valid:`,
          configError,
        );
      }
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., IM startup message, suppress competing polling)
  await Promise.resolve(lifecycle.onBridgeStart?.());

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  startBridgeDaemonChild().catch((err: unknown) => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();
  const outAddr = effectiveInboundAddress(msg);
  const outChat = effectiveInboundChatId(msg);
  const replyToMessageId = effectiveReplyToMessageId(msg);

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  const previewLen = 200;
  const raw = msg.text;
  const preview =
    raw.length > previewLen ? `${raw.slice(0, previewLen)}…` : raw;
  getLogger().info(
    {
      event: 'inbound',
      channel: adapter.channelType,
      chatId: msg.address.chatId,
      messageId: msg.messageId,
      updateId: msg.updateId,
      hasCallback: Boolean(msg.callbackData),
      textLen: raw.length,
      attachmentCount: msg.attachments?.length ?? 0,
      preview,
      /** Auto mode: `master` / `slave` from Redis; plain IM is usually `runner` or omitted. */
      deliverySource: msg.deliverySource,
    },
    '[bridge] inbound message',
  );

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: outAddr,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: outAddr,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  const parsedLa = parseImBaseAndInstanceId(adapter.channelType);
  const autoModeSettings = parsedLa
    ? readAutoModeSettings(store, parsedLa.base, parsedLa.instanceId)
    : null;
  const autoModePipelineActive = autoModeSettings !== null;

  /** Hybrid Auto mode is Telegram-only: plain IM text is forwarded to Redis master input, then handled by the master loop. */
  const hybridImForwardOnly =
    parsedLa &&
    autoModeSettings &&
    isHybridAutoModeEnabled(store, parsedLa.base, parsedLa.instanceId) &&
    msg.deliverySource === 'runner' &&
    !hasAttachments;

  if (hybridImForwardOnly) {
    getLogger().info(
      {
        event: 'auto_mode_hybrid_forward',
        channel: adapter.channelType,
        chatId: msg.address.chatId,
      },
      '[bridge] auto mode hybrid: plain Telegram text queued to Redis master:input only (handled by master loop)',
    );
    ack();
    return;
  }

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(outChat);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  // Hybrid Auto slave: stream assistant text to the Telegram bot (sendPreview drafts) while the
  // LLM runs; Redis duplication (hybridDuplicateAssistantToRedis) still happens once on final
  // deliverResponse — unchanged.
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(outChat) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: outChat,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the onPartialText callback (or undefined if preview not supported)
  const onPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(
      binding,
      promptText,
      async (perm) => {
        await broker.forwardPermissionRequest(
          adapter,
          msg.address,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          replyToMessageId,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      {
        deliverySource: msg.deliverySource,
      },
    );

    const slaveSessionTimedOut =
      msg.deliverySource === 'slave' && result.slaveSessionTimedOut === true;

    if (slaveSessionTimedOut) {
      await adapter.handleSlaveSessionTimeoutReport({
        partialText: result.partialAssistantText ?? '',
        errorMessage: result.errorMessage?.trim() || 'Slave session wall-clock limit exceeded',
        outboundChatId: msg.outboundChatId,
      });
    } else if (msg.deliverySource === 'slave' && !result.hasError) {
      await adapter.recordAutoModeSlaveTurnCompleted?.();
    }

    if (
      result.hasError &&
      (msg.deliverySource === 'master' || msg.deliverySource === 'slave') &&
      !slaveSessionTimedOut
    ) {
      await adapter.recordAutoModeTurnFailed?.({
        source: msg.deliverySource,
        errorMessage: result.errorMessage,
        outboundChatId: msg.outboundChatId,
      });
    }

    // Send response text — render via channel-appropriate format
    if (slaveSessionTimedOut) {
      const noticePlain =
        'Slave session timed out (wall clock). A recoverable report was sent to the master runner.';
      const noticeTelegram =
        '<b>Slave session timed out</b> (wall clock). A recoverable report was sent to the master runner.';
      const notice =
        adapter.baseChannelType === 'telegram' ? noticeTelegram : noticePlain;
      await deliver(adapter, {
        address: outAddr,
        text: applyHybridDeliveryPrefix(adapter, msg, notice),
        parseMode: adapter.baseChannelType === 'telegram' ? 'HTML' : 'plain',
        replyToMessageId,
      });
    } else if (result.responseText) {
      await deliverResponse(
        adapter,
        outAddr,
        applyHybridDeliveryPrefix(adapter, msg, result.responseText),
        binding.codepilotSessionId,
        replyToMessageId,
        msg.deliverySource,
        msg.deliverySource === 'master' ? binding.runnerProfileId : undefined,
      );
      if (msg.deliverySource === 'master' && !result.hasError) {
        await adapter.afterAutoModeMasterTurn?.({
          userPrompt: promptText,
          responseText: result.responseText,
          outboundChatId: msg.outboundChatId,
        });
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: outAddr,
        text: applyHybridDeliveryPrefix(
          adapter,
          msg,
          `<b>Error:</b> ${escapeHtml(result.errorMessage?.trim() || 'Unknown error')}`,
        ),
        parseMode: 'HTML',
        replyToMessageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(outChat, previewState.draftId);
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(outChat);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: effectiveInboundAddress(msg),
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  const cmdOutAddr = effectiveInboundAddress(msg);

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/autostop - Stop both master and slave tasks',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/runner [id|default] - List or switch LLM runner for this chat',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      // Clear sdkSessionId to force a fresh Cursor/Claude session (not resume)
      router.updateBinding(binding.id, { sdkSessionId: '' });
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/autostop': {
      const parsedChannel = parseImBaseAndInstanceId(adapter.channelType);
      const autoActive = parsedChannel
        ? readAutoModeSettings(store, parsedChannel.base, parsedChannel.instanceId)
        : null;
      if (!autoActive) {
        response = 'Auto mode is not enabled. Nothing to stop.';
        break;
      }
      if (typeof adapter.stopAutoModeTasks !== 'function') {
        response = 'Auto mode stop is not supported for this channel.';
        break;
      }
      const st = getState();
      const result = await adapter.stopAutoModeTasks(st.activeTasks);
      if (!result) {
        response = 'Auto mode is not enabled. Nothing to stop.';
        break;
      }
      response = result;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        getLogger().info(
          {
            event: 'cwd_rejected',
            channel: adapter.channelType,
            chatId: msg.address.chatId,
            reason: 'validation_failed',
          },
          '[bridge] /cwd rejected: validateWorkingDirectory failed',
        );
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const cmdAddr = effectiveInboundAddress(msg);
      const binding = router.resolve(cmdAddr);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      getLogger().info(
        {
          event: 'cwd_set',
          channel: adapter.channelType,
          chatId: cmdAddr.chatId,
          bindingId: binding.id,
          path: validatedPath,
        },
        '[bridge] /cwd: updated IM channel binding working directory',
      );
      await syncHybridAutoModeSyntheticWorkingDirectory(adapter, msg, validatedPath);
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/runner':
    case '/runners': {
      const binding = router.resolve(msg.address);
      const profiles = getImRunnerList(binding.channelType);
      const storeDefault = store.getSetting('bridge_default_runner_profile_id')?.trim() || undefined;

      const rawArg = args.split(/\s+/)[0]?.trim() ?? '';
      const argLc = rawArg.toLowerCase();

      if (!rawArg) {
        const eff = effectiveRunnerProfileId(binding, store);
        const effMeta = profiles.find((p) => p.id === eff);
        const lines: string[] = [
          '<b>Runners (this chat)</b>',
          '',
          `Current profile: <code>${escapeHtml(eff)}</code>`,
        ];
        if (effMeta) {
          lines.push(
            `Backend: <b>${escapeHtml(effMeta.runtime)}</b>${effMeta.label ? ` (${escapeHtml(effMeta.label)})` : ''}`,
          );
        }
        lines.push(
          binding.runnerProfileId
            ? 'This chat overrides the default.'
            : `Using store default${storeDefault ? ` (<code>${escapeHtml(storeDefault)}</code>)` : ''}.`,
          '',
          '<b>Available for this bot:</b>',
        );
        if (profiles.length === 0) {
          lines.push('(none — 在管理页为该 bot 配置至少一个 Runner)');
        }
        for (const p of profiles) {
          const mark =
            p.id === storeDefault ? ' (server default)' : p.id === eff && !binding.runnerProfileId ? ' (effective)' : '';
          const lbl = p.label ? ` — ${escapeHtml(p.label)}` : '';
          lines.push(`• <code>${escapeHtml(p.id)}</code> — ${escapeHtml(p.runtime)}${lbl}${mark}`);
        }
        lines.push(
          '',
          'Use: <code>/runner &lt;profile_id&gt;</code>',
          'Reset to server default: <code>/runner default</code>',
        );
        response = lines.join('\n');
        break;
      }

      if (argLc === 'default' || argLc === 'reset') {
        const effBefore = effectiveRunnerProfileId(binding, store);
        router.updateBinding(binding.id, { runnerProfileId: undefined });
        const updated = router.resolve(msg.address);
        const effAfter = effectiveRunnerProfileId(updated, store);
        if (effBefore !== effAfter) {
          router.recreateBindingSession(updated);
        }
        response = [
          `Runner reset to server default (effective profile: <code>${escapeHtml(effAfter)}</code>).`,
          effBefore !== effAfter
            ? '\n\n<b>New conversation started</b> for this runner (previous CLI session cleared).'
            : '',
        ].join('');
        break;
      }

      const matched = profiles.find(
        (p) => p.id === rawArg || p.id.toLowerCase() === argLc,
      );
      if (!matched) {
        response = [
          `Unknown or not configured for this bot: <code>${escapeHtml(rawArg)}</code>.`,
          '',
          'Use <code>/runner</code> to list runners for this bot.',
        ].join('\n');
        break;
      }

      const effBefore = effectiveRunnerProfileId(binding, store);
      router.updateBinding(binding.id, { runnerProfileId: matched.id });
      const updatedRunner = router.resolve(msg.address);
      const effAfter = effectiveRunnerProfileId(updatedRunner, store);
      if (effBefore !== effAfter) {
        router.recreateBindingSession(updatedRunner);
      }
      response = [
        '<b>Runner updated</b>',
        '',
        `Profile: <code>${escapeHtml(matched.id)}</code>`,
        `Backend: <b>${escapeHtml(matched.runtime)}</b>${matched.label ? ` (${escapeHtml(matched.label)})` : ''}`,
        effBefore !== effAfter
          ? '\n\n<b>New conversation started</b> for this runner (previous CLI session cleared).'
          : '',
      ].join('\n');
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const profiles = getImRunnerList(binding.channelType);
      const eff = effectiveRunnerProfileId(binding, store);
      const effMeta = profiles.find((p) => p.id === eff);
      const runnerLine = effMeta
        ? `Runner: <code>${escapeHtml(eff)}</code> (${escapeHtml(effMeta.runtime)})`
        : `Runner: <code>${escapeHtml(eff)}</code>`;
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        runnerLine,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const parsedChannel = parseImBaseAndInstanceId(adapter.channelType);
      const hybridAuto =
        parsedChannel &&
        readAutoModeSettings(store, parsedChannel.base, parsedChannel.instanceId) &&
        isHybridAutoModeEnabled(store, parsedChannel.base, parsedChannel.instanceId);

      // Hybrid Auto: in-flight work is keyed by synthetic chat sessions, not the real Telegram
      // binding — delegate to the same abort path as /autostop.
      if (hybridAuto && typeof adapter.stopAutoModeTasks === 'function') {
        const autoResult = await adapter.stopAutoModeTasks(st.activeTasks);
        const realTask = st.activeTasks.get(binding.codepilotSessionId);
        if (realTask) {
          realTask.abort();
          st.activeTasks.delete(binding.codepilotSessionId);
        }
        response =
          autoResult ??
          (realTask ? 'Stopping current task...' : 'No task is currently running.');
        break;
      }

      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/autostop - Stop both master and slave tasks',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/runner [id|default] - List or switch LLM runner for this chat',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: cmdOutAddr,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
