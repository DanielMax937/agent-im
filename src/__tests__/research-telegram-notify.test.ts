import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configToSettings, invalidateBridgePathsCache, saveConfig, type Config } from '../config';
import { initBridgeContext } from '../lib/bridge/context';
import { JsonFileStore } from '../store';
import { resolveResearchTelegramTarget } from '../lib/bridge/research-mode/telegram-notify';

function minimalConfig(patch: Partial<Config> = {}): Config {
  return {
    runtime: 'claude',
    enabledChannels: ['telegram'],
    defaultWorkDir: process.cwd(),
    defaultMode: 'code',
    runners: [{ id: 'default', runtime: 'claude' }],
    defaultRunnerId: 'default',
    ...patch,
  };
}

describe('resolveResearchTelegramTarget', () => {
  let tmpBase: string;
  let prevBase: string | undefined;

  beforeEach(() => {
    prevBase = process.env.CTI_BASE;
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-research-tg-'));
    process.env.CTI_BASE = tmpBase;
    invalidateBridgePathsCache();
    fs.mkdirSync(path.join(tmpBase, 'mybot'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'kanban'), { recursive: true });
  });

  afterEach(() => {
    if (prevBase === undefined) delete process.env.CTI_BASE;
    else process.env.CTI_BASE = prevBase;
    invalidateBridgePathsCache();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('prefers mybot imBot telegram credentials over kanban', () => {
    saveConfig(
      minimalConfig({
        imBot: {
          id: 'mybot',
          channel: 'telegram',
          tgBotToken: 'token-mybot',
          tgChatId: 'chat-mybot',
          autoRedisUrl: 'redis://127.0.0.1:6379',
        },
      }),
      path.join(tmpBase, 'mybot'),
    );
    saveConfig(
      minimalConfig({
        imBot: {
          id: 'kanban',
          channel: 'telegram',
          tgBotToken: 'token-kanban',
          tgChatId: 'chat-kanban',
        },
      }),
      path.join(tmpBase, 'kanban'),
    );

    const target = resolveResearchTelegramTarget();
    assert.ok(target);
    assert.equal(target.token, 'token-mybot');
    assert.equal(target.chatId, 'chat-mybot');
    assert.equal(target.bridgeSlug, 'mybot');
  });

  it('honours explicit chatId override while keeping token from bridge', () => {
    saveConfig(
      minimalConfig({
        imBot: {
          id: 'mybot',
          channel: 'telegram',
          tgBotToken: 'token-mybot',
          tgChatId: 'chat-default',
        },
      }),
      path.join(tmpBase, 'mybot'),
    );

    const target = resolveResearchTelegramTarget({ chatId: 'override-chat', bridgeSlug: 'mybot' });
    assert.ok(target);
    assert.equal(target.token, 'token-mybot');
    assert.equal(target.chatId, 'override-chat');
  });

  it('reads telegram_bot_token from bridge store when bridge configs lack imBot', () => {
    saveConfig(minimalConfig(), path.join(tmpBase, 'mybot'));
    saveConfig(minimalConfig(), path.join(tmpBase, 'kanban'));

    initBridgeContext({
      store: new JsonFileStore(
        configToSettings(
          minimalConfig({
            enabledChannels: ['telegram'],
            tgBotToken: 'store-token',
            tgChatId: 'store-chat',
          }),
        ),
      ),
      llm: {
        streamChat: () =>
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
      },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const target = resolveResearchTelegramTarget();
    assert.ok(target);
    assert.equal(target.token, 'store-token');
    assert.equal(target.chatId, 'store-chat');
  });
});
