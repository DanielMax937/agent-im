import test from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../lib/bridge/context';
import { DiscordAdapter } from '../lib/bridge/adapters/discord-adapter';
import { _testOnly as bridgeManagerTestOnly } from '../lib/bridge/bridge-manager';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  LLMProvider,
  StreamChatParams,
} from '../lib/bridge/host';
import type { ChannelBinding, ChannelType } from '../lib/bridge/types';

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    workingDirectory: string;
    model: string;
    runnerProfileId?: string;
  }): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const now = new Date().toISOString();
    const binding: ChannelBinding = existing
      ? { ...existing, ...data, updatedAt: now }
      : {
          id: `binding-${this.nextId++}`,
          sdkSessionId: '',
          mode: 'code',
          active: true,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates, updatedAt: new Date().toISOString() });
        return;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter((binding) => binding.channelType === channelType) : all;
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    _systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session = {
      id: `session-${this.nextId++}`,
      working_directory: cwd || '/tmp',
      model,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId(): void {}
  addMessage(sessionId: string, role: string, content: string): void {
    const messages = this.messages.get(sessionId) ?? [];
    messages.push({ role, content });
    this.messages.set(sessionId, messages);
  }
  getMessages(sessionId: string): { messages: BridgeMessage[] } {
    return { messages: this.messages.get(sessionId) ?? [] };
  }
  acquireSessionLock(): boolean { return true; }
  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(): void {}
  updateSdkSessionId(): void {}
  updateSessionModel(): void {}
  syncSdkTasks(): void {}
  getProvider() { return undefined; }
  getDefaultProviderId(): string | null { return null; }
  insertAuditLog(): void {}
  checkDedup(): boolean { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved(): boolean { return false; }
  listPendingPermissionLinksByChat(): [] { return []; }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

class NoopLLM implements LLMProvider {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
}

test('Discord slash /runner switches binding runner and recreates session', async () => {
  const store = new InMemoryStore();
  store.setSetting('bridge_discord_enabled', 'true');
  store.setSetting('bridge_discord_bot_token', 'discord-test-token');
  store.setSetting('bridge_discord_allowed_channels', 'chan-1');
  store.setSetting('bridge_default_work_dir', '/repo');

  initBridgeContext({
    store,
    llm: new NoopLLM(),
    permissions: { resolvePendingPermission: () => true },
    lifecycle: {},
    getRunnerConfigsForChannelType: () => [
      { id: 'runner-a', runtime: 'cursor', label: 'Runner A' },
      { id: 'runner-b', runtime: 'codex', label: 'Runner B' },
    ],
    getDefaultRunnerIdForChannelType: () => 'runner-a',
  });

  const adapter = new DiscordAdapter('default');
  (adapter as any).client = {};
  const interactionReplies: Array<{ content?: string }> = [];

  const interaction = {
    id: 'interaction-1',
    channelId: 'chan-1',
    guild: null,
    user: { id: 'user-1', username: 'discord-user' },
    commandName: 'runner',
    options: {
      getString(name: string): string | null {
        if (name === 'profile') return 'runner-b';
        return null;
      },
    },
    async deferReply() {},
    async editReply(payload: { content?: string }) {
      interactionReplies.push(payload);
    },
    async reply(payload: { content?: string }) {
      interactionReplies.push(payload);
    },
    async followUp(payload: { content?: string }) {
      interactionReplies.push(payload);
    },
  };

  await (adapter as any).handleSlashCommand(interaction);
  const inbound = await adapter.consumeOne();
  assert.ok(inbound);
  assert.equal(inbound.text, '/runner runner-b');
  assert.equal(inbound.address.chatId, 'chan-1');

  const before = store.getChannelBinding('discord', 'chan-1');
  assert.equal(before, null);

  await bridgeManagerTestOnly.handleMessage(adapter, inbound);

  const updated = store.getChannelBinding('discord', 'chan-1');
  assert.ok(updated);
  assert.equal(updated.runnerProfileId, 'runner-b');
  assert.notEqual(updated.codepilotSessionId, '');
  assert.ok(
    interactionReplies.some((reply) => reply.content?.includes('Runner updated')),
    `slash command should receive a runner update reply: ${JSON.stringify(interactionReplies)}`,
  );
  assert.ok(
    interactionReplies.some((reply) => reply.content?.includes('New conversation started')),
    `runner switch should recreate the session when the effective runner changes: ${JSON.stringify(interactionReplies)}`,
  );

  for (const timer of (adapter as any).slashCleanupTimers.values()) {
    clearTimeout(timer);
  }
});
