import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompensationService } from '../platform/compensation-service';
import { WorkflowService } from '../platform/workflow-service';
import {
  asGitService,
  asInstanceManager,
  asScmClient,
  createProject,
  createSprint,
  createTaskSession,
  createTestJsonPlatformStore,
  TEST_DEFAULT_RUNNER_ID,
  FakeGitService,
  FakeInstanceManager,
  FakeScmClient,
  resetTestPlatformDir,
} from './platform-test-helpers';

describe('WorkflowService', () => {
  beforeEach(() => {
    resetTestPlatformDir();
  });

  function createHarness() {
    const store = createTestJsonPlatformStore();
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

  class InspectingInstanceManager extends FakeInstanceManager {
    public reviewTaskSnapshots: Array<{ taskSessionId: string; conversationHistoryContents: string[] }> = [];

    constructor(private readonly inspectStore: ReturnType<typeof createTestJsonPlatformStore>) {
      super(inspectStore);
    }

    override async upsertAndStart(instance: Parameters<FakeInstanceManager['upsertAndStart']>[0]) {
      const task = this.inspectStore.getTaskSession(instance.taskSessionId);
      if (instance.role === 'reviewer' && task) {
        this.reviewTaskSnapshots.push({
          taskSessionId: task.id,
          conversationHistoryContents: task.conversationHistory.map((entry) => entry.content),
        });
      }
      return super.upsertAndStart(instance);
    }
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

  it('rejects startSprint when an active sprint with the same display name already exists', async () => {
    const { workflowService, project, store, gitService } = createHarness();
    await workflowService.startSprint({ projectId: project.id, sprintName: 'Sprint Dup' });
    await assert.rejects(
      () => workflowService.startSprint({ projectId: project.id, sprintName: 'Sprint Dup' }),
      /Sprint already exists/,
    );
    assert.equal(gitService.calls.filter((c) => c === 'createSprintBranch').length, 1);
    assert.equal(store.listSprints(project.id).length, 1);
  });

  it('rejects assign when any agent lane lacks default runner (kanbanRoleRunners)', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    store.upsertProject({
      ...project,
      kanbanRoleRunners: { 'agent-dev': TEST_DEFAULT_RUNNER_ID },
    });
    const created = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-ASSIGN-GATE',
      title: 'gate',
    });
    await assert.rejects(
      () =>
        workflowService.assignTask({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-ASSIGN-GATE',
          taskSessionId: created.id,
          kanbanAgent: 'agent-dev',
        }),
      /missing: pre-tester/,
    );
  });

  it('assigns a task to a developer agent and creates the task branch', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);

    const taskSession = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-101',
      title: 'Implement workflow',
      runtime: 'cursor',
    });
    assert.equal(taskSession.workflowState, 'in_progress');
    assert.equal(taskSession.branchName, 'dev/issue-101');
    assert.deepEqual(instanceManager.started, [`developer:${taskSession.id}`]);
    assert.deepEqual(gitService.calls, ['createTaskWorktree']);
  });

  it('submits a task for review, pushes the branch, and starts a reviewer agent', async () => {
    const { workflowService, project, store, gitService, scmClient, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
    });

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat(issue-101): implement workflow',
      prTitle: '[ISSUE-101] Implement workflow',
      prBody: 'Automated PR body',
    });

    assert.equal(reviewResult.taskSession.workflowState, 'review');
    assert.equal(reviewResult.pullRequest.url, 'https://example.test/pr/42');
    assert.deepEqual(gitService.calls, ['commitAll', 'pushBranch']);
    assert.deepEqual(scmClient.calls, [
      'findOpenPullRequest:dev/issue-101->feature/sprint-alpha',
      'createPullRequest',
      'getPullRequestMergeStatus',
    ]);
    assert.deepEqual(instanceManager.started, [`reviewer:${taskSession.id}`]);
    assert.ok(
      reviewResult.taskSession.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Host PR status:'),
      ),
    );
  });

  it('persists PR workflow notes before reviewer startup', async () => {
    const store = createTestJsonPlatformStore();
    const gitService = new FakeGitService();
    const scmClient = new FakeScmClient();
    scmClient.mergeStatusResult = { canMerge: false, reason: 'mergeable_state=dirty' };
    const instanceManager = new InspectingInstanceManager(store);
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const workflowService = new WorkflowService({
      store,
      gitService: asGitService(gitService),
      scmClient: asScmClient(scmClient),
      instanceManager: asInstanceManager(instanceManager),
      compensationService: new CompensationService(store, asInstanceManager(instanceManager)),
    });
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
    });

    await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat(issue-101): implement workflow',
      prTitle: '[ISSUE-101] Implement workflow',
      prBody: 'Automated PR body',
    });

    assert.equal(instanceManager.reviewTaskSnapshots.length, 1);
    const snapshot = instanceManager.reviewTaskSnapshots[0]!;
    assert.ok(snapshot.conversationHistoryContents.some((line) => line.includes('Created/reused PR https://example.test/pr/42')));
    assert.ok(snapshot.conversationHistoryContents.some((line) => line.includes('Host PR status: not merge-ready yet (PR #42)')));
  });

  it('submitTaskForReview treats create PR error as success when an open PR is found on retry', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    scmClient.createPullRequestError = new Error('pull request already exists');
    scmClient.findOpenPullRequestResults = [
      null,
      { url: 'https://example.test/pr/existing', number: 99 },
    ];
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
    });

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat(issue-101): implement workflow',
      prTitle: '[ISSUE-101] Implement workflow',
      prBody: 'Automated PR body',
    });

    assert.equal(reviewResult.taskSession.workflowState, 'review');
    assert.equal(reviewResult.pullRequest.url, 'https://example.test/pr/existing');
    assert.equal(reviewResult.pullRequest.number, 99);
    assert.deepEqual(scmClient.calls, [
      'findOpenPullRequest:dev/issue-101->feature/sprint-alpha',
      'createPullRequest',
      'findOpenPullRequest:dev/issue-101->feature/sprint-alpha',
      'getPullRequestMergeStatus',
    ]);
    const updated = store.getTaskSession(taskSession.id)!;
    assert.equal(updated.pullRequestUrl, 'https://example.test/pr/existing');
    assert.equal(updated.pullRequestNumber, 99);
  });

  it('maybeAutoAdvanceAfterAgentTurn opens PR when tester ends with KANBAN_ACTION:SUBMIT_REVIEW', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
      conversationHistory: [],
    });
    store.appendConversationEntry(taskSession.id, {
      role: 'assistant',
      source: 'tester',
      content: 'Tests passed.\nKANBAN_ACTION:SUBMIT_REVIEW',
    });

    await workflowService.maybeAutoAdvanceAfterAgentTurn(taskSession.id, 'tester', 'tester-instance');

    const updated = store.getTaskSession(taskSession.id)!;
    assert.equal(updated.workflowState, 'review');
    assert.deepEqual(gitService.calls, ['commitAll', 'pushBranch']);
    assert.deepEqual(instanceManager.started, [`reviewer:${taskSession.id}`]);
  });

  it('maybeAutoAdvanceAfterAgentTurn does nothing when CTI_KANBAN_WORKFLOW_AUTO=0', async () => {
    const prev = process.env.CTI_KANBAN_WORKFLOW_AUTO;
    process.env.CTI_KANBAN_WORKFLOW_AUTO = '0';
    try {
      const { workflowService, project, store, gitService } = createHarness();
      const sprint = createSprint(store, project.id);
      const taskSession = createTaskSession(store, project.id, sprint.id, {
        workflowState: 'testing',
        conversationHistory: [],
      });
      store.appendConversationEntry(taskSession.id, {
        role: 'assistant',
        source: 'tester',
        content: 'Done.\nKANBAN_ACTION:SUBMIT_REVIEW',
      });

      await workflowService.maybeAutoAdvanceAfterAgentTurn(taskSession.id, 'tester', 'tester-instance');

      assert.equal(store.getTaskSession(taskSession.id)!.workflowState, 'testing');
      assert.deepEqual(gitService.calls, []);
    } finally {
      if (prev === undefined) {
        delete process.env.CTI_KANBAN_WORKFLOW_AUTO;
      } else {
        process.env.CTI_KANBAN_WORKFLOW_AUTO = prev;
      }
    }
  });

  it('afterSuccessfulAssistantTurn requeues system_check for the role that owns the current state', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
      conversationHistory: [],
      confirmationLoopCount: 0,
    });
    store.upsertAgentInstance({
      id: 'tester-instance-1',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'copilot',
      role: 'tester',
      status: 'running',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/agent-im',
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.appendConversationEntry(taskSession.id, {
      role: 'assistant',
      source: 'developer',
      content: 'Work is done, but no valid action was emitted.',
    });

    await workflowService.afterSuccessfulAssistantTurn(taskSession.id, 'developer', 'developer-instance');

    const queued = store.peekTaskQueue(taskSession.messageQueueKey);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.type, 'system_check');
    assert.match(queued[0]!.content, /Your role for this lane: tester\./);
    assert.match(queued[0]!.content, /`KANBAN_ACTION:SUBMIT_REVIEW`/);
    assert.ok(instanceManager.restarted.includes('tester-instance-1'));
  });

  it('resumeKanbanAfterRestart repairs deleted worktree paths before restarting the active lane', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      workingDirectory: '/tmp/missing-wt-todolist-8',
      worktreePath: '/tmp/missing-wt-todolist-8',
      conversationHistory: [],
    });
    store.upsertAgentInstance({
      id: 'reviewer-instance-1',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'claude',
      role: 'reviewer',
      status: 'error',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/missing-wt-todolist-8',
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await workflowService.resumeKanbanAfterRestart();

    const updatedTask = store.getTaskSession(taskSession.id)!;
    assert.equal(updatedTask.workingDirectory, project.repository.localPath);
    assert.equal(updatedTask.worktreePath, undefined);
    const updatedInstance = store.getAgentInstance('reviewer-instance-1')!;
    assert.equal(updatedInstance.workingDirectory, project.repository.localPath);
    assert.equal(updatedInstance.status, 'starting');
  });

  it('normalizeTaskWorkingCopy also repairs persisted running instance working directories', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      workingDirectory: project.repository.localPath,
      worktreePath: undefined,
      conversationHistory: [],
    });
    store.upsertAgentInstance({
      id: 'reviewer-instance-running',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'claude',
      role: 'reviewer',
      status: 'running',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/missing-wt-todolist-9',
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await workflowService.resumeKanbanAfterRestart();

    const updatedInstance = store.getAgentInstance('reviewer-instance-running')!;
    assert.equal(updatedInstance.workingDirectory, project.repository.localPath);
  });

  it('addTaskHistoryComment appends manual history entry', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });
    const next = await workflowService.addTaskHistoryComment(taskSession.id, {
      content: 'Ship checklist ok',
      role: 'tester',
    });
    assert.equal(next.historyComments?.length, 1);
    assert.equal(next.historyComments![0].kind, 'manual');
    assert.equal(next.historyComments![0].content, 'Ship checklist ok');
    assert.equal(next.historyComments![0].role, 'tester');
  });

  it('startTesting appends transition history with outgoing developer summary', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
      conversationHistory: [
        {
          id: 'a1',
          role: 'assistant',
          source: 'developer',
          content: 'Implemented the API endpoint.',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const next = await workflowService.startTesting(taskSession.id);
    assert.equal(next.workflowState, 'pre_testing');
    assert.ok(next.historyComments && next.historyComments.length >= 1);
    const h = next.historyComments![next.historyComments!.length - 1]!;
    assert.equal(h.kind, 'transition');
    assert.ok(h.content.includes('Implemented the API endpoint'));
  });

  it('starts pre-testing from development and creates a tester instance', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });

    const testingTask = await workflowService.startTesting(taskSession.id);
    assert.equal(testingTask.workflowState, 'pre_testing');
    assert.deepEqual(instanceManager.started, [`tester:${taskSession.id}`]);
  });

  it('starts feature testing from pre-testing and keeps tester ownership', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'pre_testing',
      role: 'tester',
      kanbanAgent: 'pre-tester',
    });

    const testingTask = await workflowService.startFeatureTesting(taskSession.id);
    assert.equal(testingTask.workflowState, 'testing');
    assert.equal(testingTask.kanbanAgent, 'copilot-test');
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
      runtime: 'cursor',
      role: 'developer',
      status: 'running',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/agent-im',
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

  it('returns regression_testing failures to the developer queue (F2)', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
      messageQueueKey: 'task:ISSUE-202:inbox',
    });
    store.upsertAgentInstance({
      id: 'developer-instance-reg',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: 'cursor',
      role: 'developer',
      status: 'running',
      branchName: taskSession.branchName,
      workingDirectory: '/tmp/agent-im',
      approvalsRequired: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const returnedTask = await workflowService.handleTestFailure({
      taskSessionId: taskSession.id,
      summary: 'Regression suite failed',
      log: 'Exit code 1',
    });

    assert.equal(returnedTask.workflowState, 'in_progress');
    assert.equal(store.peekTaskQueue(returnedTask.messageQueueKey).length, 1);
    assert.deepEqual(instanceManager.restarted, ['developer-instance-reg']);
  });

  it('proceedToPendingRelease then closeTask ensures release PR to base and stops instances', async () => {
    const { workflowService, project, store, instanceManager, scmClient } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
    });
    for (const role of ['developer', 'reviewer', 'tester'] as const) {
      store.upsertAgentInstance({
        id: `${role}-instance`,
        projectId: project.id,
        sprintId: sprint.id,
        taskId: taskSession.taskId,
        taskSessionId: taskSession.id,
        runtime: 'cursor',
        role,
        status: 'running',
        branchName: taskSession.branchName,
        workingDirectory: '/tmp/agent-im',
        approvalsRequired: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const pending = await workflowService.proceedToPendingRelease(taskSession.id);
    assert.equal(pending.workflowState, 'pending_release');
    assert.equal(pending.releasePullRequestUrl, 'https://example.test/pr/42');
    assert.equal(pending.releasePullRequestNumber, 42);
    assert.ok(scmClient.calls.some((c) => c.startsWith('findOpenPullRequest:')));
    assert.ok(scmClient.calls.includes('createPullRequest'));
    assert.ok(scmClient.calls.includes('postPullRequestDiscussionComment'));

    // Simulate human merging the release PR on the host.
    scmClient.mergeStatusResult = { canMerge: false, terminalState: 'merged', reason: 'PR is already merged' };
    const closedTask = await workflowService.closeTask(taskSession.id);
    assert.equal(closedTask.workflowState, 'closed');
    assert.ok(instanceManager.stopped.includes('developer-instance'));
    assert.ok(instanceManager.stopped.includes('reviewer-instance'));
    assert.ok(instanceManager.stopped.includes('tester-instance'));
  });

  it('proceedToPendingRelease reuses existing release PR when findOpenPullRequest returns one', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    scmClient.findOpenPullRequestResult = { url: 'https://example.test/pr/existing', number: 99 };
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
    });
    const pending = await workflowService.proceedToPendingRelease(taskSession.id);
    assert.equal(pending.workflowState, 'pending_release');
    assert.equal(pending.releasePullRequestUrl, 'https://example.test/pr/existing');
    assert.equal(pending.releasePullRequestNumber, 99);
    assert.ok(scmClient.calls.includes('findOpenPullRequest:feature/sprint-alpha->master'));
    assert.ok(!scmClient.calls.includes('createPullRequest'));
    assert.ok(scmClient.calls.includes('postPullRequestDiscussionComment'));
    // Simulate human merging the release PR on the host.
    scmClient.mergeStatusResult = { canMerge: false, terminalState: 'merged', reason: 'PR is already merged' };
    await workflowService.closeTask(taskSession.id);
  });

  it('proceedToPendingRelease skips release PR when sprint branch equals repo base', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    const sprint = createSprint(store, project.id, { branchName: 'master' });
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
    });
    const pending = await workflowService.proceedToPendingRelease(taskSession.id);
    assert.equal(pending.workflowState, 'pending_release');
    assert.equal(pending.releasePullRequestUrl, undefined);
    assert.deepEqual(scmClient.calls, []);
    await workflowService.closeTask(taskSession.id);
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

  it('creates a task in todo without starting a runner', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const task = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-TODO',
      title: 'Kanban card',
    });
    assert.equal(task.workflowState, 'todo');
    assert.equal(instanceManager.started.length, 0);
  });

  it('createTasksFromBatchPlan maps dependsOnIndices to dependsOnIssueIds on created tasks', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const { created } = await workflowService.createTasksFromBatchPlan({
      projectId: project.id,
      sprintId: sprint.id,
      tasks: [
        { title: 'A', dependsOnIndices: [] },
        { title: 'B', dependsOnIndices: [0] },
        { title: 'C', dependsOnIndices: [0, 1] },
      ],
    });
    assert.equal(created.length, 3);
    assert.equal(created[0]!.dependsOnIssueIds, undefined);
    assert.deepEqual(created[1]!.dependsOnIssueIds, [created[0]!.issueId]);
    assert.deepEqual(created[2]!.dependsOnIssueIds, [created[0]!.issueId, created[1]!.issueId]);
  });

  it('deleteTask removes task session and sprint link', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const task = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      title: 'To delete',
    });
    await workflowService.deleteTask(task.id);
    assert.equal(store.getTaskSession(task.id), null);
    const sp = store.getSprint(sprint.id)!;
    assert.ok(!sp.taskIds.includes(task.id));
  });

  it('resumeKanbanAfterRestart moves regression task to pending_release when last reply has PROCEED_TO_RELEASE or legacy CLOSE', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const iso = new Date().toISOString();
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
      role: 'tester',
      kanbanAgent: 'copilot-test',
      kanbanAssignees: { 'copilot-test': 'm1' },
      conversationHistory: [
        {
          id: 'e1',
          role: 'assistant',
          source: 'tester',
          content: 'Regression passed.\nKANBAN_ACTION:PROCEED_TO_RELEASE',
          createdAt: iso,
        },
      ],
    });

    await workflowService.resumeKanbanAfterRestart();

    const t = store.getTaskSession(taskSession.id);
    assert.equal(t?.workflowState, 'pending_release');
  });

  it('resumeKanbanAfterRestart closes task when pending_release and last reply contains CLOSE', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const iso = new Date().toISOString();
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'pending_release',
      role: 'tester',
      kanbanAgent: 'copilot-test',
      kanbanAssignees: { 'copilot-test': 'm1' },
      conversationHistory: [
        {
          id: 'e1',
          role: 'assistant',
          source: 'tester',
          content: 'Merged.\nKANBAN_ACTION:CLOSE',
          createdAt: iso,
        },
      ],
    });

    await workflowService.resumeKanbanAfterRestart();

    const t = store.getTaskSession(taskSession.id);
    assert.equal(t?.workflowState, 'closed');
    assert.equal(t?.kanbanAssignees, undefined);
  });

  it('deleteTask stops every agent instance for the task (same stop path as closeTask)', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
    });
    const now = new Date().toISOString();
    for (const spec of [
      { id: 'reviewer-inst', role: 'reviewer' as const },
      { id: 'developer-inst', role: 'developer' as const },
    ]) {
      store.upsertAgentInstance({
        id: spec.id,
        projectId: project.id,
        sprintId: sprint.id,
        taskId: taskSession.taskId,
        taskSessionId: taskSession.id,
        runtime: 'cursor',
        role: spec.role,
        status: 'running',
        branchName: taskSession.branchName,
        workingDirectory: '/tmp/agent-im',
        approvalsRequired: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    await workflowService.deleteTask(taskSession.id);

    assert.equal(store.getTaskSession(taskSession.id), null);
    assert.deepEqual(new Set(instanceManager.stopped), new Set(['reviewer-inst', 'developer-inst']));
  });

  it('auto-generates issue id when omitted', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const task = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      title: 'Auto key',
    });
    assert.equal(task.workflowState, 'todo');
    assert.match(task.issueId, /^PROJECT-\d+$/);
    assert.equal(instanceManager.started.length, 0);
  });

  it('escalates to codex-senior from todo when reviewRejectionCount > 2 even if lane is agent-dev', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const created = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-ESC',
      title: 'Escalate me',
    });
    const s = store.getTaskSession(created.id)!;
    store.upsertTaskSession({ ...s, reviewRejectionCount: 3 });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-ESC',
      title: '',
      taskSessionId: created.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 'fix again',
    });
    assert.equal(assigned.kanbanAgent, 'codex-senior');
    assert.equal(assigned.runtime, 'codex');
    assert.ok(instanceManager.started.some((x) => x.startsWith('developer:')));
  });

  it('keeps agent-dev when reviewRejectionCount is 2 (escalation only after > 2)', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const created = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-NO-ESC',
      title: 'Two rejects',
    });
    const s = store.getTaskSession(created.id)!;
    store.upsertTaskSession({ ...s, reviewRejectionCount: 2 });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-NO-ESC',
      title: '',
      taskSessionId: created.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 'round 3 dev',
    });
    assert.equal(assigned.kanbanAgent, 'agent-dev');
    assert.equal(assigned.runtime, 'claude');
    assert.ok(instanceManager.started.some((x) => x.startsWith('developer:')));
  });

  it('re-assigns in_progress with taskSessionId: escalates to codex-senior when reviewRejectionCount > 2', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      issueId: 'ISSUE-A4-RE',
      workflowState: 'in_progress',
      kanbanAgent: 'agent-dev',
      reviewRejectionCount: 3,
    });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-A4-RE',
      taskSessionId: taskSession.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 're-assign after 3 rejects',
    });
    assert.equal(assigned.kanbanAgent, 'codex-senior');
    assert.equal(assigned.runtime, 'codex');
    assert.ok(instanceManager.started.some((x) => x.startsWith('developer:')));
  });

  it('assign with taskSessionId is idempotent when task stays pending_start (dependency queue or retry)', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-DEP-PEND',
      title: 'dep',
    });
    const main = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-MAIN-PEND',
      title: 'main',
      dependsOnIssueIds: ['ISSUE-DEP-PEND'],
    });
    const first = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-MAIN-PEND',
      title: '',
      taskSessionId: main.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 'queue until dep done',
    });
    assert.equal(first.workflowState, 'pending_start');
    const second = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-MAIN-PEND',
      title: '',
      taskSessionId: main.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 'queue until dep done',
    });
    assert.equal(second.workflowState, 'pending_start');
    assert.equal(second.id, main.id);
  });

  it('assigns from todo with kanban lane and creates branch', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const created = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-PICK',
      title: 'Pick me',
    });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-PICK',
      title: '',
      taskSessionId: created.id,
      kanbanAgent: 'agent-dev',
      handoffComment: 'Do X then hand to review',
    });
    assert.equal(assigned.workflowState, 'in_progress');
    assert.equal(assigned.kanbanAgent, 'agent-dev');
    assert.deepEqual(gitService.calls, ['createTaskWorktree']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    const hist = store.getTaskSession(created.id)!;
    assert.ok(
      hist.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Handoff (read before running):'),
      ),
    );
  });

  it('queue skips blocked head: later task with satisfied deps starts in same sprint', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const blocker = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-BLOCK',
      title: 'Blocker',
    });
    const dependent = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-DEP',
      title: 'Depends on blocker',
      dependsOnIssueIds: [blocker.issueId],
    });
    await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: dependent.issueId,
      taskSessionId: dependent.id,
      kanbanAgent: 'agent-dev',
    });
    assert.equal(store.getTaskSession(dependent.id)!.workflowState, 'pending_start');

    const independent = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-IND',
      title: 'No deps',
    });
    const after = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: independent.issueId,
      taskSessionId: independent.id,
      kanbanAgent: 'agent-dev',
    });
    assert.equal(after.workflowState, 'in_progress');
    assert.equal(store.getTaskSession(dependent.id)!.workflowState, 'pending_start');
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    assert.ok(gitService.calls.includes('createTaskWorktree'));
  });

  it('assign from todo stays pending_start when dependency task is not yet pending_release or closed', async () => {
    const { workflowService, project, store, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-BLOCK',
      title: 'Blocker',
    });
    const dependent = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-DEP',
      title: 'Depends on blocker',
      dependsOnIssueIds: ['ISSUE-BLOCK'],
    });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: dependent.issueId,
      taskSessionId: dependent.id,
      kanbanAgent: 'agent-dev',
    });
    assert.equal(assigned.workflowState, 'pending_start');
    assert.deepEqual(gitService.calls, []);
  });

  it('assign from todo starts in_progress when dependency task is already pending_release', async () => {
    const { workflowService, project, store, gitService, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const blocker = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-REL',
      title: 'In merge lane',
    });
    store.upsertTaskSession({
      ...store.getTaskSession(blocker.id)!,
      workflowState: 'pending_release',
    });
    const dependent = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-AFTER',
      title: 'After blocker',
      dependsOnIssueIds: [blocker.issueId],
    });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: dependent.issueId,
      taskSessionId: dependent.id,
      kanbanAgent: 'agent-dev',
    });
    assert.equal(assigned.workflowState, 'in_progress');
    assert.deepEqual(gitService.calls, ['createTaskWorktree']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
  });

  it('assign from todo starts in_progress when dependency tasks are already closed', async () => {
    const { workflowService, project, store, gitService, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const blocker = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-DONE',
      title: 'Done',
    });
    store.upsertTaskSession({
      ...store.getTaskSession(blocker.id)!,
      workflowState: 'closed',
    });
    const dependent = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-RUN',
      title: 'Ready',
      dependsOnIssueIds: [blocker.issueId],
    });
    const assigned = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: dependent.issueId,
      taskSessionId: dependent.id,
      kanbanAgent: 'agent-dev',
    });
    assert.equal(assigned.workflowState, 'in_progress');
    assert.deepEqual(gitService.calls, ['createTaskWorktree']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
  });

  it('createTask rejects missing or self dependency', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    await assert.rejects(
      async () =>
        workflowService.createTask({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-X',
          title: 'x',
          dependsOnIssueIds: ['MISSING'],
        }),
      /no task with issue MISSING/,
    );
    await assert.rejects(
      async () =>
        workflowService.createTask({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-SELF',
          title: 'bad',
          dependsOnIssueIds: ['ISSUE-SELF'],
        }),
      /cannot depend on itself/,
    );
  });

  it('createTask rejects dependency cycle in existing graph', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const a = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISS-CA',
      title: 'A',
    });
    const b = await workflowService.createTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISS-CB',
      title: 'B',
      dependsOnIssueIds: [a.issueId],
    });
    store.upsertTaskSession({
      ...store.getTaskSession(a.id)!,
      dependsOnIssueIds: [b.issueId],
    });
    await assert.rejects(
      async () =>
        workflowService.createTask({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISS-CC',
          title: 'C',
          dependsOnIssueIds: [a.issueId],
        }),
      /cycle/,
    );
  });

  it('rejects review and re-queues developer with escalation count', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      kanbanAgent: 'claude-review',
      pullRequestUrl: 'https://example.test/pr/42',
    });
    const updated = await workflowService.rejectReview(taskSession.id, 'needs types');
    assert.equal(updated.workflowState, 'in_progress');
    assert.equal(updated.reviewRejectionCount, 1);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    assert.match(updated.handoffComment ?? '', /needs types/);
    assert.match(updated.handoffComment ?? '', /PR URL: https:\/\/example\.test\/pr\/42/);
  });

  it('merges open PR from review and moves to regression_testing', async () => {
    const { workflowService, project, store, instanceManager, gitService, scmClient } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pr/42',
    });
    const next = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(next.workflowState, 'regression_testing');
    assert.equal(next.regressionMasterSha, 'sha-default');
    assert.deepEqual(scmClient.calls, ['getPullRequestMergeStatus', 'mergePullRequest']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('tester:')));
    assert.ok(gitService.calls.includes('fetchOrigin'));
    assert.ok(gitService.calls.some((c) => c.startsWith('resolveRefSha:')));
    assert.ok(!gitService.calls.some((c) => c.startsWith('removeTaskWorktree:')));
  });

  it('removes linked task worktree after successful merge (before fetch)', async () => {
    const { workflowService, project, store, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pr/42',
      worktreePath: '/tmp/wt-issue-101',
    });
    await workflowService.startRegressionTesting(taskSession.id);
    const idxRemove = gitService.calls.findIndex((c) => c === 'removeTaskWorktree:/tmp/wt-issue-101');
    const idxFetch = gitService.calls.indexOf('fetchOrigin');
    assert.ok(idxRemove >= 0);
    assert.ok(idxRemove < idxFetch);
  });

  it('resets the workflow-owned sprint checkout before regression when local changes are present', async () => {
    const { workflowService, project, store, gitService } = createHarness();
    gitService.workingTreeStatusResult = [
      {
        path: 'src/app/globals.css',
        indexStatus: ' ',
        worktreeStatus: 'M',
        raw: ' M src/app/globals.css',
      },
    ];
    const sprint = createSprint(store, project.id, {
      branchName: 'feature/demo',
    });
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pr/42',
    });

    const updated = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(updated.workflowState, 'regression_testing');
    assert.ok(gitService.calls.includes('resetHardOrigin:feature/demo'));
    assert.ok(gitService.calls.includes('cleanFd'));

    const stored = store.getTaskSession(taskSession.id)!;
    assert.ok(
      stored.conversationHistory.some(
        (e) =>
          e.source === 'workflow' &&
          e.content.includes('Regression startup reset sprint branch "feature/demo"') &&
          e.content.includes('src/app/globals.css'),
      ),
    );
  });

  it('merge API 405 not mergeable returns task to development with synced review comment', async () => {
    const { workflowService, project, store, instanceManager, gitService, scmClient } = createHarness();
    scmClient.mergePullRequestError = new Error(
      'GitHub merge PR failed: 405 {"message":"Pull Request is not mergeable","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}',
    );
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pr/42',
      kanbanAgent: 'claude-review',
    });
    const updated = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(updated.workflowState, 'in_progress');
    assert.deepEqual(scmClient.calls, ['getPullRequestMergeStatus', 'mergePullRequest', 'postPullRequestDiscussionComment']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    assert.ok(!gitService.calls.includes('fetchOrigin'));
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(
      t.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Host PR check failed after review approval attempt.'),
      ),
    );
    assert.ok(
      t.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Merge blocked (not mergeable).'),
      ),
    );
  });

  it('does not call merge when host reports PR not merge-ready and returns task to development', async () => {
    const { workflowService, project, store, scmClient, instanceManager } = createHarness();
    scmClient.mergeStatusResult = { canMerge: false, reason: 'mergeable_state=dirty (conflicts)' };
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
    });
    const updated = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(updated.workflowState, 'in_progress');
    assert.deepEqual(scmClient.calls, [
      'findOpenPullRequest:dev/issue-101->feature/sprint-alpha',
      'createPullRequest',
      'getPullRequestMergeStatus',
      'postPullRequestDiscussionComment',
    ]);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(
      t.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Host PR check failed after review approval attempt.'),
      ),
    );
  });

  it('keeps review lane when host PR mergeability is still computing', async () => {
    const { workflowService, project, store, scmClient, instanceManager } = createHarness();
    scmClient.mergeStatusResult = {
      canMerge: false,
      reason: 'PR mergeability is still computing on GitHub; retry APPROVE_MERGE in a moment',
    };
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 10,
      pullRequestUrl: 'https://example.test/pr/10',
      branchName: 'dev/todolist-9',
    });

    const updated = await workflowService.startRegressionTesting(taskSession.id);

    assert.equal(updated.workflowState, 'review');
    assert.deepEqual(scmClient.calls, ['getPullRequestMergeStatus']);
    assert.equal(instanceManager.started.length, 0);
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(
      t.conversationHistory.some(
        (e) =>
          e.source === 'workflow' &&
          e.content.includes('Host PR status: not merge-ready yet (PR #10)') &&
          e.content.includes('retry APPROVE_MERGE in a moment'),
      ),
    );
  });

  it('treats already-merged review PR as a direct regression handoff instead of retrying mergeability', async () => {
    const { workflowService, project, store, scmClient, instanceManager, gitService } = createHarness();
    scmClient.mergeStatusResult = {
      canMerge: false,
      terminalState: 'merged',
      reason: 'PR is already merged on GitHub',
    };
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 10,
      pullRequestUrl: 'https://example.test/pr/10',
      branchName: 'dev/todolist-9',
    });

    const updated = await workflowService.startRegressionTesting(taskSession.id);

    assert.equal(updated.workflowState, 'regression_testing');
    assert.deepEqual(scmClient.calls, ['getPullRequestMergeStatus']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('tester:')));
    assert.ok(gitService.calls.includes('fetchOrigin'));
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(
      t.conversationHistory.some(
        (e) =>
          e.source === 'workflow' &&
          e.content.includes('Host PR #10 is already merged on the host; continuing directly to regression startup.'),
      ),
    );
    assert.ok(
      !t.conversationHistory.some(
        (e) =>
          e.source === 'workflow' &&
          e.content.includes('retry APPROVE_MERGE in a moment'),
      ),
    );
  });

  it('finds or creates review PR before mergeability check when review task is missing PR fields', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    scmClient.findOpenPullRequestResult = { url: 'https://example.test/pr/42', number: 42 };
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: undefined,
      pullRequestUrl: undefined,
      branchName: 'dev/todolist-8',
    });

    await workflowService.startRegressionTesting(taskSession.id);

    assert.deepEqual(scmClient.calls, ['findOpenPullRequest:dev/todolist-8->feature/sprint-alpha', 'getPullRequestMergeStatus', 'mergePullRequest']);
    const updated = store.getTaskSession(taskSession.id)!;
    assert.equal(updated.pullRequestNumber, 42);
    assert.equal(updated.pullRequestUrl, 'https://example.test/pr/42');
  });

  it('rethrows merge failure when not a not-mergeable error', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    scmClient.mergePullRequestError = new Error('GitHub merge PR failed: 403 forbidden');
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
    });
    await assert.rejects(() => workflowService.startRegressionTesting(taskSession.id), /403/);
    assert.equal(store.getTaskSession(taskSession.id)!.workflowState, 'review');
    assert.deepEqual(scmClient.calls, [
      'findOpenPullRequest:dev/issue-101->feature/sprint-alpha',
      'createPullRequest',
      'getPullRequestMergeStatus',
      'mergePullRequest',
    ]);
  });

  it('detects merge-target advance during regression and refreshes tester', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    gitService.resolveRefShaResults = ['sha-old', 'sha-new'];
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 42,
    });
    const reg = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(reg.regressionMasterSha, 'sha-old');
    const refreshed = await workflowService.refreshRegressionIfMasterAdvanced(reg.id);
    assert.equal(refreshed.regressionMasterSha, 'sha-new');
    assert.ok(refreshed.handoffComment?.includes('sha-old'));
    assert.ok(instanceManager.started.filter((s) => s.startsWith('tester:')).length >= 2);
  });

  it('aggregates kanban status', () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    createTaskSession(store, project.id, sprint.id, {
      workflowState: 'todo',
      id: 'ts-todo',
      issueId: 'ISSUE-A',
      taskId: 'ISSUE-A',
    });
    createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
      id: 'ts-ip',
      issueId: 'ISSUE-B',
      taskId: 'ISSUE-B',
    });
    const snap = workflowService.getKanbanStatus();
    assert.equal(snap.tasksByState.todo, 1);
    assert.equal(snap.tasksByState.in_progress, 1);
    assert.ok(snap.projects.length >= 1);
    const row = snap.tasksByProject.find((r) => r.projectId === project.id);
    assert.ok(row);
    assert.equal(row!.tasksByState.todo, 1);
    assert.equal(row!.tasksByState.in_progress, 1);
  });

  it('syncReviewCommentToPrAndTask posts to SCM and appends workflow comment', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 7,
    });
    await workflowService.syncReviewCommentToPrAndTask(taskSession.id, 'Nit: rename variable');
    assert.ok(scmClient.calls.includes('postPullRequestDiscussionComment'));
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(
      t.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Review (synced to PR #7)'),
      ),
    );
  });

  it('advances feature test → PR → merge/regression → close via workflow APIs', async () => {
    const { workflowService, project, store, scmClient } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });

    const testingResult = await workflowService.startTesting(taskSession.id);
    assert.equal(testingResult.workflowState, 'pre_testing');
    const featureTestingResult = await workflowService.startFeatureTesting(taskSession.id);
    assert.equal(featureTestingResult.workflowState, 'testing');

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat: review',
      prTitle: '[ISSUE] Review',
      prBody: 'Body',
    });
    assert.equal(reviewResult.taskSession.workflowState, 'review');

    const regressionResult = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(regressionResult.workflowState, 'regression_testing');

    const pendingResult = await workflowService.proceedToPendingRelease(taskSession.id);
    assert.equal(pendingResult.workflowState, 'pending_release');

    // Simulate human merging the release PR on the host.
    scmClient.mergeStatusResult = { canMerge: false, terminalState: 'merged', reason: 'PR is already merged' };
    const closeResult = await workflowService.closeTask(taskSession.id);
    assert.equal(closeResult.workflowState, 'closed');
    assert.equal(closeResult.releasePullRequestUrl, 'https://example.test/pr/42');
    assert.ok(scmClient.calls.filter((c) => c === 'createPullRequest').length >= 2);
    assert.ok(scmClient.calls.some((c) => c.startsWith('findOpenPullRequest:')));
    assert.ok(scmClient.calls.includes('postPullRequestDiscussionComment'));
  });

  it('private repo: mergeApprovedPullRequestAndStartRegression sets self-host-runner lane without starting AI instance', async () => {
    const { workflowService, store, instanceManager } = createHarness();
    const project = createProject(store, { isPrivate: true });
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      pullRequestNumber: 5,
    });

    const result = await workflowService.startRegressionTesting(taskSession.id);

    assert.equal(result.workflowState, 'regression_testing');
    assert.equal(result.kanbanAgent, 'self-host-runner');
    // No AI instance should have been started for the self-host-runner lane
    assert.equal(instanceManager.started.filter((s) => s.includes(taskSession.id)).length, 0);
  });

  it('processCiCallback advances private-repo task to pending_release on success', async () => {
    const { workflowService, store, scmClient } = createHarness();
    const project = createProject(store, { isPrivate: true });
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
      kanbanAgent: 'self-host-runner',
    });

    const result = await workflowService.processCiCallback(taskSession.id, 'success', undefined, 78.5);

    assert.equal(result.workflowState, 'pending_release');
    const coverage = store.getProjectCoverage(project.id);
    assert.equal(coverage.coverage, 78.5);
    // Coverage history should have an entry
    const history = store.getCoverageHistory(project.id);
    assert.ok(history.length > 0);
    assert.equal(history[0].coverage, 78.5);
  });

  it('processCiCallback returns private-repo task to development on failure', async () => {
    const { workflowService, store } = createHarness();
    const project = createProject(store, { isPrivate: true });
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
      kanbanAgent: 'self-host-runner',
    });

    const result = await workflowService.processCiCallback(taskSession.id, 'failure', 'Build failed: ld error');

    assert.equal(result.workflowState, 'in_progress');
    const t = store.getTaskSession(taskSession.id)!;
    assert.ok(t.handoffComment?.includes('Build failed: ld error'));
  });

  it('processCiCallback rejects when task is not in regression_testing with self-host-runner', async () => {
    const { workflowService, store } = createHarness();
    const project = createProject(store, { isPrivate: true });
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'regression_testing',
      // No kanbanAgent set — should reject
    });

    await assert.rejects(
      () => workflowService.processCiCallback(taskSession.id, 'success'),
      /self-host-runner/,
    );
  });

  it('processCiCallback rejects when task is already past regression (e.g. pending_release) — EX7', async () => {
    const { workflowService, store } = createHarness();
    const project = createProject(store, { isPrivate: true });
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'pending_release',
      kanbanAgent: 'self-host-runner',
    });

    await assert.rejects(
      () => workflowService.processCiCallback(taskSession.id, 'success'),
      /regression_testing/,
    );
  });

  it('blockTask rejects closed tasks', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'closed',
    });

    await assert.rejects(
      () => workflowService.blockTask(taskSession.id, 'try block'),
      /Cannot block a task in state "closed"/,
    );
  });
});
