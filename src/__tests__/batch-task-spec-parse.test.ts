import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  extractBalancedJsonSlice,
  extractJsonObjectFromAssistantText,
  parsePreviewBatchSpecBody,
  runBatchTaskSpecLlm,
} from '../platform/batch-task-spec';
import type { LLMProvider, StreamChatParams } from '../lib/bridge/host';
import { sseEvent } from '../sse-utils';

describe('parsePreviewBatchSpecBody', () => {
  it('parses valid body', () => {
    const out = parsePreviewBatchSpecBody({
      projectId: 'todolist',
      sprintId: '7e2dfe3f-8535-4f07-a538-e71dff86226d',
      rawText: '添加一个分享页面',
    });
    assert.equal(out.projectId, 'todolist');
    assert.equal(out.sprintId, '7e2dfe3f-8535-4f07-a538-e71dff86226d');
    assert.equal(out.rawText, '添加一个分享页面');
  });

  it('rejects empty rawText', () => {
    assert.throws(() =>
      parsePreviewBatchSpecBody({
        projectId: 'p',
        sprintId: 's',
        rawText: '   ',
      }),
    );
  });
});

describe('extractBalancedJsonSlice', () => {
  it('handles braces inside JSON strings', () => {
    const s = '{"a":"}"}';
    const bal = extractBalancedJsonSlice(s, 0);
    assert.equal(bal, s);
  });

  it('returns inner object when multiple top-level segments exist', () => {
    const text = 'x {"n":1} y {"tasks":[{"title":"t","dependsOnIndices":[]}]} z';
    const i = text.indexOf('{"tasks"');
    const bal = extractBalancedJsonSlice(text, i);
    assert.ok(bal);
    const o = JSON.parse(bal) as { tasks: unknown[] };
    assert.equal(o.tasks.length, 1);
  });
});

describe('extractJsonObjectFromAssistantText', () => {
  it('parses fenced JSON', () => {
    const out = extractJsonObjectFromAssistantText(
      'Here:\n```json\n{"tasks":[{"title":"A","dependsOnIndices":[]}]}\n```\n',
    ) as { tasks: { title: string }[] };
    assert.equal(out.tasks[0].title, 'A');
  });

  it('parses JSON after prose without fences', () => {
    const out = extractJsonObjectFromAssistantText(
      'Sure. {"tasks":[{"title":"B","dependsOnIndices":[]}]}',
    ) as { tasks: { title: string }[] };
    assert.equal(out.tasks[0].title, 'B');
  });

  it('prefers object with tasks when an earlier brace parses as other JSON', () => {
    const out = extractJsonObjectFromAssistantText(
      '{"ok":true} then {"tasks":[{"title":"C","dependsOnIndices":[]}]}',
    ) as { tasks: { title: string }[] };
    assert.equal(out.tasks[0].title, 'C');
  });
});

class ScriptedLLM implements LLMProvider {
  private index = 0;

  constructor(private readonly replies: string[]) {}

  streamChat(_params: StreamChatParams): ReadableStream<string> {
    const reply = this.replies[this.index++];
    if (reply === undefined) {
      throw new Error('No scripted reply available');
    }
    return new ReadableStream({
      start(controller) {
        controller.enqueue(sseEvent('text', reply));
        controller.enqueue(sseEvent('result', { session_id: 'test-session', is_error: false }));
        controller.close();
      },
    });
  }
}

describe('runBatchTaskSpecLlm', () => {
  it('repairs invalid dependency indices in a third-pass review', async () => {
    const provider = new ScriptedLLM([
      JSON.stringify({
        tasks: [
          { title: 'Landing page', dependsOnIndices: [] },
          { title: 'Game room', dependsOnIndices: [2] },
          { title: 'Spin result', dependsOnIndices: [1] },
        ],
      }),
      JSON.stringify({
        tasks: [
          { title: 'Landing page', dependsOnIndices: [] },
          { title: 'Game room', dependsOnIndices: [] },
          { title: 'Spin result', dependsOnIndices: [1] },
        ],
      }),
    ]);

    const tasks = await runBatchTaskSpecLlm({
      provider,
      workingDirectory: process.cwd(),
      rawText: 'Build a jackpot web app with a landing page, game room, and spin result flow.',
    });

    assert.deepEqual(tasks, [
      { title: 'Landing page', dependsOnIndices: [] },
      { title: 'Game room', dependsOnIndices: [] },
      { title: 'Spin result', dependsOnIndices: [1] },
    ]);
  });

  it('uses JSON repair first, then dependency review', async () => {
    const provider = new ScriptedLLM([
      'Here is the plan:\n```json\n{"tasks":[{"title":"Shell","dependsOnIndices":[]},{"title":"Wallet","dependsOnIndices":[2]},{"title":"History","dependsOnIndices":[0]}]}\n```',
      JSON.stringify({
        tasks: [
          { title: 'Shell', dependsOnIndices: [] },
          { title: 'Wallet', dependsOnIndices: [2] },
          { title: 'History', dependsOnIndices: [0] },
        ],
      }),
      JSON.stringify({
        tasks: [
          { title: 'Shell', dependsOnIndices: [] },
          { title: 'Wallet', dependsOnIndices: [2] },
          { title: 'History', dependsOnIndices: [0] },
        ],
      }),
      JSON.stringify({
        tasks: [
          { title: 'Shell', dependsOnIndices: [] },
          { title: 'Wallet', dependsOnIndices: [0] },
          { title: 'History', dependsOnIndices: [0] },
        ],
      }),
    ]);

    const tasks = await runBatchTaskSpecLlm({
      provider,
      workingDirectory: process.cwd(),
      rawText: 'Build shell first, then wallet and history.',
    });

    assert.deepEqual(tasks, [
      { title: 'Shell', dependsOnIndices: [] },
      { title: 'Wallet', dependsOnIndices: [0] },
      { title: 'History', dependsOnIndices: [0] },
    ]);
  });
});
