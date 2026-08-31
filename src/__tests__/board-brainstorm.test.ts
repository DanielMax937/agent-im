import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildBoardBrainstormSystemPrompt, parseBoardBrainstormChatInput } from '../platform/board-brainstorm';

describe('parseBoardBrainstormChatInput', () => {
  it('parses minimal valid body', () => {
    const out = parseBoardBrainstormChatInput({
      projectId: 'p1',
      message: 'hello',
      sessionId: 'sess-1',
    });
    assert.equal(out.projectId, 'p1');
    assert.equal(out.message, 'hello');
    assert.equal(out.sessionId, 'sess-1');
    assert.equal(out.intent, 'chat');
    assert.deepEqual(out.conversationHistory, []);
    assert.equal(out.sdkSessionId, undefined);
  });

  it('parses history and sdkSessionId', () => {
    const out = parseBoardBrainstormChatInput({
      projectId: 'p1',
      message: 'next',
      sessionId: 'sess-1',
      sdkSessionId: 'thread-abc',
      conversationHistory: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    });
    assert.equal(out.sdkSessionId, 'thread-abc');
    assert.equal(out.conversationHistory.length, 2);
  });

  it('parses draft intent', () => {
    const out = parseBoardBrainstormChatInput({
      intent: 'draft',
      projectId: 'p1',
      message: 'make draft',
      sessionId: 'sess-1',
      conversationHistory: [{ role: 'user', content: 'goal' }],
    });
    assert.equal(out.intent, 'draft');
  });

  it('parses revise intent with currentDraft', () => {
    const out = parseBoardBrainstormChatInput({
      intent: 'revise',
      projectId: 'p1',
      message: 'smaller scope',
      sessionId: 'sess-1',
      currentDraft: '# draft',
    });
    assert.equal(out.intent, 'revise');
    assert.equal(out.currentDraft, '# draft');
  });

  it('rejects empty message', () => {
    assert.throws(() =>
      parseBoardBrainstormChatInput({
        projectId: 'p1',
        message: '   ',
        sessionId: 's',
      }),
    );
  });

  it('rejects revise intent without currentDraft', () => {
    assert.throws(() =>
      parseBoardBrainstormChatInput({
        intent: 'revise',
        projectId: 'p1',
        message: 'smaller scope',
        sessionId: 'sess-1',
      }),
    );
  });

  it('rejects invalid intent', () => {
    assert.throws(() =>
      parseBoardBrainstormChatInput({
        intent: 'other',
        projectId: 'p1',
        message: 'hello',
        sessionId: 'sess-1',
      }),
    );
  });

  it('builds draft prompt constraints', () => {
    const prompt = buildBoardBrainstormSystemPrompt({
      intent: 'draft',
      laneHints: ['Use React patterns'],
    });
    assert.match(prompt, /Current request intent: draft/);
    assert.match(prompt, /complete structured Markdown design draft/i);
    assert.match(prompt, /## 验收标准/);
    assert.match(prompt, /- Use React patterns/);
  });

  it('builds revise prompt with current draft', () => {
    const prompt = buildBoardBrainstormSystemPrompt({
      intent: 'revise',
      currentDraft: '# 方案稿\n\nold',
      vercelFramework: 'nextjs',
      laneHints: [],
    });
    assert.match(prompt, /Current request intent: revise/);
    assert.match(prompt, /Current draft:\n# 方案稿\n\nold/);
    assert.match(prompt, /Vercel framework preset for this project: nextjs/);
  });
});
