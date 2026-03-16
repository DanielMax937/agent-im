import { JsonPlatformStore } from './json-platform-store.js';
import type { TaskFailurePayload } from './types.js';
import { InstanceManager } from './instance-manager.js';

export class CompensationService {
  constructor(
    private readonly store: JsonPlatformStore,
    private readonly instanceManager: InstanceManager,
  ) {}

  async returnTaskToDeveloper(payload: TaskFailurePayload): Promise<void> {
    const taskSession = this.store.getTaskSession(payload.taskSessionId);
    if (!taskSession) {
      throw new Error(`Task session not found: ${payload.taskSessionId}`);
    }

    const failureMessage = [
      'Tester reported a failure. Please fix the task and rerun validation.',
      '',
      `Summary: ${payload.summary}`,
      '',
      'Logs:',
      payload.log,
    ].join('\n');

    this.store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      type: 'test_failure',
      content: failureMessage,
    });

    this.store.appendConversationEntry(taskSession.id, {
      role: 'system',
      source: 'workflow',
      content: `Queued tester feedback for developer:\n${failureMessage}`,
    });

    this.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'in_progress',
      lastError: payload.summary,
    });

    const developerInstance = this.store.findAgentInstance(taskSession.id, 'developer');
    if (developerInstance) {
      await this.instanceManager.startInstance(developerInstance.id);
    }
  }
}
