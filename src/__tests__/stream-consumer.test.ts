import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { consumeAgentStream } from '../platform/stream-consumer';
import { sseEvent } from '../sse-utils';

describe('consumeAgentStream', () => {
  it('returns timedOut when read exceeds timeoutMs', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        /* never close — timeout must win */
      },
    });

    const r = await consumeAgentStream(stream, { timeoutMs: 30 });
    assert.equal(r.timedOut, true);
    assert.equal(r.hasError, true);
    assert.match(r.errorMessage, /timed out after 30ms/);
  });

  it('completes normally when stream finishes before timeout', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(sseEvent('text', 'ok'));
        controller.enqueue(sseEvent('result', { session_id: 's1', is_error: false }));
        controller.close();
      },
    });

    const r = await consumeAgentStream(stream, { timeoutMs: 5000 });
    assert.equal(r.timedOut, undefined);
    assert.equal(r.responseText, 'ok');
    assert.equal(r.hasError, false);
  });
});
