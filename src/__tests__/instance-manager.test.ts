import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { JsonPlatformStore } from '../platform/json-platform-store.js';
import { InstanceManager } from '../platform/instance-manager.js';
import type { JiraApiClient, JiraComment } from '../platform/jira-adapter.js';
import { sseEvent } from '../sse-utils.js';
import {
  createProject,
  createSprint,
  createTaskSession,
  PLATFORM_DIR,
  waitFor,
} from './platform-test-helpers.js';

class FakeJiraClient implements JiraApiClient {
  public comments: JiraComment[] = [];
  public createdBodies: string[] = [];

  async listIssueComments(): Promise<JiraComment[]> {
    return [...this.comments];
  }

  async createIssueComment(_issueId: string, body: string): Promise<{ id: string }> {
    this.createdBodies.push(body);
    return { id: `comment-${this.createdBodies.length}` };
  }
}

describe('InstanceManager', () => {
  beforeEach(() => {
    fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
    InstanceManager.resetForTests();
  });

  function createStoreFixture() {
    const store = new JsonPlatformStore();
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
      jira: {
        baseUrl: 'https://jira.example.test',
        issueId: taskSession.issueId,
        email: 'bot@example.test',
        apiToken: 'token',
        pollIntervalMs: 1000,
      },
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { store, project, sprint, taskSession, instance };
  }

  it('starts an instance, consumes queued work, and stops cleanly with mocked LLM output', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    const jiraClient = new FakeJiraClient();
    store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'directive',
      content: 'Implement the change set',
    });

    const manager = InstanceManager.getInstance({
      store,
      jiraClientFactory: () => jiraClient,
      providerFactory: async () => ({
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
      assert.equal(jiraClient.createdBodies.some((body) => body.includes('implementation complete')), true);
    });

    const updatedTaskSession = store.getTaskSession(taskSession.id);
    assert.equal(updatedTaskSession?.providerSessionId, 'sdk-123');
    assert.equal(updatedTaskSession?.conversationHistory.at(-1)?.content, 'implementation complete');
    assert.deepEqual(manager.listRunningInstanceIds(), [instance.id]);

    await manager.stopInstance(instance.id);
    assert.deepEqual(manager.listRunningInstanceIds(), []);
    assert.equal(store.getAgentInstance(instance.id)?.status, 'stopped');
  });

  it('resolves approval requests created by a mocked runtime stream', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    const jiraClient = new FakeJiraClient();
    store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'directive',
      content: 'Run the risky command',
    });

    const manager = InstanceManager.getInstance({
      store,
      jiraClientFactory: () => jiraClient,
      approvalBaseUrl: 'http://localhost:8787',
      providerFactory: async (_runtime, pendingPermissions) => ({
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
      assert.equal(jiraClient.createdBodies.some((body) => body.includes('Approval required for bash.')), true);
    });

    const resolved = manager.resolveApproval('approval-1', { behavior: 'allow' });
    assert.equal(resolved, true);

    await waitFor(() => {
      assert.equal(store.getPendingApproval('approval-1')?.status, 'approved');
      assert.equal(jiraClient.createdBodies.some((body) => body.includes('approval:allow')), true);
    });

    await manager.stopInstance(instance.id);
  });

  it('reconciles persisted instances and stops runners removed from storage', async () => {
    const { store, taskSession, instance } = createStoreFixture();
    const jiraClient = new FakeJiraClient();
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
      jiraClientFactory: () => jiraClient,
      providerFactory: async () => ({
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
