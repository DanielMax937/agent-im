/**
 * Discord Adapter — implements BaseChannelAdapter for Discord Bot API.
 *
 * Uses discord.js v14 Client with Gateway intents for real-time message
 * consumption, and REST API for message sending. Routes messages through
 * an internal async queue (same pattern as Telegram and Feishu).
 *
 * IMPORTANT: discord.js is loaded via dynamic import() to avoid Next.js
 * bundler trying to resolve native modules (zlib-sync, bufferutil) at
 * build time. All discord.js types are referenced via `any` at the class
 * level and resolved at runtime in start().
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
import { loadConfig, normalizeRunnersForChannelType, resolveAutoRedisBridgeSlug } from '../../../config';
import {
  isAutoModeIntentEnabled,
  readAutoModeSettings,
  AutoModeRedisTransport,
  runAutoModeRedisInboundLoop,
} from '../redis-local-transport';
import { buildDiscordRestProxyAgent, configureDiscordGatewayProxy } from '../discord-ws-proxy';

/** Max number of message IDs to keep for dedup. */
const DEDUP_MAX = 1000;

/** Discord message character limit. */
const DISCORD_CHAR_LIMIT = 2000;

/** Default max attachment download size (20 MB). */
const DEFAULT_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/** Typing indicator interval (8s, Discord typing lasts ~10s). */
const TYPING_INTERVAL_MS = 8000;

/** Interaction TTL for answerCallback (60s). */
const INTERACTION_TTL_MS = 60_000;

/**
 * Lazily loaded discord.js module reference.
 * Populated in start() via dynamic import to avoid bundler issues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let discordJs: any = null;

async function loadDiscordJs() {
  if (!discordJs) {
    discordJs = await import('discord.js');
  }
  return discordJs;
}

export class DiscordAdapter extends BaseChannelAdapter {
  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Set<string>();
  private botUserId: string | null = null;

  constructor(instanceId = 'default') {
    super('discord', instanceId);
  }

  private d(key: string): string | null {
    return imScopedGet(getBridgeContext().store, 'discord', this.instanceId, key);
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Temporary storage for Interaction objects (for answerCallback). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingInteractions = new Map<string, { interaction: any; expiresAt: number }>();
  /** Preview: store message IDs per chat for edit-based streaming. */
  private previewMessages = new Map<string, string>();
  /** Chats where preview has permanently failed. */
  private previewDegraded = new Set<string>();

  private autoModeRedis: AutoModeRedisTransport | null = null;

  /**
   * Deferred slash-command interactions: first outbound chunk uses editReply,
   * further chunks use followUp (see delivery-layer chunking).
   */
  private pendingSlashReplyByChatId = new Map<
    string,
    { interaction: any; phase: 'edit' | 'followup' }
  >();
  private slashCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const store = getBridgeContext().store;
    const la = readAutoModeSettings(store, 'discord', this.instanceId);
    if (la) {
      const configError = this.validateConfig();
      if (configError) {
        console.warn('[discord-adapter] Cannot start (auto mode):', configError);
        return;
      }
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
      this.autoModeRedis = new AutoModeRedisTransport(
        this.channelType,
        la,
        resolveAutoRedisBridgeSlug(cfg),
        masterRunnerIds,
        slaveRunnerId,
      );
      try {
        await this.autoModeRedis.connect();
        await this.autoModeRedis.seedFirstPromptIfNeeded();
      } catch (err) {
        console.error('[discord-adapter] Auto mode Redis failed:', err);
        this.autoModeRedis = null;
        return;
      }
      this.running = true;
      this.autoModeRedisPollLoop().catch((err) => {
        console.error('[discord-adapter] Redis poll loop error:', err);
      });
      console.log(`[discord-adapter] Auto mode (Redis-only), instance=${this.instanceId}`);
      return;
    }

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[discord-adapter] Cannot start:', configError);
      return;
    }

    const token = this.d('bridge_discord_bot_token') || '';

    const cfg = loadConfig();
    configureDiscordGatewayProxy(cfg.proxy);

    // Dynamic import to avoid bundler resolving native modules
    const djs = await loadDiscordJs();
    const { Client, GatewayIntentBits, Partials } = djs;

    const restProxyAgent = buildDiscordRestProxyAgent(cfg.proxy);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      ...(restProxyAgent ? { rest: { agent: restProxyAgent } } : {}),
    });

    // Register event handlers before login
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('messageCreate', (message: any) => {
      this.handleMessageCreate(message).catch((err: unknown) => {
        console.error('[discord-adapter] messageCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('interactionCreate', (interaction: any) => {
      this.handleInteraction(interaction).catch((err: unknown) => {
        console.error('[discord-adapter] interactionCreate error:', err instanceof Error ? err.message : err);
      });
    });

    // Login and wait for ready
    await this.client.login(token);

    // Wait for the ready event
    await new Promise<void>((resolve) => {
      if (this.client!.isReady()) {
        resolve();
      } else {
        this.client!.once('ready', () => resolve());
      }
    });

    this.botUserId = this.client.user?.id || null;
    this.running = true;

    this.registerSlashCommands().catch((err: unknown) => {
      console.warn(
        '[discord-adapter] Slash command registration failed:',
        err instanceof Error ? err.message : err,
      );
    });

    console.log('[discord-adapter] Started (botUserId:', this.botUserId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.autoModeRedis) {
      await this.autoModeRedis.disconnect();
      this.autoModeRedis = null;
    }

    // Destroy client
    if (this.client) {
      try {
        this.client.destroy();
      } catch (err) {
        console.warn('[discord-adapter] Client destroy error:', err instanceof Error ? err.message : err);
      }
      this.client = null;
    }
    configureDiscordGatewayProxy(undefined);

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

    // Clear state
    this.seenMessageIds.clear();
    this.pendingInteractions.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();

    for (const t of this.slashCleanupTimers.values()) {
      clearTimeout(t);
    }
    this.slashCleanupTimers.clear();
    this.pendingSlashReplyByChatId.clear();

    console.log('[discord-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Register slash commands with Discord (mirrors Telegram setMyCommands list).
   * Uses guild registration when `bridge_discord_slash_guild_id` is set (faster propagation);
   * otherwise global commands (can take up to ~1h to appear everywhere).
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.application?.id) return;
    const token = this.d('bridge_discord_bot_token');
    if (!token) return;

    const djs = await loadDiscordJs();
    const { SlashCommandBuilder, REST, Routes } = djs;
    const rest = new REST({ version: '10' }).setToken(token);
    const clientId = this.client.application.id;

    /* eslint-disable @typescript-eslint/no-explicit-any -- discord.js SlashCommandBuilder option chain */
    const builders = [
      new SlashCommandBuilder()
        .setName('start')
        .setDescription('Show welcome and command list'),
      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Start new session (optionally specify path)')
        .addStringOption((o: any) =>
          o.setName('path').setDescription('Working directory (absolute path, optional)').setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName('autostop')
        .setDescription('Stop both master and slave tasks (auto mode)'),
      new SlashCommandBuilder()
        .setName('bind')
        .setDescription('Bind to an existing session')
        .addStringOption((o: any) => o.setName('session_id').setDescription('Session ID').setRequired(true)),
      new SlashCommandBuilder()
        .setName('cwd')
        .setDescription('Change working directory')
        .addStringOption((o: any) => o.setName('path').setDescription('Absolute path').setRequired(true)),
      new SlashCommandBuilder()
        .setName('mode')
        .setDescription('Switch mode: plan / code / ask')
        .addStringOption((o: any) =>
          o
            .setName('mode')
            .setDescription('Mode')
            .setRequired(true)
            .addChoices(
              { name: 'plan', value: 'plan' },
              { name: 'code', value: 'code' },
              { name: 'ask', value: 'ask' },
            ),
        ),
      new SlashCommandBuilder()
        .setName('runner')
        .setDescription('List or switch LLM runner for this chat')
        .addStringOption((o: any) =>
          o.setName('profile').setDescription('Runner profile id, or default').setRequired(false),
        ),
      new SlashCommandBuilder().setName('status').setDescription('Show current session status'),
      new SlashCommandBuilder().setName('sessions').setDescription('List recent sessions'),
      new SlashCommandBuilder().setName('stop').setDescription('Stop the current task'),
      new SlashCommandBuilder()
        .setName('perm')
        .setDescription('Respond to a permission request')
        .addStringOption((o: any) =>
          o
            .setName('action')
            .setDescription('Permission action')
            .setRequired(true)
            .addChoices(
              { name: 'allow', value: 'allow' },
              { name: 'allow_session', value: 'allow_session' },
              { name: 'deny', value: 'deny' },
            ),
        )
        .addStringOption((o: any) =>
          o.setName('permission_id').setDescription('Permission ID').setRequired(true),
        ),
      new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
    ];
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const body = builders.map((b: { toJSON: () => object }) => b.toJSON());
    const guildId = this.d('bridge_discord_slash_guild_id')?.trim();
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
    }
    console.log(
      `[discord-adapter] Slash commands registered (${guildId ? `guild ${guildId}` : 'global'})`,
    );
  }

  private scheduleSlashDeliveryCleanup(chatId: string): void {
    const prev = this.slashCleanupTimers.get(chatId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pendingSlashReplyByChatId.delete(chatId);
      this.slashCleanupTimers.delete(chatId);
    }, 8000);
    this.slashCleanupTimers.set(chatId, t);
  }

  /** Map Discord slash invocation to the same `/command …` text the bridge expects. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildSlashCommandText(interaction: any): string {
    const name = interaction.commandName as string;
    const opts = interaction.options;
    switch (name) {
      case 'new': {
        const path = opts.getString('path')?.trim();
        return path ? `/new ${path}` : '/new';
      }
      case 'bind': {
        const sid = opts.getString('session_id', true);
        return `/bind ${sid}`;
      }
      case 'cwd': {
        const p = opts.getString('path', true);
        return `/cwd ${p}`;
      }
      case 'mode': {
        const m = opts.getString('mode', true);
        return `/mode ${m}`;
      }
      case 'runner': {
        const profile = opts.getString('profile')?.trim();
        return profile ? `/runner ${profile}` : '/runner';
      }
      case 'perm': {
        const action = opts.getString('action', true);
        const permId = opts.getString('permission_id', true);
        return `/perm ${action} ${permId}`;
      }
      case 'start':
      case 'autostop':
      case 'status':
      case 'sessions':
      case 'stop':
      case 'help':
        return `/${name}`;
      default:
        return '';
    }
  }

  private async autoModeRedisPollLoop(): Promise<void> {
    const rt = this.autoModeRedis;
    if (!rt) return;
    await runAutoModeRedisInboundLoop(
      rt,
      this.channelType,
      (msg) => this.enqueue(msg),
      () => this.running,
      async () => {
        console.log(`[discord-adapter] Local agent max turns (${this.instanceId})`);
        await this.stop();
      },
    );
  }

  // ── Typing indicator ───────────────────────────────────────

  onMessageStart(chatId: string): void {
    if (this.autoModeRedis) return;
    this.stopTyping(chatId);
    if (!this.client) return;

    const sendTyping = () => {
      const channel = this.client?.channels.cache.get(chatId);
      if (channel && 'sendTyping' in channel) {
        channel.sendTyping().catch(() => {});
      }
    };

    // Send immediately
    sendTyping();

    // Repeat every 8s
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.typingIntervals.set(chatId, interval);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.autoModeRedis) {
      // Redis-only slave: skip duplicate Redis write — hybridDuplicateAssistantToRedis handles it
      return { ok: true, messageId: crypto.randomUUID() };
    }

    const pending = this.pendingSlashReplyByChatId.get(message.address.chatId);
    if (pending && this.client) {
      try {
        const payload = this.buildDiscordPayload(message);
        const { interaction } = pending;
        if (pending.phase === 'edit') {
          await interaction.editReply(payload);
          pending.phase = 'followup';
        } else {
          await interaction.followUp(payload);
        }
        this.scheduleSlashDeliveryCleanup(message.address.chatId);
        return { ok: true, messageId: interaction.id };
      } catch (err) {
        try {
          const msg = err instanceof Error ? err.message : 'Send failed';
          if (pending.phase === 'edit') {
            await pending.interaction.editReply({ content: `Failed to deliver: ${msg.slice(0, 500)}` });
          }
        } catch {
          /* ignore */
        }
        this.pendingSlashReplyByChatId.delete(message.address.chatId);
        return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
      }
    }

    if (!this.client) {
      return { ok: false, error: 'Discord client not initialized' };
    }

    let channel = this.client.channels.cache.get(message.address.chatId);
    if (!channel || !('send' in channel)) {
      // Try fetching the channel if not in cache
      try {
        channel = await this.client.channels.fetch(message.address.chatId);
        if (!channel || !('send' in channel)) {
          return { ok: false, error: 'Channel not found or not sendable' };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Channel fetch failed' };
      }
    }

    return this.sendToChannel(channel, message);
  }

  /** Shared payload for channel.send vs slash editReply/followUp. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildDiscordPayload(message: OutboundMessage): { content: string; components?: any[] } {
    let text = message.text;
    if (message.parseMode === 'HTML') {
      text = this.htmlToDiscordMarkdown(text);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: { content: string; components?: any[] } = {
      content: text.slice(0, DISCORD_CHAR_LIMIT),
    };
    if (message.inlineButtons && message.inlineButtons.length > 0 && discordJs) {
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discordJs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = [];
      for (const row of message.inlineButtons) {
        const actionRow = new ActionRowBuilder();
        for (const btn of row) {
          actionRow.addComponents(
            new ButtonBuilder()
              .setCustomId(btn.callbackData)
              .setLabel(btn.text)
              .setStyle(ButtonStyle.Primary),
          );
        }
        rows.push(actionRow);
      }
      options.components = rows;
    }
    return options;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sendToChannel(channel: any, message: OutboundMessage): Promise<SendResult> {
    try {
      const options = this.buildDiscordPayload(message);
      const sent = await channel.send(options);
      return { ok: true, messageId: sent.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const entry = this.pendingInteractions.get(callbackQueryId);
    if (!entry) return;

    this.pendingInteractions.delete(callbackQueryId);

    try {
      const interaction = entry.interaction;
      if (interaction.isButton() && !interaction.replied) {
        await interaction.editReply({ content: text || 'OK' });
      }
    } catch {
      // Interaction may have expired — non-critical
    }
  }

  // ── Streaming preview ──────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    if (readAutoModeSettings(getBridgeContext().store, 'discord', this.instanceId)) return null;
    // Global kill switch
    if (this.d('bridge_discord_stream_enabled') === 'false') return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (this.autoModeRedis) return 'skip';
    if (!this.client) return 'skip';

    const existingMsgId = this.previewMessages.get(chatId);

    try {
      if (existingMsgId) {
        // Edit existing preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('messages' in channel)) return 'skip';

        const msg = await channel.messages.fetch(existingMsgId);
        await msg.edit(text.slice(0, DISCORD_CHAR_LIMIT));
        return 'sent';
      } else {
        // Send new preview message
        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('send' in channel)) return 'skip';

        const sent = await channel.send(text.slice(0, DISCORD_CHAR_LIMIT));
        this.previewMessages.set(chatId, sent.id);
        return 'sent';
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.httpStatus;
      if (code === 403 || code === 404) {
        this.previewDegraded.add(chatId);
        return 'degrade';
      }
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number): void {
    const msgId = this.previewMessages.get(chatId);
    if (msgId && this.client) {
      // Delete the preview message — the final response replaces it
      const channel = this.client.channels.cache.get(chatId);
      if (channel && 'messages' in channel) {
        channel.messages.fetch(msgId).then((msg: { delete: () => void }) => msg.delete()).catch(() => {});
      }
    }
    this.previewMessages.delete(chatId);
  }

  override async recordAutoModeSlaveTurnCompleted(): Promise<void> {
    if (!this.autoModeRedis) return;
    await this.autoModeRedis.incrSlaveResponseCount();
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = this.d('bridge_discord_enabled');
    if (enabled !== 'true') return 'bridge_discord_enabled is not true';

    const store = getBridgeContext().store;
    if (isAutoModeIntentEnabled(store, 'discord', this.instanceId)) {
      if (!readAutoModeSettings(store, 'discord', this.instanceId)) {
        return 'auto mode enabled but bridge_discord_auto_redis_url is required';
      }
      return null;
    }

    const token = this.d('bridge_discord_bot_token');
    if (!token) return 'bridge_discord_bot_token not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (this.autoModeRedis) return true;
    const allowedUsers = this.d('bridge_discord_allowed_users') || '';
    const allowedChannels = this.d('bridge_discord_allowed_channels') || '';

    // If both are empty, deny all (security-first, default-deny)
    if (!allowedUsers && !allowedChannels) return false;

    const users = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    const channels = allowedChannels.split(',').map(s => s.trim()).filter(Boolean);

    // If users list is configured, check if user is in it
    if (users.length > 0 && users.includes(userId)) return true;

    // If channels list is configured, check if chat is in it
    if (channels.length > 0 && channels.includes(chatId)) return true;

    // If only one list is configured and the other is empty, check only the configured one
    if (users.length > 0 && channels.length === 0) return false;
    if (channels.length > 0 && users.length === 0) return false;

    return false;
  }

  // ── Incoming event handlers ────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessageCreate(message: any): Promise<void> {
    try {
      await this.processMessage(message);
    } catch (err) {
      console.error(
        '[discord-adapter] Unhandled error in message handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processMessage(message: any): Promise<void> {
    // Filter out bot messages (including self)
    if (message.author.bot) return;
    if (this.botUserId && message.author.id === this.botUserId) return;

    // Dedup by message ID
    if (this.seenMessageIds.has(message.id)) return;
    this.addToDedup(message.id);

    const chatId = message.channelId;
    const userId = message.author.id;
    const displayName = message.author.username || message.author.id;
    const isGuild = !!message.guild;

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) return;

    // Guild (server) message policy
    if (isGuild) {
      const allowedGuilds = (this.d('bridge_discord_allowed_guilds') || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      if (allowedGuilds.length > 0 && !allowedGuilds.includes(message.guild!.id)) {
        return;
      }

      const policy = this.d('bridge_discord_group_policy') || 'open';

      if (policy === 'disabled') {
        return;
      }

      // Require @mention check
      const requireMention = this.d('bridge_discord_require_mention') === 'true';
      if (requireMention && this.botUserId) {
        // Check both user @mention and role @mention (bot's managed role)
        const userMentioned = message.mentions.users.has(this.botUserId);
        const botMember = message.guild?.members?.cache?.get(this.botUserId);
        const botRoles = botMember?.roles?.cache;
        const roleMentioned = botRoles
          ? message.mentions.roles.some((r: { id: string }) => botRoles.has(r.id))
          : false;
        // Also check raw content for <@botId> or <@&roleId> patterns
        const rawContentMention = message.content?.includes(`<@${this.botUserId}>`)
          || message.content?.includes(`<@!${this.botUserId}>`);
        const mentioned = userMentioned || roleMentioned || rawContentMention;
        if (!mentioned) {
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: this.channelType,
              chatId,
              direction: 'inbound',
              messageId: message.id,
              summary: '[FILTERED] Guild message dropped: bot not @mentioned (require_mention=true)',
            });
          } catch { /* best effort */ }
          return;
        }
      }
    }

    // Extract text content
    let text = message.content || '';

    // Strip bot user mention and bot role mention from text
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }
    // Strip bot's managed role mentions
    if (message.guild && this.botUserId) {
      const botMember = message.guild.members?.cache?.get(this.botUserId);
      if (botMember?.roles?.cache) {
        for (const [roleId] of botMember.roles.cache) {
          text = text.replace(new RegExp(`<@&${roleId}>`, 'g'), '').trim();
        }
      }
    }

    // Normalize ! commands to / commands
    if (text.startsWith('!')) {
      text = '/' + text.slice(1);
    }

    // Handle attachments (images)
    const attachments: FileAttachment[] = [];
    const imageEnabled = this.d('bridge_discord_image_enabled') !== 'false';
    const maxSize = parseInt(this.d('bridge_discord_max_attachment_size') || '', 10) || DEFAULT_MAX_ATTACHMENT_SIZE;

    if (imageEnabled && message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        if (!attachment.contentType?.startsWith('image/')) continue;
        if (attachment.size > maxSize) {
          console.warn(`[discord-adapter] Attachment too large (${attachment.size} > ${maxSize}), skipping`);
          continue;
        }

        try {
          const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;

          const buffer = Buffer.from(await res.arrayBuffer());
          const base64 = buffer.toString('base64');
          const id = crypto.randomUUID();

          attachments.push({
            id,
            name: attachment.name || `image.${attachment.contentType?.split('/')[1] || 'png'}`,
            type: attachment.contentType || 'image/png',
            size: buffer.length,
            data: base64,
          });
        } catch (err) {
          console.warn('[discord-adapter] Attachment download failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    const address = {
      channelType: this.channelType,
      chatId,
      userId,
      displayName,
    };

    const inbound: InboundMessage = {
      messageId: message.id,
      address,
      text: text.trim(),
      timestamp: message.createdTimestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        chatId,
        direction: 'inbound',
        messageId: message.id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleInteraction(interaction: any): Promise<void> {
    if (interaction.isChatInputCommand?.()) {
      await this.handleSlashCommand(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    try {
      // Defer immediately to avoid 3s timeout
      await interaction.deferUpdate();
    } catch {
      // Interaction may already be handled
      return;
    }

    const callbackData = interaction.customId;
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) return;

    // Store interaction for answerCallback with TTL
    const interactionId = `discord-${interaction.id}`;
    this.pendingInteractions.set(interactionId, {
      interaction,
      expiresAt: Date.now() + INTERACTION_TTL_MS,
    });

    // Clean up expired interactions
    this.cleanupExpiredInteractions();

    const inbound: InboundMessage = {
      messageId: interactionId,
      address: {
        channelType: this.channelType,
        chatId,
        userId,
        displayName,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId: interaction.message?.id,
    };

    this.enqueue(inbound);
  }

  /**
   * Discord slash commands → same `/cmd` text as Telegram; bridge-manager handleCommand handles the rest.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleSlashCommand(interaction: any): Promise<void> {
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username || interaction.user.id;

    if (!this.isAuthorized(userId, chatId)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
      return;
    }

    if (interaction.guild) {
      const allowedGuilds = (this.d('bridge_discord_allowed_guilds') || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (allowedGuilds.length > 0 && !allowedGuilds.includes(interaction.guild.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
        return;
      }
      const policy = this.d('bridge_discord_group_policy') || 'open';
      if (policy === 'disabled') {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
        return;
      }
      // require_mention applies to plain messages; slash invocation is explicit — do not block here
    }

    const text = this.buildSlashCommandText(interaction);
    if (!text) {
      await interaction.reply({ content: 'Unknown command.', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      await interaction.deferReply();
    } catch {
      return;
    }

    this.pendingSlashReplyByChatId.set(chatId, { interaction, phase: 'edit' });
    this.scheduleSlashDeliveryCleanup(chatId);

    const inbound: InboundMessage = {
      messageId: interaction.id,
      address: {
        channelType: this.channelType,
        chatId,
        userId,
        displayName,
      },
      text,
      timestamp: Date.now(),
    };

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        chatId,
        direction: 'inbound',
        messageId: interaction.id,
        summary: `[slash] ${text.slice(0, 200)}`,
      });
    } catch {
      /* best effort */
    }

    this.enqueue(inbound);
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.add(messageId);

    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const id of this.seenMessageIds) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(id);
        removed++;
      }
    }
  }

  private cleanupExpiredInteractions(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingInteractions) {
      if (entry.expiresAt < now) {
        this.pendingInteractions.delete(id);
      }
    }
  }

  /**
   * Convert simple HTML tags to Discord markdown.
   * Handles the common tags used in bridge-manager command responses.
   */
  private htmlToDiscordMarkdown(html: string): string {
    return html
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<i>(.*?)<\/i>/gi, '*$1*')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''); // Strip remaining HTML tags
  }
}

// Self-register so bridge-manager can create DiscordAdapter via the registry.
registerAdapterFactory('discord', (instanceId: string) => new DiscordAdapter(instanceId));
