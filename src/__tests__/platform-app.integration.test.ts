import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompensationService } from '../platform/compensation-service';
import { createPlatformApp } from '../platform/app';
import { WorkflowService } from '../platform/workflow-service';
import type { TaskSession } from '../platform/types';
import {
  asGitService,
  asInstanceManager,
  asScmClient,
  createApproval,
  createProject,
  createSprint,
  createTaskSession,
  createTestJsonPlatformStore,
  FakeGitService,
  FakeInstanceManager,
  FakeScmClient,
  fetchJson,
  resetTestPlatformDir,
  startHttpApp,
} from './platform-test-helpers';

describe('Platform app integration', () => {
  beforeEach(() => {
    resetTestPlatformDir();
  });

  function createHarness() {
    const store = createTestJsonPlatformStore();
    const gitService = new FakeGitService();
    const scmClient = new FakeScmClient();
    const instanceManager = new FakeInstanceManager(store);
    const workflowService = new WorkflowService({
      store,
      gitService: asGitService(gitService),
      scmClient: asScmClient(scmClient),
      instanceManager: asInstanceManager(instanceManager),
      compensationService: new CompensationService(store, asInstanceManager(instanceManager)),
    });
    const app = createPlatformApp({
      store,
      workflowService,
      instanceManager: asInstanceManager(instanceManager),
    });

    return { store, gitService, scmClient, instanceManager, workflowService, app };
  }

  it('serves health and query endpoints for projects, sprints, tasks, instances, and approvals', async () => {
    const { store, app } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id);
    store.upsertAgentInstance({
      id: 'instance-1',
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
    createApproval(store, {
      taskSessionId: taskSession.id,
      taskId: taskSession.taskId,
      instanceId: 'instance-1',
    });

    const server = await startHttpApp(app);
    try {
      const health = await fetchJson(server.baseUrl, '/health');
      assert.equal(health.status, 200);

      const projects = await fetchJson(server.baseUrl, '/api/projects');
      assert.equal((projects.body as Array<unknown>).length, 1);

      const projectById = await fetchJson(server.baseUrl, `/api/projects/${project.id}`);
      assert.equal((projectById.body as { id: string }).id, project.id);

      const sprints = await fetchJson(server.baseUrl, `/api/sprints?projectId=${project.id}`);
      assert.equal((sprints.body as Array<unknown>).length, 1);

      const sprintById = await fetchJson(server.baseUrl, `/api/sprints/${sprint.id}`);
      assert.equal((sprintById.body as { id: string }).id, sprint.id);

      const tasks = await fetchJson(server.baseUrl, '/api/tasks');
      assert.equal((tasks.body as Array<unknown>).length, 1);

      const taskById = await fetchJson(server.baseUrl, `/api/tasks/${taskSession.id}`);
      assert.equal((taskById.body as { id: string }).id, taskSession.id);

      const instances = await fetchJson(server.baseUrl, '/api/instances');
      assert.equal((instances.body as Array<unknown>).length, 1);

      const instanceById = await fetchJson(server.baseUrl, '/api/instances/instance-1');
      assert.equal((instanceById.body as { id: string }).id, 'instance-1');

      const approvals = await fetchJson(server.baseUrl, `/api/approvals?taskSessionId=${taskSession.id}`);
      assert.equal((approvals.body as Array<unknown>).length, 1);

      const approvalById = await fetchJson(server.baseUrl, '/api/approvals/approval-1');
      assert.equal((approvalById.body as { id: string }).id, 'approval-1');
    } finally {
      await server.close();
    }
  });

  it('rejects duplicate active sprint name on POST /api/sprints', async () => {
    const { app, store } = createHarness();
    const project = createProject(store);
    const server = await startHttpApp(app);
    try {
      const body = {
        projectId: project.id,
        name: 'Unique Sprint Name',
        branchName: 'main',
        baseBranch: 'main',
      };
      const first = await fetchJson(server.baseUrl, '/api/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(first.status, 200);

      const second = await fetchJson(server.baseUrl, '/api/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(second.status, 400);
      assert.match((second.body as { error?: string }).error ?? '', /Sprint already exists/);
    } finally {
      await server.close();
    }
  });

  it('creates a project through the API', async () => {
    const { app } = createHarness();
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'project-2',
          name: 'agent-im-platform',
          repository: {
            remoteUrl: 'git@example.test:agent-im.git',
            localPath: '/tmp/agent-im',
            baseBranch: 'master',
            sprintBranchPrefix: 'feature/',
            taskBranchPrefix: 'dev/',
            scmProvider: 'github',
            scmProject: 'demo/agent-im',
          },
          agents: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });

      assert.equal(response.status, 201);
      assert.equal((response.body as { id: string }).id, 'project-2');
    } finally {
      await server.close();
    }
  });

  it('deletes a project when no sprints or tasks reference it', async () => {
    const { app, store } = createHarness();
    const project = createProject(store, { id: 'delete-me' });
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE',
      });
      assert.equal(response.status, 200);
      assert.equal(store.getProject(project.id), null);
    } finally {
      await server.close();
    }
  });

  it('GET/PUT kanban-roles lists runners and persists mapping', async () => {
    const { app, store } = createHarness();
    const project = createProject(store);
    const server = await startHttpApp(app);
    try {
      const getRes = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}/kanban-roles`);
      assert.equal(getRes.status, 200);
      const runners = (getRes.body as { runners: { id: string }[] }).runners;
      assert.ok(Array.isArray(runners) && runners.length > 0);
      const pickRunnerId = runners[0]!.id;
      const defaults = (getRes.body as { defaultLaneSkills?: Record<string, string[]> }).defaultLaneSkills;
      assert.ok(defaults && Array.isArray(defaults['agent-dev']) && defaults['agent-dev'].length > 0);

      const putRes = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}/kanban-roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kanbanRoleRunners: {
            'agent-dev': pickRunnerId,
            'claude-review': pickRunnerId,
            'copilot-test': '',
            'codex-senior': '',
          },
        }),
      });
      assert.equal(putRes.status, 200);
      const p = store.getProject(project.id);
      assert.equal(p?.kanbanRoleRunners?.['agent-dev'], pickRunnerId);
      assert.equal(p?.kanbanRoleRunners?.['claude-review'], pickRunnerId);

      const putSkills = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}/kanban-roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kanbanLaneSkills: {
            'agent-dev': ['cursor/fake-skill-for-test'],
            'codex-senior': [],
            'claude-review': [],
            'copilot-test': [],
          },
        }),
      });
      assert.equal(putSkills.status, 200);
      const p2 = store.getProject(project.id);
      assert.deepEqual(p2?.kanbanLaneSkills?.['agent-dev'], ['cursor/fake-skill-for-test']);
    } finally {
      await server.close();
    }
  });

  it('GET /api/projects/:id/next-issue-id returns preview', async () => {
    const { app, store } = createHarness();
    const project = createProject(store);
    const server = await startHttpApp(app);
    try {
      const r = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}/next-issue-id`);
      assert.equal(r.status, 200);
      assert.equal((r.body as { issueId: string }).issueId, 'PROJECT-1');
    } finally {
      await server.close();
    }
  });

  it('rejects project delete when sprints exist', async () => {
    const { app, store } = createHarness();
    const project = createProject(store);
    createSprint(store, project.id);
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, `/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE',
      });
      assert.equal(response.status, 400);
      const err = (response.body as { error?: string }).error ?? '';
      assert.ok(err.includes('sprint') || err.includes('task'));
    } finally {
      await server.close();
    }
  });

  it('starts a sprint through the workflow API', async () => {
    const { app, store, gitService } = createHarness();
    const project = createProject(store);
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, '/api/workflows/sprints/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          sprintName: 'Sprint Alpha',
        }),
      });

      assert.equal(response.status, 201);
      assert.equal((response.body as { branchName: string }).branchName, 'feature/sprint-alpha');
      assert.deepEqual(gitService.calls, ['createSprintBranch']);
    } finally {
      await server.close();
    }
  });

  it('exposes kanban aggregate status and creates todo tasks', async () => {
    const { app, store } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const server = await startHttpApp(app);
    try {
      const status = await fetchJson(server.baseUrl, '/api/kanban/status');
      assert.equal(status.status, 200);
      assert.ok((status.body as { tasksByState: { todo: number } }).tasksByState);

      const created = await fetchJson(server.baseUrl, '/api/workflows/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-KANBAN-API',
          title: 'API create',
        }),
      });
      assert.equal(created.status, 201);
      assert.equal((created.body as { workflowState: string }).workflowState, 'todo');
    } finally {
      await server.close();
    }
  });

  it('assigns a task through the workflow API', async () => {
    const { app, store, instanceManager } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const server = await startHttpApp(app);
    try {
      const response = await fetchJson(server.baseUrl, '/api/workflows/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-303',
          title: 'Ship API tests',
          runtime: 'cursor',
        }),
      });

      assert.equal(response.status, 201);
      assert.equal((response.body as { workflowState: string }).workflowState, 'in_progress');
      assert.equal(instanceManager.started.length, 1);
    } finally {
      await server.close();
    }
  });

  it('feature test → PR → regression → close, and feature-test failure path', async () => {
    const { app, store, project, instanceManager, scmClient } = (() => {
      const harness = createHarness();
      const project = createProject(harness.store);
      return { ...harness, project };
    })();
    const sprint = createSprint(store, project.id);
    const now = new Date().toISOString();

    const taskFail = createTaskSession(store, project.id, sprint.id, {
      id: 'task-session-fail',
      workflowState: 'in_progress',
      taskId: 'ISSUE-FAIL',
      issueId: 'ISSUE-FAIL',
      messageQueueKey: 'task:ISSUE-FAIL:inbox',
    });
    store.upsertAgentInstance({
      id: 'developer-instance-fail',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskFail.taskId,
      taskSessionId: taskFail.id,
      runtime: 'cursor',
      role: 'developer',
      status: 'running',
      branchName: taskFail.branchName,
      workingDirectory: '/tmp/agent-im',
      approvalsRequired: true,
      createdAt: now,
      updatedAt: now,
    });

    const taskHappy = createTaskSession(store, project.id, sprint.id, {
      id: 'task-session-happy',
      workflowState: 'in_progress',
      taskId: 'ISSUE-OK',
      issueId: 'ISSUE-OK',
      messageQueueKey: 'task:ISSUE-OK:inbox',
    });
    store.upsertAgentInstance({
      id: 'developer-instance-happy',
      projectId: project.id,
      sprintId: sprint.id,
      taskId: taskHappy.taskId,
      taskSessionId: taskHappy.id,
      runtime: 'cursor',
      role: 'developer',
      status: 'running',
      branchName: taskHappy.branchName,
      workingDirectory: '/tmp/agent-im',
      approvalsRequired: true,
      createdAt: now,
      updatedAt: now,
    });

    const server = await startHttpApp(app);
    try {
      const startFeatureTest = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskFail.id}/start-testing`, {
        method: 'POST',
      });
      assert.equal((startFeatureTest.body as { workflowState: string }).workflowState, 'pre_testing');

      const enterFeatureTest = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskFail.id}/start-feature-testing`, {
        method: 'POST',
      });
      assert.equal((enterFeatureTest.body as { workflowState: string }).workflowState, 'testing');

      const failTesting = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskFail.id}/testing/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: 'pytest failed',
          log: 'assert 500 == 200',
        }),
      });
      assert.equal((failTesting.body as { workflowState: string }).workflowState, 'in_progress');

      await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/start-testing`, {
        method: 'POST',
      });
      await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/start-feature-testing`, {
        method: 'POST',
      });
      const submitReview = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: 'feat(issue-ok): submit review',
          prTitle: '[ISSUE-OK] Submit review',
          prBody: 'Review body',
        }),
      });
      assert.equal((submitReview.body as { taskSession: { workflowState: string } }).taskSession.workflowState, 'review');
      assert.ok(scmClient.calls.includes('createPullRequest'));

      const startRegression = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/start-regression`, {
        method: 'POST',
      });
      assert.equal((startRegression.body as { workflowState: string }).workflowState, 'regression_testing');
      assert.ok(scmClient.calls.includes('getPullRequestMergeStatus'));
      assert.ok(scmClient.calls.includes('mergePullRequest'));

      const proceedRelease = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/proceed-to-release`, {
        method: 'POST',
      });
      assert.equal((proceedRelease.body as { workflowState: string }).workflowState, 'pending_release');

      // Simulate human merging the release PR on the host.
      scmClient.mergeStatusResult = { canMerge: false, terminalState: 'merged', reason: 'PR is already merged' };
      const closeTask = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskHappy.id}/close`, {
        method: 'POST',
      });
      const closed = closeTask.body as { workflowState: string; releasePullRequestUrl?: string };
      assert.equal(closed.workflowState, 'closed');
      assert.equal(closed.releasePullRequestUrl, 'https://example.test/pr/42');
      assert.ok(scmClient.calls.some((c) => c.startsWith('findOpenPullRequest:')));
      assert.equal(instanceManager.stopped.length >= 1, true);
    } finally {
      await server.close();
    }
  });

  it('resolves approvals through the dedicated API', async () => {
    const { app, store, instanceManager } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });
    createApproval(store, {
      id: 'approval-9',
      taskSessionId: taskSession.id,
      taskId: taskSession.taskId,
    });

    const server = await startHttpApp(app);
    try {
      const approval = await fetchJson(server.baseUrl, '/api/approvals/approval-9', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          behavior: 'allow',
          message: 'ship it',
        }),
      });
      assert.equal((approval.body as { ok: boolean }).ok, true);
      assert.deepEqual(instanceManager.approvalResponses, [
        {
          approvalId: 'approval-9',
          input: {
            behavior: 'allow',
            message: 'ship it',
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('starts, stops, and reconciles instances through dedicated APIs', async () => {
    const { app, store, instanceManager } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    createTaskSession(store, project.id, sprint.id);
    const server = await startHttpApp(app);
    try {
      const reconcile = await fetchJson(server.baseUrl, '/api/instances/reconcile', {
        method: 'POST',
      });
      assert.equal((reconcile.body as { ok: boolean }).ok, true);
      assert.equal(instanceManager.reconciled, 1);

      const start = await fetchJson(server.baseUrl, '/api/instances/instance-42/start', {
        method: 'POST',
      });
      assert.equal((start.body as { ok: boolean }).ok, true);
      assert.deepEqual(instanceManager.restarted, ['instance-42']);

      const stop = await fetchJson(server.baseUrl, '/api/instances/instance-42/stop', {
        method: 'POST',
      });
      assert.equal((stop.body as { ok: boolean }).ok, true);
      assert.deepEqual(instanceManager.stopped, ['instance-42']);
    } finally {
      await server.close();
    }
  });

  it('GET /api/tasks includes agentGenerating from the active lane instance', async () => {
    const { store, app } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
      role: 'developer',
    });
    store.upsertAgentInstance({
      id: 'dev-inst',
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
      generating: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const server = await startHttpApp(app);
    try {
      const tasks = await fetchJson(server.baseUrl, '/api/tasks');
      assert.equal(tasks.status, 200);
      const list = tasks.body as TaskSession[];
      const row = list.find((t) => t.id === taskSession.id);
      assert.ok(row);
      assert.equal(row!.agentGenerating, true);
    } finally {
      await server.close();
    }
  });

  it('POST /api/workflows/tasks/:taskSessionId/comments appends a manual history comment', async () => {
    const { store, app } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });
    const server = await startHttpApp(app);
    try {
      const res = await fetchJson(
        server.baseUrl,
        `/api/workflows/tasks/${encodeURIComponent(taskSession.id)}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Manual audit passed', role: 'reviewer' }),
        },
      );
      assert.equal(res.status, 201);
      const body = res.body as { historyComments?: { content: string; kind: string }[] };
      assert.ok(body.historyComments?.length === 1);
      assert.equal(body.historyComments![0].kind, 'manual');
      assert.equal(body.historyComments![0].content, 'Manual audit passed');
      const persisted = store.getTaskSession(taskSession.id);
      assert.ok(persisted?.historyComments?.length === 1);
    } finally {
      await server.close();
    }
  });

  it('POST /api/workflows/tasks/:taskSessionId/queue-message enqueues a human_followup', async () => {
    const { store, app, instanceManager } = createHarness();
    const project = createProject(store);
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
      role: 'developer',
    });
    store.upsertAgentInstance({
      id: 'dev-inst',
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
    const server = await startHttpApp(app);
    try {
      const res = await fetchJson(
        server.baseUrl,
        `/api/workflows/tasks/${encodeURIComponent(taskSession.id)}/queue-message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Please fix lint' }),
        },
      );
      assert.equal(res.status, 200);
      const q = store.peekTaskQueue(taskSession.messageQueueKey);
      assert.ok(q.some((m) => m.type === 'human_followup' && m.content.includes('lint')));
      assert.ok(instanceManager.restarted.includes('dev-inst'));
    } finally {
      await server.close();
    }
  });
});
