import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectImLlmBuildEntries,
  imLlmKeyPrefix,
  type Config,
} from '../config';

test('IM LLM key prefixes include secondary enabled channels for one bot instance', () => {
  const savedBotName = process.env.CTI_BOT_NAME;
  const savedCtiHome = process.env.CTI_HOME;
  try {
    process.env.CTI_BOT_NAME = 'mybot';
    delete process.env.CTI_HOME;
    const config: Config = {
      runtime: 'claude',
      enabledChannels: ['discord', 'telegram'],
      defaultWorkDir: '/tmp/test',
      defaultMode: 'code',
      imBot: {
        id: 'mybot',
        channel: 'telegram',
        runners: [
          { id: 'rt-3', runtime: 'codex' },
          { id: 'rt-5', runtime: 'copilot' },
        ],
        defaultRunnerId: 'rt-5',
      },
    };

    const keys = collectImLlmBuildEntries(config).map(({ keyPrefix, runner }) => `${keyPrefix}\0${runner.id}`);
    assert.deepEqual(
      keys,
      [
        'telegram:mybot\0rt-3',
        'telegram:mybot\0rt-5',
        'discord:mybot\0rt-3',
        'discord:mybot\0rt-5',
      ],
    );
    assert.equal(imLlmKeyPrefix(config, 'telegram:mybot'), 'telegram:mybot');
    assert.equal(imLlmKeyPrefix(config, 'discord'), 'discord:mybot');
  } finally {
    if (savedBotName === undefined) delete process.env.CTI_BOT_NAME;
    else process.env.CTI_BOT_NAME = savedBotName;
    if (savedCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = savedCtiHome;
  }
});
