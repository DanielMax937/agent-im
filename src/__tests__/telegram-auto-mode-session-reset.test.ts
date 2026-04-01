import test from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../lib/bridge/context';
import { TelegramAdapter } from '../lib/bridge/adapters/telegram-adapter';
import * as router from '../lib/bridge/channel-router';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  LLMProvider,
  StreamChatParams,
} from '../lib/bridge/host';
import type { ChannelBinding, ChannelType, InboundMessage } from '../lib/bridge/types';

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

test('Telegram auto-mode user message starts fresh master/slave sessions and replaces task summary', async () => {
  process.env.CTI_HOME = `/tmp/cti-test-${process.pid}-${Date.now()}`;

  const store = new InMemoryStore();
  store.setSetting('bridge_default_work_dir', '/repo');
  store.setSetting('bridge_telegram_local_agent_runner_id', 'slave-a');

  initBridgeContext({
    store,
    llm: new NoopLLM(),
    permissions: { resolvePendingPermission: () => true },
    lifecycle: {},
    getRunnerConfigsForChannelType: () => [
      { id: 'runner-a', runtime: 'cursor' },
      { id: 'slave-a', runtime: 'cursor' },
    ],
    getDefaultRunnerIdForChannelType: () => 'runner-a',
  });

  const adapter = new TelegramAdapter('default');
  const summaryWrites: string[] = [];
  const handoffs: string[] = [];

  const masterAddress = {
    channelType: 'telegram',
    chatId: 'auto:master:bridge-a:telegram:chat-1:runner-a',
    userId: 'automaster-bridge-a-telegram-runner-a',
    displayName: 'Auto master telegram/runner-a',
  };
  const slaveAddress = {
    channelType: 'telegram',
    chatId: 'auto:bridge-a:telegram:chat-1:slave-a',
    userId: 'autoslave-bridge-a-telegram-slave-a',
    displayName: 'Auto slave telegram/slave-a',
  };

  const masterBinding = router.resolve(masterAddress);
  const slaveBinding = router.resolve(slaveAddress);
  const originalMasterSession = masterBinding.codepilotSessionId;
  const originalSlaveSession = slaveBinding.codepilotSessionId;
  router.updateBinding(masterBinding.id, { sdkSessionId: 'sdk-master-old' });
  router.updateBinding(slaveBinding.id, { sdkSessionId: 'sdk-slave-old' });

  (adapter as unknown as {
    autoModeRedis: {
      bridgeSlug: string;
      buildSyntheticSlaveChatId: (outboundChatId?: string) => string;
      setSessionSummary: (summary: string) => Promise<void>;
      setLastUserRequest: (text: string) => Promise<void>;
      setReverifyPending: (pending: boolean) => Promise<void>;
      setSlaveBusy: (ttlSeconds?: number) => Promise<void>;
      pushSlaveHandoff: (text: string, outboundChatId?: string) => Promise<void>;
      incrMasterTurns: () => Promise<number>;
    };
  }).autoModeRedis = {
    bridgeSlug: 'bridge-a',
    buildSyntheticSlaveChatId: (outboundChatId?: string) =>
      outboundChatId ? `auto:bridge-a:telegram:${outboundChatId}:slave-a` : 'auto:bridge-a:telegram:slave-a',
    async setSessionSummary(summary: string) {
      summaryWrites.push(summary);
    },
    async setLastUserRequest() {},
    async setReverifyPending() {},
    async setSlaveBusy() {},
    async pushSlaveHandoff(text: string) {
      handoffs.push(text);
    },
    async incrMasterTurns() {
      return 1;
    },
  };

  const inbound: InboundMessage = {
    messageId: 'msg-1',
    address: masterAddress,
    text: 'Fix the deploy script',
    timestamp: Date.now(),
    deliverySource: 'master',
    outboundChatId: 'chat-1',
  };

  await (adapter as any).handleMasterRedisMessage(inbound);

  const nextMasterBinding = router.resolve(masterAddress);
  const nextSlaveBinding = router.resolve(slaveAddress);
  assert.notEqual(nextMasterBinding.codepilotSessionId, originalMasterSession);
  assert.notEqual(nextSlaveBinding.codepilotSessionId, originalSlaveSession);
  assert.equal(nextMasterBinding.sdkSessionId, '');
  assert.equal(nextSlaveBinding.sdkSessionId, '');
  assert.equal(summaryWrites.length, 1);
  assert.match(summaryWrites[0]!, /^User goal: Fix the deploy script/);
  assert.doesNotMatch(summaryWrites[0]!, /previous task/i);
  assert.equal(handoffs.length, 1);
});
