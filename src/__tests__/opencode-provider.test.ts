import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

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

    setImmediate(() => {
      for (const line of lines) stdout.push(JSON.stringify(line) + '\n');
      if (stderrText) stderr.push(stderrText);
      stdout.push(null);
      stderr.push(null);
      setTimeout(() => (child as EventEmitter).emit('close', exitCode), 10);
    });

    return child;
  };
}

describe('OpenCodeProvider', () => {
  it('is an LLMProvider (has streamChat method)', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    const provider = new OpenCodeProvider();
    assert.equal(typeof provider.streamChat, 'function');
  });

  it('uses opencode run with json format and dangerously-skip-permissions', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    let seenCmd = '';
    let seenArgs: string[] = [];
    const inner = createMockSpawn([
      { type: 'step_start', sessionID: 'ses_1', part: { snapshot: 'abc' } },
      { type: 'step_finish', sessionID: 'ses_1', part: { tokens: {} } },
    ]);
    const mockSpawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seenCmd = cmd;
      seenArgs = args;
      return inner(cmd, args, opts);
    };

    const provider = new OpenCodeProvider(mockSpawn, { autoApprove: true });
    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'sess',
      workingDirectory: '/tmp/wd',
      sdkSessionId: 'ses_resume',
      model: 'openai/gpt-5-mini',
    });
    await collectStream(stream);

    assert.ok(seenCmd.includes('opencode') || seenCmd === 'opencode');
    assert.ok(seenArgs.includes('run'));
    assert.ok(seenArgs.includes('--format'));
    assert.ok(seenArgs.includes('json'));
    assert.ok(seenArgs.includes('--dangerously-skip-permissions'));
    assert.ok(seenArgs.includes('--dir'));
    assert.ok(seenArgs.includes('/tmp/wd'));
    assert.ok(seenArgs.includes('--session'));
    assert.ok(seenArgs.includes('ses_resume'));
    assert.ok(seenArgs.includes('--model'));
    assert.ok(seenArgs.includes('openai/gpt-5-mini'));
    assert.equal(seenArgs[seenArgs.length - 1], 'hello');
  });

  it('does not forward stale Cursor-style model/session values', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    let seenArgs: string[] = [];
    const inner = createMockSpawn([
      { type: 'step_start', sessionID: 'ses_1', part: { snapshot: 'abc' } },
      { type: 'step_finish', sessionID: 'ses_1', part: { tokens: {} } },
    ]);
    const mockSpawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seenArgs = args;
      return inner(cmd, args, opts);
    };

    const provider = new OpenCodeProvider(mockSpawn, { autoApprove: true });
    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'sess',
      sdkSessionId: 'f1e9d281-2e17-4916-aa9a-9247c6089441',
      model: 'Composer 2 Fast',
    });
    await collectStream(stream);

    assert.equal(seenArgs.includes('--session'), false);
    assert.equal(seenArgs.includes('f1e9d281-2e17-4916-aa9a-9247c6089441'), false);
    assert.equal(seenArgs.includes('--model'), false);
    assert.equal(seenArgs.includes('Composer 2 Fast'), false);
  });

  it('emits an error when opencode exits without a result', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    const provider = new OpenCodeProvider(createMockSpawn([], 0));
    const events = parseSSEChunks(await collectStream(provider.streamChat({ prompt: 'hi', sessionId: 's1' })));

    const error = events.find(e => e.type === 'error');
    assert.ok(error);
    assert.match(error.data, /before emitting a result/);
  });

  it('omits dangerously-skip-permissions when autoApprove is false', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    let seenArgs: string[] = [];
    const inner = createMockSpawn([
      { type: 'step_start', sessionID: 'ses_1', part: {} },
      { type: 'step_finish', sessionID: 'ses_1', part: { tokens: {} } },
    ]);
    const mockSpawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seenArgs = args;
      return inner(cmd, args, opts);
    };

    const provider = new OpenCodeProvider(mockSpawn, { autoApprove: false });
    const stream = provider.streamChat({ prompt: 'hi', sessionId: 'sess' });
    await collectStream(stream);

    assert.equal(seenArgs.includes('--dangerously-skip-permissions'), false);
  });

  it('maps step/text/tool events to SSE events', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    const mockSpawn = createMockSpawn([
      { type: 'step_start', sessionID: 'ses_abc', part: { snapshot: 'abc123' } },
      { type: 'text', sessionID: 'ses_abc', part: { text: 'Hey' } },
      {
        type: 'tool_use',
        sessionID: 'ses_abc',
        part: {
          id: 'prt_1',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp' },
        },
      },
      { type: 'step_finish', sessionID: 'ses_abc', part: { tokens: { input: 10, output: 5 } } },
    ]);

    const provider = new OpenCodeProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const events = parseSSEChunks(await collectStream(stream));

    const status = events.find(e => e.type === 'status');
    assert.ok(status);
    assert.equal(JSON.parse(status.data).session_id, 'ses_abc');

    const texts = events.filter(e => e.type === 'text').map(e => e.data);
    assert.deepEqual(texts, ['Hey']);

    const toolUse = events.find(e => e.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(JSON.parse(toolUse.data).name, 'bash');

    const result = events.find(e => e.type === 'result');
    assert.ok(result);
    const resultData = JSON.parse(result.data);
    assert.equal(resultData.session_id, 'ses_abc');
    assert.equal(resultData.usage.input_tokens, 10);
  });

  it('emits error on non-zero exit code before result', async () => {
    const { OpenCodeProvider } = await import('../opencode-provider');
    const provider = new OpenCodeProvider(createMockSpawn([], 1, 'opencode: bad\n'));
    const events = parseSSEChunks(await collectStream(provider.streamChat({ prompt: 'test', sessionId: 's1' })));

    const error = events.find(e => e.type === 'error');
    assert.ok(error);
    assert.ok(error.data.includes('exited with code 1'));
  });
});
