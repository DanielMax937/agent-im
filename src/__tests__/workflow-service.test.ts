import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  FakeGitService,
  FakeInstanceManager,
  FakeScmClient,
  PLATFORM_DIR,
} from './platform-test-helpers';

describe('WorkflowService', () => {
  beforeEach(() => {
    fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
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

  it('assigns a task to a developer agent and creates the task branch', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);

    const taskSession = await workflowService.assignTask({
      projectId: project.id,
      sprintId: sprint.id,
      issueId: 'ISSUE-101',
      title: 'Implement workflow',
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
      commitMessage: 'feat(issue-101): implement workflow',
      prTitle: '[ISSUE-101] Implement workflow',
      prBody: 'Automated PR body',
    });

    assert.equal(reviewResult.taskSession.workflowState, 'review');
    assert.equal(reviewResult.pullRequest.url, 'https://example.test/pr/42');
    assert.deepEqual(gitService.calls, ['commitAll', 'pushBranch']);
    assert.deepEqual(scmClient.calls, ['createPullRequest']);
    assert.deepEqual(instanceManager.started, [`reviewer:${taskSession.id}`]);
  });

  it('maybeAutoAdvanceAfterAgentTurn submits for review when assistant ends with KANBAN_ACTION:SUBMIT_REVIEW', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
      conversationHistory: [],
    });
    store.appendConversationEntry(taskSession.id, {
      role: 'assistant',
      source: 'developer',
      content: 'Done.\nKANBAN_ACTION:SUBMIT_REVIEW',
    });

    await workflowService.maybeAutoAdvanceAfterAgentTurn(taskSession.id, 'developer', 'dev-instance');

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
        workflowState: 'in_progress',
        conversationHistory: [],
      });
      store.appendConversationEntry(taskSession.id, {
        role: 'assistant',
        source: 'developer',
        content: 'Done.\nKANBAN_ACTION:SUBMIT_REVIEW',
      });

      await workflowService.maybeAutoAdvanceAfterAgentTurn(taskSession.id, 'developer', 'dev-instance');

      assert.equal(store.getTaskSession(taskSession.id)!.workflowState, 'in_progress');
      assert.deepEqual(gitService.calls, []);
    } finally {
      if (prev === undefined) {
        delete process.env.CTI_KANBAN_WORKFLOW_AUTO;
      } else {
        process.env.CTI_KANBAN_WORKFLOW_AUTO = prev;
      }
    }
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

  it('resumeKanbanAfterRestart closes regression task when tester last reply contains CLOSE', async () => {
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
          content: 'Regression passed.\nKANBAN_ACTION:CLOSE',
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
        runtime: 'codex',
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
    assert.deepEqual(gitService.calls, ['createTaskBranch']);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
    const hist = store.getTaskSession(created.id)!;
    assert.ok(
      hist.conversationHistory.some(
        (e) => e.source === 'workflow' && e.content.includes('Handoff (read before running):'),
      ),
    );
  });

  it('rejects review and re-queues developer with escalation count', async () => {
    const { workflowService, project, store, instanceManager } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'review',
      kanbanAgent: 'claude-review',
    });
    const updated = await workflowService.rejectReview(taskSession.id, 'needs types');
    assert.equal(updated.workflowState, 'in_progress');
    assert.equal(updated.reviewRejectionCount, 1);
    assert.ok(instanceManager.started.some((s) => s.startsWith('developer:')));
  });

  it('moves testing to regression_testing', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
    });
    const next = await workflowService.startRegressionTesting(taskSession.id);
    assert.equal(next.workflowState, 'regression_testing');
    assert.equal(next.regressionMasterSha, 'sha-default');
    assert.ok(instanceManager.started.some((s) => s.startsWith('tester:')));
    assert.ok(gitService.calls.includes('fetchOrigin'));
    assert.ok(gitService.calls.some((c) => c.startsWith('resolveRefSha:')));
  });

  it('detects master advance during regression and refreshes tester', async () => {
    const { workflowService, project, store, instanceManager, gitService } = createHarness();
    gitService.resolveRefShaResults = ['sha-old', 'sha-new'];
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'testing',
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

  it('advances review, testing, and close via workflow APIs', async () => {
    const { workflowService, project, store } = createHarness();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });

    const reviewResult = await workflowService.submitTaskForReview({
      taskSessionId: taskSession.id,
      commitMessage: 'feat: review',
      prTitle: '[ISSUE] Review',
      prBody: 'Body',
    });
    assert.equal(reviewResult.taskSession.workflowState, 'review');

    const testingResult = await workflowService.startTesting(taskSession.id);
    assert.equal(testingResult.workflowState, 'testing');

    const closeResult = await workflowService.closeTask(taskSession.id);
    assert.equal(closeResult.workflowState, 'closed');
  });
});
