import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  return (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  })();
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

/**
 * Create a mock child process that emits lines of JSON on stdout,
 * then closes with the given exit code.
 */
function createMockSpawn(lines: Record<string, unknown>[], exitCode = 0, stderrText = '') {
  return (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: new Writable({ write(_, __, cb) { cb(); } }),
      kill: () => {},
      pid: 99999,
    }) as unknown as ChildProcess;

    // Push lines asynchronously so the ReadableStream has time to set up
    setImmediate(() => {
      for (const line of lines) {
        stdout.push(JSON.stringify(line) + '\n');
      }
      if (stderrText) stderr.push(stderrText);
      stdout.push(null);
      stderr.push(null);
      setTimeout(() => (child as EventEmitter).emit('close', exitCode), 10);
    });

    return child;
  };
}

describe('CursorProvider', () => {
  it('is an LLMProvider (has streamChat method)', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const provider = new CursorProvider();
    assert.equal(typeof provider.streamChat, 'function');
  });

  it('is NOT a CodexProvider subclass', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const { CodexProvider } = await import('../codex-provider.js');
    const provider = new CursorProvider();
    assert.ok(!(provider instanceof CodexProvider));
  });
});

describe('CursorProvider stream-json event mapping', () => {
  it('maps system.init to status SSE event with session_id', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'cursor-abc', model: 'gpt-5' },
      { type: 'result', subtype: 'success', session_id: 'cursor-abc', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const status = events.find(e => e.type === 'status');
    assert.ok(status);
    const data = JSON.parse(status!.data);
    assert.equal(data.session_id, 'cursor-abc');
    assert.equal(data.model, 'gpt-5');
  });

  it('maps assistant message to text SSE event', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
        session_id: 'abc',
      },
      { type: 'result', subtype: 'success', session_id: 'abc', usage: {} },
    ]);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const textEvents = events.filter(e => e.type === 'text');
    assert.ok(textEvents.length >= 1);
    assert.ok(textEvents.some(e => e.data.includes('Hello!')));
  });

  it('emits each assistant turn text exactly once', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Checking...' }] },
        session_id: 'abc',
      },
      {
        type: 'tool_call', subtype: 'started', call_id: 't1',
        tool_call: { shellToolCall: { args: { command: 'ls' } } }, session_id: 'abc',
      },
      {
        type: 'tool_call', subtype: 'completed', call_id: 't1',
        tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'ok', exitCode: 0 } } } },
        session_id: 'abc',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'All good.' }] },
        session_id: 'abc',
      },
      { type: 'result', subtype: 'success', session_id: 'abc', usage: {} },
    ]);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const textEvents = events.filter(e => e.type === 'text');

    assert.equal(textEvents.length, 2);
    assert.equal(textEvents[0].data, 'Checking...');
    assert.equal(textEvents[1].data, 'All good.');
  });

  it('maps tool_call started/completed to tool_use/tool_result', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'tool_call', subtype: 'started', call_id: 'tool-1',
        tool_call: { shellToolCall: { args: { command: 'ls -la' }, description: 'List files' } },
        session_id: 'abc',
      },
      {
        type: 'tool_call', subtype: 'completed', call_id: 'tool-1',
        tool_call: {
          shellToolCall: {
            args: { command: 'ls -la' },
            result: { success: { stdout: 'file1.txt\nfile2.txt', exitCode: 0 } },
          },
        },
        session_id: 'abc',
      },
      { type: 'result', subtype: 'success', session_id: 'abc', usage: {} },
    ]);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const toolUse = events.find(e => e.type === 'tool_use');
    assert.ok(toolUse);
    const useData = JSON.parse(toolUse!.data);
    assert.equal(useData.name, 'Bash');
    assert.equal(useData.input.command, 'ls -la');

    const toolResult = events.find(e => e.type === 'tool_result');
    assert.ok(toolResult);
    const resultData = JSON.parse(toolResult!.data);
    assert.equal(resultData.tool_use_id, 'tool-1');
    assert.ok(resultData.content.includes('file1.txt'));
    assert.equal(resultData.is_error, false);
  });

  it('maps result event with usage to result SSE', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'result', subtype: 'success', session_id: 'abc',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 },
      },
    ]);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const result = events.find(e => e.type === 'result');
    assert.ok(result);
    const data = JSON.parse(result!.data);
    assert.equal(data.session_id, 'abc');
    assert.equal(data.usage.input_tokens, 100);
    assert.equal(data.usage.output_tokens, 50);
    assert.equal(data.usage.cache_read_input_tokens, 30);
  });

  it('emits error on non-zero exit code with no session', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([], 1, 'agent: unknown flag --bad\n');

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const error = events.find(e => e.type === 'error');
    assert.ok(error);
    assert.ok(error!.data.includes('exited with code 1'));
  });

  it('does not error on non-zero exit code when session was established', async () => {
    const { CursorProvider } = await import('../cursor-provider.js');
    const mockSpawn = createMockSpawn([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] }, session_id: 'abc' },
      { type: 'result', subtype: 'success', session_id: 'abc', usage: {} },
    ], 1);

    const provider = new CursorProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const error = events.find(e => e.type === 'error');
    assert.ok(!error, 'Should not emit error when session was established');
    const result = events.find(e => e.type === 'result');
    assert.ok(result);
  });
});
