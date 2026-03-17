import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CompensationService } from '../platform/compensation-service';
import { JsonPlatformStore } from '../platform/json-platform-store';
import { WorkflowService } from '../platform/workflow-service';
import {
  asGitService,
  asInstanceManager,
  asScmClient,
  createProject,
  createSprint,
  createTaskSession,
  FakeGitService,
  FakeInstanceManager,
  FakeScmClient,
  PLATFORM_DIR,
} from './platform-test-helpers';

describe('WorkflowService', () => {
  beforeEach(() => {
    fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
    process.env.CTI_JIRA_BASE_URL = 'https://jira.example.test';
    process.env.CTI_JIRA_EMAIL = 'bot@example.test';
    process.env.CTI_JIRA_API_TOKEN = 'token';
    process.env.CTI_JIRA_POLL_INTERVAL_MS = '1000';
  });

  function createHarness() {
    const store = new JsonPlatformStore();
    const gitService = new FakeGitService();
    const scmClient = new FakeScmClient();
    const instanceManager = new FakeInstanceManager(store);
    const project = createProject(store);

    const workflowService = new WorkflowService({
      store,
      gitService: asGitService(gitService),
      scmClient: asScmClient(scmClient),
      instanceManager: asInstanceManager(instanceManager),
      compensationService: new CompensationService(store, asInstanceManager(instanceManager)),
    });
    return { store, project, gitService, scmClient, instanceManager, workflowService };
  }

  it('starts a sprint branch from the project base branch', async () => {
    const { workflowService, project, gitService } = createHarness();
    const sprint = await workflowService.startSprint({
      projectId: project.id,
      sprintName: 'Sprint Alpha',
    });

    assert.equal(sprint.status, 'active');
    assert.equal(sprint.branchName, 'feature/sprint-alpha');
    assert.deepEqual(gitService.calls, ['createSprintBranch']);
  });

  it('assigns a Jira task to a developer agent and creates the task branch', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);

    const taskSession = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-101',
      title: 'Implement Jira workflow',
      runtime: 'codex',
    });
    assert.equal(taskSession.workflowState, 'in_progress');
    assert.equal(taskSession.branchName, 'dev/issue-101');
    assert.deepEqual(instanceManager.started, [`developer:${taskSession.id}`]);
    assert.deepEqual(gitService.calls, ['createTaskBranch']);
  });

  it('submits a task for review, pushes the branch, and starts a reviewer agent', async () => {
    const { workflowService, project, store, gitService, scmClient, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat(issue-101): implement jira workflow',
      prTitle: '[ISSUE-101] Implement Jira workflow',
      prBody: 'Automated PR body',
    });

    assert.equal(reviewResult.taskSession.workflowState, 'review');
    assert.equal(reviewResult.pullRequest.url, 'https://example.test/pr/42');
    assert.deepEqual(gitService.calls, ['commitAll', 'pushBranch']);
    assert.deepEqual(scmClient.calls, ['createPullRequest']);
    assert.deepEqual(instanceManager.started, [`reviewer:${taskSession.id}`]);
  });

  it('starts testing for a reviewed task and creates a tester instance', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
    });

    const testingTask = await workflowService.startTesting(taskSession.id);
    assert.equal(testingTask.workflowState, 'testing');
    assert.deepEqual(instanceManager.started, [`tester:${taskSession.id}`]);
  });

  it('returns tester failures to the developer queue and reopens the task', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
      messageQueueKey: 'task:ISSUE-101:inbox',
    });
    store.upsertAgentInstance({
      id: 'developer-instance-1',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'codex',
      role: 'developer',
      status: 'running',
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

    const returnedTask = await workflowService.handleTestFailure({
      taskSessionId: taskSession.id,
      summary: 'Jest suite failed',
      log: 'Expected 200, received 500',
    });

    assert.equal(returnedTask.workflowState, 'in_progress');
    assert.equal(store.peekTaskQueue(returnedTask.messageQueueKey).length, 1);
    assert.deepEqual(instanceManager.restarted, ['developer-instance-1']);
  });

  it('closes a tested task and stops all active instances for that task', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
    });
    for (const role of ['developer', 'reviewer', 'tester'] as const) {
      store.upsertAgentInstance({
        id: `${role}-instance`,
        projectId: project.id,
        sprintId: sprint.id,
        taskId: taskSession.taskId,
        taskSessionId: taskSession.id,
        runtime: 'codex',
        role,
        status: 'running',
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
    }

    const closedTask = await workflowService.closeTask(taskSession.id);
    assert.equal(closedTask.workflowState, 'closed');
    assert.deepEqual(instanceManager.stopped, [
      'developer-instance',
      'reviewer-instance',
      'tester-instance',
    ]);
  });

  it('resolves approvals through the instance manager', () => {
    const { workflowService, instanceManager } = createHarness();
    const resolved = workflowService.resolveApproval('approval-1', {
      behavior: 'allow',
      message: 'approved',
    });

    assert.equal(resolved, true);
    assert.deepEqual(instanceManager.approvalResponses, [
      {
        approvalId: 'approval-1',
        input: {
          behavior: 'allow',
          message: 'approved',
        },
      },
    ]);
  });

  it('handles Jira webhook transitions for in-progress assignment', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);

    const result = await workflowService.handleJiraWebhook({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-202',
      title: 'Investigate flaky test',
      status: 'In Progress',
      runtime: 'claude',
    });

    const taskSession = result as { id: string; workflowState: string };
    assert.equal(taskSession.workflowState, 'in_progress');
    assert.deepEqual(instanceManager.started, [`developer:${taskSession.id}`]);
  });

  it('handles Jira webhook transitions for review, testing, and close', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });

    const reviewResult = await workflowService.handleJiraWebhook({
      projectId: project.id,
      issueId: taskSession.issueId,
      status: 'review',
    });
    assert.equal((reviewResult as { workflowState: string }).workflowState, 'review');

    const reviewedTask = store.getTaskSession(taskSession.id);
    store.upsertTaskSession({
      ...reviewedTask!,
      workflowState: 'review',
    });
    const testingResult = await workflowService.handleJiraWebhook({
      projectId: project.id,
      issueId: taskSession.issueId,
      status: 'testing',
    });
    assert.equal((testingResult as { workflowState: string }).workflowState, 'testing');

    const testingTask = store.getTaskSession(taskSession.id);
    store.upsertTaskSession({
      ...testingTask!,
      workflowState: 'testing',
    });
    const closeResult = await workflowService.handleJiraWebhook({
      projectId: project.id,
      issueId: taskSession.issueId,
      status: 'done',
    });
    assert.equal((closeResult as { workflowState: string }).workflowState, 'closed');
  });
});
