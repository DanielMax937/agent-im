import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENAI_CHAT_CODEX_SAFETY_OPTIONS,
  collectProviderResponse,
  createBufferedOpenAIChatCompletionStream,
  createOpenAIChatCompletionStream,
  normalizeOpenAICompatModel,
  parseBase64DataUrl,
  parseOpenAIMessagesAsPrompt,
  parseOpenAIProviderModel,
  parseOpenAIResponseFormat,
  validateOpenAIStructuredOutput,
} from '../platform/app';

async function readUint8Stream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

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

  it('normalizes OpenAI-compatible model names as runner/model with codex-login default', () => {
    assert.deepEqual(normalizeOpenAICompatModel(undefined), {
      provider: 'codex-login',
      runtimeModel: 'gpt-5.5',
      key: 'codex-login/gpt-5.5',
    });
    assert.deepEqual(normalizeOpenAICompatModel('claude/mimo-v2.5-pro'), {
      provider: 'claude',
      runtimeModel: 'mimo-v2.5-pro',
      key: 'claude/mimo-v2.5-pro',
    });
    assert.equal(normalizeOpenAICompatModel('gpt-5-mini'), null);
  });

  it('accepts an omitted response format as plain text', () => {
    assert.deepEqual(parseOpenAIResponseFormat(undefined), {
      ok: true,
      value: { kind: 'text' },
    });
  });

  it('locks OpenAI-compatible Codex calls to read-only, offline tool settings', () => {
    assert.deepEqual(OPENAI_CHAT_CODEX_SAFETY_OPTIONS, {
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
  });

  it('rejects unsupported and incomplete response formats', () => {
    const unsupported = parseOpenAIResponseFormat({ type: 'xml' });
    assert.equal(unsupported.ok, false);

    const missingSchema = parseOpenAIResponseFormat({
      type: 'json_schema',
      json_schema: { name: 'answer' },
    });
    assert.equal(missingSchema.ok, false);

    const invalidSchema = parseOpenAIResponseFormat({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: { type: 'not-a-real-json-schema-type' },
      },
    });
    assert.equal(invalidSchema.ok, false);
  });

  it('requires json_object output to be a non-null, non-array object', () => {
    const parsed = parseOpenAIResponseFormat({ type: 'json_object' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    assert.equal(validateOpenAIStructuredOutput(parsed.value, '{"ok":true}').ok, true);
    for (const invalid of ['[]', '"text"', '1', 'true', 'null', '{broken']) {
      assert.equal(validateOpenAIStructuredOutput(parsed.value, invalid).ok, false, invalid);
    }
  });

  it('validates json_schema output with caller-controlled additionalProperties', () => {
    const strictObject = parseOpenAIResponseFormat({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      },
    });
    assert.equal(strictObject.ok, true);
    if (!strictObject.ok) return;
    assert.equal(validateOpenAIStructuredOutput(strictObject.value, '{"answer":"ok"}').ok, true);
    assert.equal(validateOpenAIStructuredOutput(strictObject.value, '{"answer":"ok","extra":1}').ok, false);

    const permissiveObject = parseOpenAIResponseFormat({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        strict: false,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: true,
        },
      },
    });
    assert.equal(permissiveObject.ok, true);
    if (!permissiveObject.ok) return;
    assert.equal(validateOpenAIStructuredOutput(permissiveObject.value, '{"answer":"ok","extra":1}').ok, true);
  });

  it('emits a buffered structured response only as complete OpenAI SSE chunks', async () => {
    const raw = await readUint8Stream(createBufferedOpenAIChatCompletionStream({
      requestId: 'chatcmpl-buffered',
      modelKey: 'codex-login/gpt-5.5',
      content: '{"answer":"ok"}',
      usage: { input: 3, output: 2 },
      includeUsage: true,
      apiSessionId: 'session-1',
      created: 123,
    }));
    const events = raw
      .split('\n\n')
      .filter((event) => event.startsWith('data: ') && event !== 'data: [DONE]')
      .map((event) => JSON.parse(event.slice('data: '.length)));

    assert.equal(events.length, 3);
    assert.deepEqual(events[0].choices[0].delta, { role: 'assistant' });
    assert.deepEqual(events[1].choices[0].delta, { content: '{"answer":"ok"}' });
    assert.equal(events[2].choices[0].finish_reason, 'stop');
    assert.deepEqual(events[2].usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.match(raw, /data: \[DONE\]/);
  });

  it('converts provider SSE into OpenAI chat completion chunks', async () => {
    const providerStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ session_id: 'thread-1' }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'hel' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'lo' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({
            session_id: 'thread-1',
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        })}\n`);
        controller.close();
      },
    });
    const sessions: Array<{ providerSessionId: string; apiSessionId: string; modelKey: string }> = [];
    const output = await readUint8Stream(createOpenAIChatCompletionStream(providerStream, {
      requestId: 'chatcmpl-test',
      modelKey: 'codex-login/gpt-5-mini',
      provider: 'codex-login',
      runtimeModel: 'gpt-5-mini',
      includeUsage: true,
      created: 123,
      onSession: (session) => sessions.push(session),
    }));

    const payloads = output
      .split('\n\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    assert.equal(payloads.at(-1), '[DONE]');

    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload));
    assert.equal(chunks[0].object, 'chat.completion.chunk');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks[1].choices[0].delta.content, 'hel');
    assert.equal(chunks[2].choices[0].delta.content, 'lo');
    assert.equal(chunks[3].choices[0].finish_reason, 'stop');
    assert.equal(chunks[3].usage.total_tokens, 5);
    assert.equal(chunks[3].session_id, sessions[0].apiSessionId);
    assert.equal(sessions[0].providerSessionId, 'thread-1');
  });

  it('preserves JSON text events instead of coercing them to object strings', async () => {
    const providerStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'text',
          data: '{"status":"ok"}',
        })}\n`);
        controller.close();
      },
    });
    const output = await readUint8Stream(createOpenAIChatCompletionStream(providerStream, {
      requestId: 'chatcmpl-json-text',
      modelKey: 'codex-login/gpt-5.5',
      provider: 'codex-login',
      runtimeModel: 'gpt-5.5',
      created: 123,
    }));
    const chunks = output
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));

    assert.equal(chunks[1].choices[0].delta.content, '{"status":"ok"}');
    assert.doesNotMatch(output, /\[object Object\]/);
  });

  it('preserves JSON text while collecting a non-streamed provider response', async () => {
    const providerStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'text',
          data: '{"status":"ok"}',
        })}\n`);
        controller.close();
      },
    });

    const completion = await collectProviderResponse(providerStream);
    assert.equal(completion.text, '{"status":"ok"}');
  });
});
