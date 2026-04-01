import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  maskSecret,
  configToSettings,
  mergeConfigPatch,
  configForAdminResponse,
  saveConfig,
  loadConfig,
  invalidateBridgePathsCache,
  normalizeRunnersForChannelType,
  type Config,
} from '../config';

// ── maskSecret ──

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
  });

  it('sets channel enabled flags based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['telegram', 'discord'] });
    assert.equal(m.get('bridge_telegram_enabled'), 'true');
    assert.equal(m.get('bridge_discord_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('maps telegram config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['telegram'],
      tgBotToken: 'bot123:abc',
      tgAllowedUsers: ['user1', 'user2'],
      tgChatId: '99999',
    });
    assert.equal(m.get('telegram_bot_token'), 'bot123:abc');
    assert.equal(m.get('telegram_bridge_allowed_users'), 'user1,user2');
    assert.equal(m.get('telegram_chat_id'), '99999');
  });

  it('maps discord config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['discord'],
      discordBotToken: 'discord-token',
      discordAllowedUsers: ['u1'],
      discordAllowedChannels: ['c1', 'c2'],
      discordAllowedGuilds: ['g1'],
    });
    assert.equal(m.get('bridge_discord_bot_token'), 'discord-token');
    assert.equal(m.get('bridge_discord_allowed_users'), 'u1');
    assert.equal(m.get('bridge_discord_allowed_channels'), 'c1,c2');
    assert.equal(m.get('bridge_discord_allowed_guilds'), 'g1');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['feishu'],
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'example.com',
      feishuAllowedUsers: ['fu1'],
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
  });

  it('sets bridge_qq_enabled based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['qq'] });
    assert.equal(m.get('bridge_qq_enabled'), 'true');
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
  });

  it('defaults bridge_qq_enabled to false', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('maps qq config fields', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'qq-app-id',
      qqAppSecret: 'qq-secret',
      qqAllowedUsers: ['openid1', 'openid2'],
    });
    assert.equal(m.get('bridge_qq_app_id'), 'qq-app-id');
    assert.equal(m.get('bridge_qq_app_secret'), 'qq-secret');
    assert.equal(m.get('bridge_qq_allowed_users'), 'openid1,openid2');
  });

  it('maps qq image settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
      qqImageEnabled: false,
      qqMaxImageSize: 10,
    });
    assert.equal(m.get('bridge_qq_image_enabled'), 'false');
    assert.equal(m.get('bridge_qq_max_image_size'), '10');
  });

  it('omits qq image settings when not set', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
    });
    assert.equal(m.has('bridge_qq_image_enabled'), false);
    assert.equal(m.has('bridge_qq_max_image_size'), false);
  });

  it('maps workdir and mode, omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('telegram_bot_token'), false);
    assert.equal(m.has('bridge_discord_bot_token'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
  });

  it('maps imBot to bridge_telegram_instances and token keys', () => {
    const savedHome = process.env.CTI_HOME;
    try {
      delete process.env.CTI_HOME;
      invalidateBridgePathsCache();
      process.env.CTI_BOT_NAME = 'work';
      const m = configToSettings({
        ...base,
        enabledChannels: ['telegram'],
        imBot: {
          id: 'work',
          channel: 'telegram',
          tgBotToken: 'bot:secret',
          tgAllowedUsers: ['1'],
          runners: [
            { id: 'default', runtime: 'claude' },
            { id: 'codex', runtime: 'codex' },
          ],
        },
        runners: [
          { id: 'default', runtime: 'claude' },
          { id: 'codex', runtime: 'codex' },
        ],
      });
      assert.equal(m.get('bridge_telegram_instances'), 'work');
      assert.equal(m.get('telegram_work_bot_token'), 'bot:secret');
      assert.equal(m.has('bridge_telegram_work_allowed_runner_ids'), false);
    } finally {
      delete process.env.CTI_BOT_NAME;
      if (savedHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = savedHome;
      invalidateBridgePathsCache();
    }
  });
});

// ── mergeConfigPatch / configForAdminResponse (imBot) ──

describe('mergeConfigPatch imBot', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
    imBot: {
      id: 'a',
      channel: 'telegram',
      tgBotToken: 'old-token',
    },
  };

  let savedCtiHome: string | undefined;

  beforeEach(() => {
    savedCtiHome = process.env.CTI_HOME;
    delete process.env.CTI_HOME;
    invalidateBridgePathsCache();
    process.env.CTI_BOT_NAME = 'test-bridge';
  });

  afterEach(() => {
    delete process.env.CTI_BOT_NAME;
    if (savedCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = savedCtiHome;
    invalidateBridgePathsCache();
  });

  it('clears imBot when patch sends null', () => {
    const next = mergeConfigPatch(base, {
      imBot: null,
    } as Parameters<typeof mergeConfigPatch>[1]);
    assert.equal(next.imBot, undefined);
  });

  it('strips top-level bridge mirrors that matched removed imBot', () => {
    const prev: Config = {
      runtime: 'claude',
      enabledChannels: ['telegram'],
      defaultWorkDir: '/tmp/bot-wd',
      defaultMode: 'plan',
      proxy: 'http://proxy.example',
      autoApprove: true,
      defaultModel: 'opus',
      defaultRunnerId: 'default',
      runners: [{ id: 'default', runtime: 'claude' }],
      imBot: {
        id: 'a',
        channel: 'telegram',
        defaultWorkDir: '/tmp/bot-wd',
        defaultMode: 'plan',
        proxy: 'http://proxy.example',
        autoApprove: true,
        defaultModel: 'opus',
        defaultRunnerId: 'default',
        runners: [{ id: 'default', runtime: 'claude' }],
      },
    };
    const next = mergeConfigPatch(prev, {
      imBot: null,
    } as Parameters<typeof mergeConfigPatch>[1]);
    assert.equal(next.imBot, undefined);
    assert.equal(next.proxy, undefined);
    assert.equal(next.defaultMode, 'code');
    assert.equal(next.autoApprove, false);
    assert.equal(next.defaultModel, undefined);
    assert.equal(next.defaultRunnerId, undefined);
    assert.equal(next.defaultWorkDir, process.cwd());
    assert.equal(next.runners, undefined);
  });

  it('keeps top-level proxy when imBot did not set proxy', () => {
    const prev: Config = {
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
      proxy: 'http://legacy-only',
      runners: [{ id: 'default', runtime: 'claude' }],
      imBot: {
        id: 'a',
        channel: 'telegram',
        runners: [{ id: 'default', runtime: 'claude' }],
      },
    };
    const next = mergeConfigPatch(prev, {
      imBot: null,
    } as Parameters<typeof mergeConfigPatch>[1]);
    assert.equal(next.proxy, 'http://legacy-only');
  });

  it('keeps previous token when masked placeholder is sent', () => {
    const next = mergeConfigPatch(base, {
      imBot: { id: 'a', channel: 'telegram', tgBotToken: '****5678' },
    });
    assert.equal(next.imBot?.tgBotToken, 'old-token');
  });

  it('applies new token when explicitly changed', () => {
    const next = mergeConfigPatch(base, {
      imBot: { id: 'a', channel: 'telegram', tgBotToken: 'brand-new' },
    });
    assert.equal(next.imBot?.tgBotToken, 'brand-new');
    assert.equal(next.imBot?.id, 'test-bridge');
  });

  it('fills per-bot runners from global CTI_RUNNERS when omitted', () => {
    const next = mergeConfigPatch(
      { ...base, runners: [{ id: 'default', runtime: 'claude' }] },
      {
        imBot: { id: 'a', channel: 'telegram', tgBotToken: 'old-token' },
      },
    );
    assert.deepEqual(next.imBot?.runners, [{ id: 'default', runtime: 'claude' }]);
  });

  it('drops autoSlaveExternal for non-telegram bots', () => {
    const next = mergeConfigPatch(
      {
        ...base,
        imBot: {
          id: 'a',
          channel: 'discord',
          discordBotToken: 'discord-token',
        },
      },
      {
        imBot: { id: 'a', channel: 'discord', autoSlaveExternal: true },
      },
    );
    assert.equal(next.imBot?.autoSlaveExternal, undefined);
  });
});

describe('loadConfig with real config.env', () => {
  let tempHome: string;
  let prevCtiHome: string | undefined;

  beforeEach(() => {
    prevCtiHome = process.env.CTI_HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-real-'));
    process.env.CTI_HOME = tempHome;
  });

  afterEach(() => {
    if (prevCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = prevCtiHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('keeps copilot runners visible for the bot channel', () => {
    fs.writeFileSync(
      path.join(tempHome, 'config.env'),
      [
        'CTI_RUNNERS=[{"id":"default","runtime":"claude","label":"默认"},{"id":"rt-2","runtime":"copilot","label":"copilot"}]',
        'CTI_DEFAULT_RUNNER=default',
        'CTI_RUNTIME=claude',
        'CTI_ENABLED_CHANNELS=telegram',
        'CTI_IM_BOT={"id":"bridge-mn8af15s-f698ba74","channel":"telegram","runners":[{"id":"default","runtime":"claude","label":"默认"},{"id":"rt-2","runtime":"copilot","label":"copilot"}],"defaultRunnerId":"default"}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const config = loadConfig(tempHome);
    const runners = normalizeRunnersForChannelType(
      config,
      'telegram:bridge-mn8af15s-f698ba74',
    );

    assert.deepEqual(
      runners.map((runner) => ({ id: runner.id, runtime: runner.runtime, label: runner.label })),
      [
        { id: 'default', runtime: 'claude', label: '默认' },
        { id: 'rt-2', runtime: 'copilot', label: 'copilot' },
      ],
    );
  });
});

describe('configForAdminResponse imBot', () => {
  it('masks per-bot secrets', () => {
    const { config: out } = configForAdminResponse({
      runtime: 'claude',
      enabledChannels: ['telegram'],
      defaultWorkDir: '/tmp',
      defaultMode: 'code',
      imBot: {
        id: 'x',
        channel: 'discord',
        discordBotToken: 'discord-secret-token',
      },
    });
    assert.equal(out.imBot?.discordBotToken, maskSecret('discord-secret-token'));
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
    // loadConfig/saveConfig paths use getCtiHome() from env; round-trip uses configToSettings here.
    // so we test the parsing logic indirectly through configToSettings
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
    assert.equal(m.get('bridge_discord_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('saveConfig rejects unsupported runner runtime instead of silently dropping it later', () => {
    assert.throws(
      () =>
        saveConfig(
          {
            runtime: 'claude',
            enabledChannels: ['telegram'],
            defaultWorkDir: process.cwd(),
            defaultMode: 'code',
            runners: [
              { id: 'default', runtime: 'claude' },
              { id: 'bad', runtime: 'unknown-runtime' as any },
            ],
            imBot: {
              id: 'bridge-test',
              channel: 'telegram',
              runners: [
                { id: 'default', runtime: 'claude' },
                { id: 'bad', runtime: 'unknown-runtime' as any },
              ],
            },
          },
          tmpDir,
        ),
      /unsupported runtime "unknown-runtime"/i,
    );
  });

  it('saveConfig rejects unsupported autoSlaveRunner runtime', () => {
    assert.throws(
      () =>
        saveConfig(
          {
            runtime: 'claude',
            enabledChannels: ['telegram'],
            defaultWorkDir: process.cwd(),
            defaultMode: 'code',
            imBot: {
              id: 'bridge-test',
              channel: 'telegram',
              autoMode: true,
              autoRedisUrl: 'redis://127.0.0.1:6379',
              autoSlaveRunner: {
                id: 'slave',
                runtime: 'unknown-runtime' as any,
              },
            },
          },
          tmpDir,
        ),
      /unsupported runtime "unknown-runtime"/i,
    );
  });

  it('round-trips Auto mode CTI_AUTO_* timeout and chunk-log keys', () => {
    const base: Config = {
      runtime: 'claude',
      enabledChannels: ['telegram'],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
      autoMasterReplyTimeoutMs: 111000,
      autoSlaveReplyTimeoutMs: 222000,
      autoLogStreamChunks: false,
      imBot: {
        id: 'bridge-test',
        channel: 'telegram',
        runners: [{ id: 'default', runtime: 'claude' }],
      },
    };
    saveConfig(base, tmpDir);
    const loaded = loadConfig(tmpDir);
    assert.equal(loaded.autoMasterReplyTimeoutMs, 111000);
    assert.equal(loaded.autoSlaveReplyTimeoutMs, 222000);
    assert.equal(loaded.autoLogStreamChunks, false);
  });

  it('defaults autoLogStreamChunks to true when CTI_AUTO_LOG_STREAM_CHUNKS is absent', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.env'),
      [
        'CTI_RUNNERS=[{"id":"default","runtime":"claude"}]',
        'CTI_DEFAULT_RUNNER=default',
        'CTI_RUNTIME=claude',
        'CTI_ENABLED_CHANNELS=telegram',
        `CTI_DEFAULT_WORKDIR=${process.cwd()}`,
        'CTI_IM_BOT={"id":"t","channel":"telegram","runners":[{"id":"default","runtime":"claude"}]}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const loaded = loadConfig(tmpDir);
    assert.equal(loaded.autoLogStreamChunks, true);
  });
});
