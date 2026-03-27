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

function createMockSpawnWithSignal(
  lines: Record<string, unknown>[],
  signal: NodeJS.Signals,
  stderrText = '',
) {
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
      for (const line of lines) {
        stdout.push(JSON.stringify(line) + '\n');
      }
      if (stderrText) stderr.push(stderrText);
      stdout.push(null);
      stderr.push(null);
      setTimeout(() => (child as EventEmitter).emit('close', null, signal), 10);
    });

    return child;
  };
}

function createHangingSpawn() {
  return (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_, __, cb) { cb(); } });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      kill: (signal?: NodeJS.Signals) => {
        setImmediate(() => {
          stdout.push(null);
          stderr.push(null);
          (child as unknown as EventEmitter).emit('close', null, signal || 'SIGTERM');
        });
        return true;
      },
      pid: 99999,
    }) as unknown as ChildProcess;
    return child;
  };
}

describe('CopilotProvider', () => {
  it('is an LLMProvider (has streamChat method)', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    const provider = new CopilotProvider();
    assert.equal(typeof provider.streamChat, 'function');
  });

  it('uses copilot -p with json stream and yolo flags', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    let seenCmd = '';
    let seenArgs: string[] = [];
    const inner = createMockSpawn([
      { type: 'session.tools_updated', data: { model: 'gpt-5' } },
      { type: 'result', sessionId: 's1', exitCode: 0, usage: {} },
    ]);
    const mockSpawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seenCmd = cmd;
      seenArgs = args;
      return inner(cmd, args, opts);
    };

    const provider = new CopilotProvider(mockSpawn);
    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'sess',
      workingDirectory: '/tmp/wd',
      sdkSessionId: 'resume-id',
      model: 'gpt-5-mini',
    });
    await collectStream(stream);

    assert.ok(seenCmd.includes('copilot') || seenCmd === 'copilot');
    assert.ok(seenArgs.includes('--output-format'));
    assert.ok(seenArgs.includes('json'));
    assert.ok(seenArgs.includes('--stream'));
    assert.ok(seenArgs.includes('on'));
    assert.ok(seenArgs.includes('--yolo'));
    assert.ok(seenArgs.includes('--add-dir'));
    assert.ok(seenArgs.includes('/tmp/wd'));
    assert.ok(seenArgs.some((a) => a.startsWith('--resume=')));
    assert.ok(seenArgs.includes('--model'));
    assert.ok(seenArgs.includes('gpt-5-mini'));
    assert.ok(seenArgs.includes('-p'));
    assert.ok(seenArgs.includes('hello'));
  });
});

describe('CopilotProvider stream-json event mapping', () => {
  it('maps session.tools_updated and assistant deltas to SSE events', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    const mockSpawn = createMockSpawn([
      { type: 'session.tools_updated', data: { model: 'gpt-5' } },
      { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Hey' } },
      { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: '!' } },
      { type: 'result', sessionId: 'cp-abc', exitCode: 0, usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const provider = new CopilotProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const status = events.find(e => e.type === 'status');
    assert.ok(status);
    const data = JSON.parse(status!.data);
    assert.equal(data.model, 'gpt-5');

    const texts = events.filter(e => e.type === 'text').map(e => e.data);
    assert.deepEqual(texts, ['Hey', '!']);

    const result = events.find(e => e.type === 'result');
    assert.ok(result);
    const resultData = JSON.parse(result!.data);
    assert.equal(resultData.session_id, 'cp-abc');
  });

  it('emits error on non-zero exit code with no session', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    const mockSpawn = createMockSpawn([], 1, 'copilot: bad\n');

    const provider = new CopilotProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const error = events.find(e => e.type === 'error');
    assert.ok(error);
    assert.ok(error!.data.includes('exited with code 1'));
  });

  it('emits error when copilot crashes by signal before session init', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    const mockSpawn = createMockSpawnWithSignal([], 'SIGSEGV', 'ERROR: SecItemCopyMatching failed -50\n');

    const provider = new CopilotProvider(mockSpawn);
    const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const error = events.find(e => e.type === 'error');
    assert.ok(error);
    assert.ok(error!.data.includes('exited with signal SIGSEGV'));
    assert.ok(error!.data.includes('SecItemCopyMatching failed -50'));
  });

  it('times out when copilot never emits startup or result events', async () => {
    const { CopilotProvider } = await import('../copilot-provider');
    const prev = process.env.CTI_COPILOT_START_TIMEOUT_MS;
    const prevGrace = process.env.CTI_COPILOT_KILL_GRACE_MS;
    process.env.CTI_COPILOT_START_TIMEOUT_MS = '20';
    process.env.CTI_COPILOT_KILL_GRACE_MS = '0';
    try {
      const provider = new CopilotProvider(createHangingSpawn());
      const stream = provider.streamChat({ prompt: 'test', sessionId: 's1' });
      const chunks = await collectStream(stream);
      const events = parseSSEChunks(chunks);

      const error = events.find(e => e.type === 'error');
      assert.ok(error);
      assert.ok(error!.data.includes('timed out waiting for startup/output'));
    } finally {
      if (prev === undefined) delete process.env.CTI_COPILOT_START_TIMEOUT_MS;
      else process.env.CTI_COPILOT_START_TIMEOUT_MS = prev;
      if (prevGrace === undefined) delete process.env.CTI_COPILOT_KILL_GRACE_MS;
      else process.env.CTI_COPILOT_KILL_GRACE_MS = prevGrace;
    }
  });
});
