import express from 'express';

import * as bridgeManager from '../lib/bridge/bridge-manager.js';
import { JsonPlatformStore } from './json-platform-store.js';
import { InstanceManager } from './instance-manager.js';
import { WorkflowService } from './workflow-service.js';

export interface CreatePlatformAppOptions {
  store: JsonPlatformStore;
  workflowService: WorkflowService;
  instanceManager: InstanceManager;
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

  app.get('/api/tasks', (_request, response) => {
    response.json(options.store.listTaskSessions());
  });

  app.get('/api/instances', (_request, response) => {
    response.json(options.store.listAgentInstances());
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

  app.post('/api/webhooks/jira', async (request, response) => {
    const result = await options.workflowService.handleJiraWebhook(request.body);
    response.json({ ok: true, result });
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
