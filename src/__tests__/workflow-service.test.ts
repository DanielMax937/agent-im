import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { CompensationService } from '../platform/compensation-service.js';
import { JsonPlatformStore } from '../platform/json-platform-store.js';
import type { PullRequestRef } from '../platform/scm-client.js';
import type { AgentInstanceRecord, Project } from '../platform/types.js';
import { WorkflowService } from '../platform/workflow-service.js';
import type { GitService } from '../platform/git-service.js';
import type { InstanceManager } from '../platform/instance-manager.js';

const PLATFORM_DIR = path.join(CTI_HOME, 'data', 'platform');

class FakeGitService {
  public calls: string[] = [];

  async createSprintBranch(): Promise<string> {
    this.calls.push('createSprintBranch');
    return 'feature/sprint-alpha';
  }

  async createTaskBranch(): Promise<string> {
    this.calls.push('createTaskBranch');
    return 'dev/issue-101';
  }

  async commitAll(): Promise<{ committed: boolean }> {
    this.calls.push('commitAll');
    return { committed: true };
  }

  async pushBranch(): Promise<void> {
    this.calls.push('pushBranch');
  }
}

class FakeScmClient {
  async createPullRequest(): Promise<PullRequestRef> {
    return {
      url: 'https://example.test/pr/42',
      number: 42,
    };
  }
}

describe('WorkflowService', () => {
  beforeEach(() => {
    fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
    process.env.CTI_JIRA_BASE_URL = 'https://jira.example.test';
    process.env.CTI_JIRA_EMAIL = 'bot@example.test';
    process.env.CTI_JIRA_API_TOKEN = 'token';
    process.env.CTI_JIRA_POLL_INTERVAL_MS = '1000';
  });

  it('orchestrates sprint, task, review, testing, and failed-test compensation', async () => {
    const store = new JsonPlatformStore();
    const project: Project = store.upsertProject({
      id: 'project-1',
      name: 'agent-im',
      repository: {
        remoteUrl: 'git@example.test:agent-im.git',
        localPath: '/tmp/agent-im',
        baseBranch: 'master',
        sprintBranchPrefix: 'feature/',
        taskBranchPrefix: 'dev/',
        scmProvider: 'github',
        scmProject: 'demo/agent-im',
        scmTokenEnvVar: 'GITHUB_TOKEN',
      },
      agents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const gitService = new FakeGitService();
    const startedInstances: string[] = [];
    const stoppedInstances: string[] = [];
    const fakeInstanceManager = {
      async upsertAndStart(instance: AgentInstanceRecord) {
        startedInstances.push(`${instance.role}:${instance.taskSessionId}`);
        return store.upsertAgentInstance({
          ...instance,
          status: 'running',
        });
      },
      async startInstance(instanceId: string) {
        startedInstances.push(`restart:${instanceId}`);
      },
      async stopInstance(instanceId: string) {
        stoppedInstances.push(instanceId);
      },
      resolveApproval() {
        return true;
      },
    } as unknown as InstanceManager;

    const workflowService = new WorkflowService({
      store,
      gitService: gitService as unknown as GitService,
      scmClient: new FakeScmClient(),
      instanceManager: fakeInstanceManager,
      compensationService: new CompensationService(store, fakeInstanceManager),
    });

    const sprint = await workflowService.startSprint({
      projectId: project.id,
      sprintName: 'Sprint Alpha',
    });
    assert.equal(sprint.status, 'active');
    assert.equal(sprint.branchName, 'feature/sprint-alpha');

    const taskSession = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-101',
      title: 'Implement Jira workflow',
      runtime: 'codex',
    });
    assert.equal(taskSession.workflowState, 'in_progress');
    assert.equal(taskSession.branchName, 'dev/issue-101');
    assert.equal(startedInstances.length, 1);

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat(issue-101): implement jira workflow',
      prTitle: '[ISSUE-101] Implement Jira workflow',
      prBody: 'Automated PR body',
    });
    assert.equal(reviewResult.taskSession.workflowState, 'review');
    assert.equal(reviewResult.pullRequest.url, 'https://example.test/pr/42');
    assert.deepEqual(gitService.calls, [
      'createSprintBranch',
      'createTaskBranch',
      'commitAll',
      'pushBranch',
    ]);

    const testingTask = await workflowService.startTesting(taskSession.id);
    assert.equal(testingTask.workflowState, 'testing');
    assert.equal(startedInstances.length, 3);

    const returnedTask = await workflowService.handleTestFailure({
      taskSessionId: taskSession.id,
      summary: 'Jest suite failed',
      log: 'Expected 200, received 500',
    });
    assert.equal(returnedTask.workflowState, 'in_progress');
    assert.equal(store.peekTaskQueue(returnedTask.messageQueueKey).length, 1);
    assert.equal(startedInstances.length, 4);

    await workflowService.startTesting(taskSession.id);
    const closedTask = await workflowService.closeTask(taskSession.id);
    assert.equal(closedTask.workflowState, 'closed');
    assert.equal(stoppedInstances.length, 3);
  });
});
