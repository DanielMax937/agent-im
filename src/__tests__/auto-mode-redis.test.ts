import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AutoModeRedisTransport,
  isHybridAutoModeEnabled,
} from '../lib/bridge/redis-local-transport';

interface RedisStubState {
  lists: Map<string, string[]>;
  values: Map<string, string>;
}

function createRedisStub(state: RedisStubState) {
  return {
    async connect() {},
    async disconnect() {},
    async lPush(key: string, value: string) {
      const list = state.lists.get(key) ?? [];
      list.unshift(value);
      state.lists.set(key, list);
      return list.length;
    },
    async rPop(key: string) {
      const list = state.lists.get(key) ?? [];
      const value = list.pop() ?? null;
      state.lists.set(key, list);
      return value;
    },
    async get(key: string) {
      return state.values.get(key) ?? null;
    },
    async set(key: string, value: string) {
      state.values.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      state.values.delete(key);
      return 1;
    },
    async lRange(key: string, start: number, stop: number) {
      const list = state.lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1);
    },
    async lLen(key: string) {
      return (state.lists.get(key) ?? []).length;
    },
    async incr(key: string) {
      const next = (parseInt(state.values.get(key) ?? '0', 10) || 0) + 1;
      state.values.set(key, String(next));
      return next;
    },
  };
}

function createSettingsStore(entries: Record<string, string>) {
  return {
    getSetting(key: string) {
      return entries[key] ?? null;
    },
  };
}

test('isHybridAutoModeEnabled only enables hybrid mode for Telegram', () => {
  const discordStore = createSettingsStore({
    bridge_discord_auto_mode: 'true',
    bridge_discord_auto_redis_url: 'redis://127.0.0.1:6379',
    bridge_discord_bot_token: 'discord-token',
  });

  const telegramStore = createSettingsStore({
    bridge_telegram_auto_mode: 'true',
    bridge_telegram_auto_redis_url: 'redis://127.0.0.1:6379',
    telegram_bot_token: 'telegram-token',
  });

  assert.equal(isHybridAutoModeEnabled(discordStore as never, 'discord', 'default'), false);
  assert.equal(isHybridAutoModeEnabled(telegramStore as never, 'telegram', 'default'), true);
});

test('AutoModeRedisTransport preserves outbound chat routing for master and slave payloads', async () => {
  const state: RedisStubState = {
    lists: new Map(),
    values: new Map(),
  };
  const transport = new AutoModeRedisTransport(
    'telegram',
    { redisUrl: 'redis://127.0.0.1:6379', maxTurns: 10, hybridMode: true },
    'bridge-a',
    ['runner-a'],
    'slave-a',
    () => 'fallback-chat',
  );
  (transport as unknown as { client: ReturnType<typeof createRedisStub> }).client = createRedisStub(state);

  await transport.pushMasterInput('hello master', 'runner-a', 'chat-1');
  const masterMsg = await transport.pollOnceMaster();
  assert.ok(masterMsg);
  assert.equal(masterMsg.text, 'hello master');
  assert.equal(masterMsg.deliverySource, 'master');
  assert.equal(masterMsg.outboundChatId, 'chat-1');
  assert.equal(masterMsg.address.chatId, 'auto:master:bridge-a:telegram:chat-1:runner-a');

  await transport.pushSlaveHandoff('hello slave', 'chat-2');
  const slaveMsg = await transport.pollOnce();
  assert.ok(slaveMsg);
  assert.equal(slaveMsg.text, 'hello slave');
  assert.equal(slaveMsg.deliverySource, 'slave');
  assert.equal(slaveMsg.outboundChatId, 'chat-2');
  assert.equal(slaveMsg.address.chatId, 'auto:bridge-a:telegram:chat-2:slave-a');
});

test('AutoModeRedisTransport remains backward-compatible with legacy plain-text queue payloads', async () => {
  const state: RedisStubState = {
    lists: new Map([
      ['cti:auto:bridge-a:telegram:master:input', ['legacy master']],
      ['cti:auto:bridge-a:telegram:slave:input', ['legacy slave']],
    ]),
    values: new Map(),
  };
  const transport = new AutoModeRedisTransport(
    'telegram',
    { redisUrl: 'redis://127.0.0.1:6379', maxTurns: 10, hybridMode: true },
    'bridge-a',
    ['runner-a'],
    'slave-a',
    () => 'fallback-chat',
  );
  (transport as unknown as { client: ReturnType<typeof createRedisStub> }).client = createRedisStub(state);

  const masterMsg = await transport.pollOnceMaster();
  assert.ok(masterMsg);
  assert.equal(masterMsg.text, 'legacy master');
  assert.equal(masterMsg.outboundChatId, 'fallback-chat');

  const slaveMsg = await transport.pollOnce();
  assert.ok(slaveMsg);
  assert.equal(slaveMsg.text, 'legacy slave');
  assert.equal(slaveMsg.outboundChatId, 'fallback-chat');
});

test('pushSlaveHandoff does not enqueue when slaveTurns >= maxTurns', async () => {
  const state: RedisStubState = {
    lists: new Map(),
    values: new Map([['cti:auto:bridge-a:telegram:slave:turns', '2']]),
  };
  const transport = new AutoModeRedisTransport(
    'telegram',
    { redisUrl: 'redis://127.0.0.1:6379', maxTurns: 2, hybridMode: true },
    'bridge-a',
    ['runner-a'],
    'slave-a',
    () => 'fallback-chat',
  );
  (transport as unknown as { client: ReturnType<typeof createRedisStub> }).client = createRedisStub(state);

  await transport.pushSlaveHandoff('blocked handoff', 'chat-9');
  assert.equal(state.lists.get('cti:auto:bridge-a:telegram:slave:input')?.length ?? 0, 0);
});
