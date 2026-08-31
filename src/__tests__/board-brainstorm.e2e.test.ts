import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPlatformApp } from '../platform/app';
import type { BoardBrainstormChatInput } from '../platform/board-brainstorm';
import {
  asInstanceManager,
  createTestJsonPlatformStore,
  FakeInstanceManager,
  fetchJson,
  startHttpApp,
} from './platform-test-helpers';

describe('Board brainstorm E2E', () => {
  function createHarness() {
    const store = createTestJsonPlatformStore();
    const instanceManager = new FakeInstanceManager(store);
    const calls: BoardBrainstormChatInput[] = [];
    const workflowService = {
      async streamBoardBrainstormChat(input: BoardBrainstormChatInput): Promise<ReadableStream<string>> {
        calls.push(input);
        const text = input.intent === 'revise' ? '# 方案稿\n\nrevised' : '# 方案稿\n\ndraft';
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-1' }) })}\n\n`);
            controller.close();
          },
        });
      },
    } as unknown as Parameters<typeof createPlatformApp>[0]['workflowService'];
    const app = createPlatformApp({
      store,
      workflowService,
      instanceManager: asInstanceManager(instanceManager),
    });
    return { app, calls };
  }

  it('streams a draft request through the brainstorm endpoint', async () => {
    const { app, calls } = createHarness();
    const server = await startHttpApp(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/workflows/board-brainstorm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'draft',
          projectId: 'project-1',
          sessionId: 'session-1',
          message: 'make draft',
          conversationHistory: [{ role: 'user', content: 'build revision UI' }],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /# 方案稿/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.intent, 'draft');
      assert.equal(calls[0]?.conversationHistory[0]?.content, 'build revision UI');
    } finally {
      await server.close();
    }
  });

  it('streams a revise request with the selected draft', async () => {
    const { app, calls } = createHarness();
    const server = await startHttpApp(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/workflows/board-brainstorm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'revise',
          projectId: 'project-1',
          sessionId: 'session-1',
          message: 'shrink to MVP',
          currentDraft: '# 方案稿\n\nold',
        }),
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /revised/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.intent, 'revise');
      assert.equal(calls[0]?.currentDraft, '# 方案稿\n\nold');
    } finally {
      await server.close();
    }
  });

  it('rejects invalid revise requests before streaming', async () => {
    const { app, calls } = createHarness();
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, '/api/workflows/board-brainstorm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'revise',
          projectId: 'project-1',
          sessionId: 'session-1',
          message: 'shrink to MVP',
        }),
      });
      assert.equal(response.status, 400);
      assert.match((response.body as { error?: string }).error ?? '', /currentDraft is required/);
      assert.equal(calls.length, 0);
    } finally {
      await server.close();
    }
  });
});
