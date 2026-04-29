import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseBase64DataUrl, parseOpenAIMessagesAsPrompt, parseOpenAIProviderModel } from '../platform/app';

describe('OpenAI chat completions parsing', () => {
  it('parses a valid image base64 data URL', () => {
    const parsed = parseBase64DataUrl('data:image/png;base64,aGVsbG8=');
    assert.deepEqual(parsed, { mime: 'image/png', base64: 'aGVsbG8=' });
  });

  it('returns null for non-data-url image value', () => {
    const parsed = parseBase64DataUrl('https://example.com/foo.png');
    assert.equal(parsed, null);
  });

  it('converts text messages into a prompt transcript', () => {
    const parsed = parseOpenAIMessagesAsPrompt([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain this.' },
    ]);
    assert.equal(parsed.files.length, 0);
    assert.match(parsed.prompt, /SYSTEM: You are helpful\./);
    assert.match(parsed.prompt, /USER: Explain this\./);
  });

  it('extracts image_url data URLs into files', () => {
    const parsed = parseOpenAIMessagesAsPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe image.' },
          { type: 'image_url', image_url: { url: 'data:image/webp;base64,dGVzdA==' } },
        ],
      },
    ]);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]?.type, 'image/webp');
    assert.equal(parsed.files[0]?.data, 'dGVzdA==');
    assert.match(parsed.prompt, /\[image_1: data-url attached\]/);
  });

  it('parses provider/model names for /v1 dispatch', () => {
    assert.deepEqual(parseOpenAIProviderModel('codex-login/gpt-5.3-codex'), {
      provider: 'codex-login',
      runtimeModel: 'gpt-5.3-codex',
      key: 'codex-login/gpt-5.3-codex',
    });
    assert.deepEqual(parseOpenAIProviderModel('opencode/anthropic/claude-sonnet-4'), {
      provider: 'opencode',
      runtimeModel: 'anthropic/claude-sonnet-4',
      key: 'opencode/anthropic/claude-sonnet-4',
    });
  });

  it('rejects model names without provider prefix', () => {
    assert.equal(parseOpenAIProviderModel('gpt-5.3-codex'), null);
    assert.equal(parseOpenAIProviderModel('/gpt-5.3-codex'), null);
    assert.equal(parseOpenAIProviderModel('codex/'), null);
  });
});
