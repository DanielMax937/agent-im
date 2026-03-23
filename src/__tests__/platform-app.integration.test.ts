import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CompensationService } from '../platform/compensation-service';
import { createPlatformApp } from '../platform/app';
import { JsonPlatformStore } from '../platform/json-platform-store';
import { WorkflowService } from '../platform/workflow-service';
import {
  asGitService,
  asInstanceManager,
  asScmClient,
  createApproval,
  createProject,
  createSprint,
  createTaskSession,
  FakeGitService,
  FakeInstanceManager,
  FakeScmClient,
  fetchJson,
  PLATFORM_DIR,
  startHttpApp,
} from './platform-test-helpers';

describe('Platform app integration', () => {
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
          runtime: 'codex',
        }),
      });

      assert.equal(response.status, 201);
      assert.equal((response.body as { workflowState: string }).workflowState, 'in_progress');
      assert.equal(instanceManager.started.length, 1);
    } finally {
      await server.close();
    }
  });

  it('submits review, starts testing, handles failure, and closes through the workflow APIs', async () => {
    const { app, store, project, workflowService, instanceManager, scmClient } = (() => {
      const harness = createHarness();
      const project = createProject(harness.store);
      return { ...harness, project };
    })();
    const sprint = createSprint(store, project.id);
    const taskSession = createTaskSession(store, project.id, sprint.id, {
      workflowState: 'in_progress',
    });
    store.upsertAgentInstance({
      id: 'developer-instance',
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
    const server = await startHttpApp(app);
    try {
      const submitReview = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskSession.id}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: 'feat(issue-101): submit review',
          prTitle: '[ISSUE-101] Submit review',
          prBody: 'Review body',
        }),
      });
      assert.equal((submitReview.body as { taskSession: { workflowState: string } }).taskSession.workflowState, 'review');
      assert.deepEqual(scmClient.calls, ['createPullRequest']);

      store.upsertTaskSession({
        ...store.getTaskSession(taskSession.id)!,
        workflowState: 'review',
      });
      const startTesting = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskSession.id}/start-testing`, {
        method: 'POST',
      });
      assert.equal((startTesting.body as { workflowState: string }).workflowState, 'testing');

      const failTesting = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskSession.id}/testing/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: 'pytest failed',
          log: 'assert 500 == 200',
        }),
      });
      assert.equal((failTesting.body as { workflowState: string }).workflowState, 'in_progress');

      store.upsertTaskSession({
        ...store.getTaskSession(taskSession.id)!,
        workflowState: 'testing',
      });
      const closeTask = await fetchJson(server.baseUrl, `/api/workflows/tasks/${taskSession.id}/close`, {
        method: 'POST',
      });
      assert.equal((closeTask.body as { workflowState: string }).workflowState, 'closed');
      assert.equal(instanceManager.stopped.length >= 1, true);
    } finally {
      await server.close();
    }
  });

  it('resolves approvals and Jira webhooks through dedicated APIs', async () => {
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

      const webhook = await fetchJson(server.baseUrl, '/api/webhooks/jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          sprintId: sprint.id,
          issueId: 'ISSUE-404',
          title: 'Hook triggered task',
          status: 'In Progress',
          runtime: 'cursor',
        }),
      });
      assert.equal((webhook.body as { ok: boolean }).ok, true);
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
});
