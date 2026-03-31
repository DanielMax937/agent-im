import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { InstanceManager } from '../platform/instance-manager';
import { sseEvent } from '../sse-utils';
import {
  createProject,
  createSprint,
  createTaskSession,
  createTestJsonPlatformStore,
  PLATFORM_DIR,
  waitFor,
} from './platform-test-helpers';

describe('InstanceManager', () => {
  beforeEach(() => {
    fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
    InstanceManager.resetForTests();
  });

  function createStoreFixture() {
    const store = createTestJsonPlatformStore();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id);
    const instance = store.upsertAgentInstance({
      id: 'instance-1',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'codex',
      role: 'developer',
      status: 'starting',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/agent-im',
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { store, project, sprint, taskSession, instance };
  }

  it('starts an instance, consumes queued work, and stops cleanly with mocked LLM output', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'directive',
      content: 'Implement the change set',
    });

    const manager = InstanceManager.getInstance({
      store,
      providerFactory: async (_instance, _pendingPermissions) => ({
        streamChat() {
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(sseEvent('text', 'implementation complete'));
              controller.enqueue(sseEvent('result', { session_id: 'sdk-123', is_error: false }));
              controller.close();
            },
          });
        },
      }),
    });

    await manager.startInstance(instance.id);

    await waitFor(() => {
      const ts = store.getTaskSession(taskSession.id);
      assert.equal(ts?.conversationHistory.at(-1)?.content, 'implementation complete');
    });

    const updatedTaskSession = store.getTaskSession(taskSession.id);
    assert.equal(updatedTaskSession?.providerSessionId, 'sdk-123');
    assert.deepEqual(manager.listRunningInstanceIds(), [instance.id]);

    await manager.stopInstance(instance.id);
    assert.deepEqual(manager.listRunningInstanceIds(), []);
    assert.equal(store.getAgentInstance(instance.id)?.status, 'stopped');
  });

  it('resolves approval requests created by a mocked runtime stream', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'directive',
      content: 'Run the risky command',
    });

    const manager = InstanceManager.getInstance({
      store,
      providerFactory: async (_instance, pendingPermissions) => ({
        streamChat() {
          return new ReadableStream<string>({
            start(controller) {
              void (async () => {
                controller.enqueue(
                  sseEvent('permission_request', {
                    permissionRequestId: 'approval-1',
                    toolName: 'bash',
                    toolInput: 'npm test',
                  }),
                );
                const resolution = await pendingPermissions.waitFor('approval-1');
                controller.enqueue(sseEvent('text', `approval:${resolution.behavior}`));
                controller.enqueue(sseEvent('result', { session_id: 'sdk-approve', is_error: false }));
                controller.close();
              })();
            },
          });
        },
      }),
    });

    await manager.startInstance(instance.id);

    await waitFor(() => {
      assert.ok(store.getPendingApproval('approval-1'));
    });

    const resolved = manager.resolveApproval('approval-1', { behavior: 'allow' });
    assert.equal(resolved, true);

    await waitFor(() => {
      assert.equal(store.getPendingApproval('approval-1')?.status, 'approved');
    });

    await manager.stopInstance(instance.id);
  });

  it('reconciles persisted instances and stops runners removed from storage', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'directive',
      content: 'noop',
    });
    store.upsertAgentInstance({
      ...instance,
      status: 'running',
    });

    const manager = InstanceManager.getInstance({
      store,
      providerFactory: async (_instance, _pendingPermissions) => ({
        streamChat() {
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(sseEvent('result', { session_id: 'sdk-reconcile', is_error: false }));
              controller.close();
            },
          });
        },
      }),
    });

    await manager.reconcile();
    await waitFor(() => {
      assert.deepEqual(manager.listRunningInstanceIds(), [instance.id]);
    });

    store.removeAgentInstance(instance.id);
    await manager.reconcile();
    assert.deepEqual(manager.listRunningInstanceIds(), []);
  });
});
