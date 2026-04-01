import assert from 'node:assert';
import { describe, it } from 'node:test';

import { parseBoardBrainstormChatInput } from '../platform/board-brainstorm';

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

  it('rejects empty message', () => {
    assert.throws(() =>
      parseBoardBrainstormChatInput({
        projectId: 'p1',
        message: '   ',
        sessionId: 's',
      }),
    );
  });
});
