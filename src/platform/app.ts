import express from 'express';

import * as bridgeManager from '../lib/bridge/bridge-manager.js';
import type {
  PendingApprovalRecord,
  Project,
  Sprint,
  TaskSession,
  AgentInstanceRecord,
} from './types.js';

export interface PlatformStoreApi {
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  upsertProject(project: Project): Project;
  listSprints(projectId?: string): Sprint[];
  getSprint(sprintId: string): Sprint | null;
  listTaskSessions(projectId?: string): TaskSession[];
  getTaskSession(taskSessionId: string): TaskSession | null;
  listAgentInstances(taskSessionId?: string): AgentInstanceRecord[];
  getAgentInstance(instanceId: string): AgentInstanceRecord | null;
  listPendingApprovals(taskSessionId?: string): PendingApprovalRecord[];
  getPendingApproval(approvalId: string): PendingApprovalRecord | null;
}

export interface WorkflowServiceApi {
  startSprint(input: unknown): Promise<Sprint>;
  assignTask(input: unknown): Promise<TaskSession>;
  submitTaskForReview(input: {
    taskSessionId: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
  }): Promise<unknown>;
  startTesting(taskSessionId: string): Promise<TaskSession>;
  handleTestFailure(input: { taskSessionId: string; summary: string; log: string }): Promise<TaskSession>;
  closeTask(taskSessionId: string): Promise<TaskSession>;
  resolveApproval(approvalId: string, input: unknown): boolean;
  handleJiraWebhook(payload: unknown): Promise<unknown>;
}

export interface InstanceManagerApi {
  listRunningInstanceIds(): string[];
  reconcile(): Promise<void>;
  startInstance(instanceId: string): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
}

export interface CreatePlatformAppOptions {
  store: PlatformStoreApi;
  workflowService: WorkflowServiceApi;
  instanceManager: InstanceManagerApi;
}

const DIRECTORY_STRUCTURE_PLAN = {
  src: {
    'main.ts': 'legacy daemon entrypoint for CLI bridge mode',
    'web.ts': 'Express web entrypoint for the multi-tenant platform',
    platform: {
      'app.ts': 'HTTP API routes',
      'json-platform-store.ts': 'JSON persistence for projects, sprints, tasks, instances, approvals, and queues',
      'jira-adapter.ts': 'Jira comment transport adapter',
      'instance-manager.ts': 'singleton runtime registry and task runners',
      'workflow-service.ts': 'state machine plus Git and PR automation',
      'compensation-service.ts': 'test failure feedback loop back to the developer agent',
      'prompts.ts': 'role-specific system prompts',
    },
  },
};

export function createPlatformApp(options: CreatePlatformAppOptions) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function sendNotFound(
    response: express.Response,
    resource: string,
    id: string,
  ): void {
    response.status(404).json({ error: `${resource} not found: ${id}` });
  }

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      bridge: bridgeManager.getStatus(),
      runningInstances: options.instanceManager.listRunningInstanceIds(),
    });
  });

  app.get('/api/structure', (_request, response) => {
    response.json(DIRECTORY_STRUCTURE_PLAN);
  });

  app.get('/api/projects', (_request, response) => {
    response.json(options.store.listProjects());
  });

  app.get('/api/projects/:projectId', (request, response) => {
    const project = options.store.getProject(request.params.projectId);
    if (!project) {
      sendNotFound(response, 'Project', request.params.projectId);
      return;
    }
    response.json(project);
  });

  app.get('/api/sprints', (request, response) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
    response.json(options.store.listSprints(projectId));
  });

  app.get('/api/sprints/:sprintId', (request, response) => {
    const sprint = options.store.getSprint(request.params.sprintId);
    if (!sprint) {
      sendNotFound(response, 'Sprint', request.params.sprintId);
      return;
    }
    response.json(sprint);
  });

  app.get('/api/tasks', (_request, response) => {
    response.json(options.store.listTaskSessions());
  });

  app.get('/api/tasks/:taskSessionId', (request, response) => {
    const taskSession = options.store.getTaskSession(request.params.taskSessionId);
    if (!taskSession) {
      sendNotFound(response, 'Task session', request.params.taskSessionId);
      return;
    }
    response.json(taskSession);
  });

  app.get('/api/instances', (_request, response) => {
    response.json(options.store.listAgentInstances());
  });

  app.get('/api/instances/:instanceId', (request, response) => {
    const instance = options.store.getAgentInstance(request.params.instanceId);
    if (!instance) {
      sendNotFound(response, 'Agent instance', request.params.instanceId);
      return;
    }
    response.json(instance);
  });

  app.get('/api/approvals', (request, response) => {
    const taskSessionId = typeof request.query.taskSessionId === 'string' ? request.query.taskSessionId : undefined;
    response.json(options.store.listPendingApprovals(taskSessionId));
  });

  app.get('/api/approvals/:approvalId', (request, response) => {
    const approval = options.store.getPendingApproval(request.params.approvalId);
    if (!approval) {
      sendNotFound(response, 'Approval', request.params.approvalId);
      return;
    }
    response.json(approval);
  });

  app.post('/api/projects', (request, response) => {
    const project = options.store.upsertProject(request.body);
    response.status(201).json(project);
  });

  app.post('/api/workflows/sprints/start', async (request, response) => {
    const sprint = await options.workflowService.startSprint(request.body);
    response.status(201).json(sprint);
  });

  app.post('/api/workflows/tasks/assign', async (request, response) => {
    const taskSession = await options.workflowService.assignTask(request.body);
    response.status(201).json(taskSession);
  });

  app.post('/api/workflows/tasks/:taskSessionId/submit-review', async (request, response) => {
    const result = await options.workflowService.submitTaskForReview({
      taskSessionId: request.params.taskSessionId,
      commitMessage: request.body.commitMessage,
      prTitle: request.body.prTitle,
      prBody: request.body.prBody,
    });
    response.json(result);
  });

  app.post('/api/workflows/tasks/:taskSessionId/start-testing', async (request, response) => {
    const taskSession = await options.workflowService.startTesting(request.params.taskSessionId);
    response.json(taskSession);
  });

  app.post('/api/workflows/tasks/:taskSessionId/testing/fail', async (request, response) => {
    const taskSession = await options.workflowService.handleTestFailure({
      taskSessionId: request.params.taskSessionId,
      summary: request.body.summary,
      log: request.body.log,
    });
    response.json(taskSession);
  });

  app.post('/api/workflows/tasks/:taskSessionId/close', async (request, response) => {
    const taskSession = await options.workflowService.closeTask(request.params.taskSessionId);
    response.json(taskSession);
  });

  app.post('/api/approvals/:approvalId', async (request, response) => {
    const resolved = options.workflowService.resolveApproval(request.params.approvalId, request.body);
    response.json({ ok: resolved });
  });

  app.post('/api/instances/reconcile', async (_request, response) => {
    await options.instanceManager.reconcile();
    response.json({
      ok: true,
      runningInstances: options.instanceManager.listRunningInstanceIds(),
    });
  });

  app.post('/api/instances/:instanceId/start', async (request, response) => {
    await options.instanceManager.startInstance(request.params.instanceId);
    response.json({
      ok: true,
      instanceId: request.params.instanceId,
      runningInstances: options.instanceManager.listRunningInstanceIds(),
    });
  });

  app.post('/api/instances/:instanceId/stop', async (request, response) => {
    await options.instanceManager.stopInstance(request.params.instanceId);
    response.json({
      ok: true,
      instanceId: request.params.instanceId,
      runningInstances: options.instanceManager.listRunningInstanceIds(),
    });
  });

  app.post('/api/webhooks/jira', async (request, response) => {
    const result = await options.workflowService.handleJiraWebhook(request.body);
    response.json({ ok: true, result });
  });

  app.get('/api/bridge/status', (_request, response) => {
    response.json(bridgeManager.getStatus());
  });

  app.post('/api/bridge/:action', async (request, response) => {
    const action = request.params.action;
    if (action === 'start') {
      await bridgeManager.start();
      response.json(bridgeManager.getStatus());
      return;
    }
    if (action === 'stop') {
      await bridgeManager.stop();
      response.json(bridgeManager.getStatus());
      return;
    }
    if (action === 'auto-start') {
      bridgeManager.tryAutoStart();
      response.json(bridgeManager.getStatus());
      return;
    }
    response.status(404).json({ error: `Unknown bridge action: ${action}` });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return app;
}
