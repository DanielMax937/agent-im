import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import * as bridgeManager from '../lib/bridge/bridge-manager';
import { getLogger } from '../logger';
import type {
  PendingApprovalRecord,
  Project,
  Sprint,
  TaskSession,
  AgentInstanceRecord,
} from './types';

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

export interface PlatformApp {
  handle(request: Request): Promise<Response>;
  listen(port: number, callback?: () => void): Server;
}

const DIRECTORY_STRUCTURE_PLAN = {
  src: {
    'main.ts': 'legacy daemon entrypoint for CLI bridge mode',
    'app': 'Next.js app router entrypoint for the web platform',
    platform: {
      'app.ts': 'native HTTP platform router shared by Next.js and tests',
      'json-platform-store.ts': 'JSON persistence for projects, sprints, tasks, instances, approvals, and queues',
      'jira-adapter.ts': 'Jira comment transport adapter',
      'instance-manager.ts': 'singleton runtime registry and task runners',
      'workflow-service.ts': 'state machine plus Git and PR automation',
      'compensation-service.ts': 'test failure feedback loop back to the developer agent',
      'prompts.ts': 'role-specific system prompts',
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function notFoundResponse(resource: string, id: string): Response {
  return jsonResponse({ error: `${resource} not found: ${id}` }, 404);
}

async function readRequestBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathnameParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathnameParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathnamePart = pathnameParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathnamePart);
      continue;
    }
    if (patternPart !== pathnamePart) {
      return null;
    }
  }
  return params;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host || '127.0.0.1';
  const url = new URL(request.url || '/', `http://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
      continue;
    }
    headers.set(key, value);
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.concat(
          await new Promise<Buffer[]>((resolve, reject) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            request.on('end', () => resolve(chunks));
            request.on('error', reject);
          }),
        );

  return new Request(url, {
    method: request.method,
    headers,
    body,
  });
}

async function writeNodeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  const body = Buffer.from(await result.arrayBuffer());
  response.end(body);
}

export function createPlatformApp(options: CreatePlatformAppOptions): PlatformApp {
  const logger = getLogger().child({ scope: 'platform-app' });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const requestLogger = logger.child({
      method: request.method,
      pathname,
    });

    try {
      if (request.method === 'GET' && pathname === '/health') {
        return jsonResponse({
          ok: true,
          bridge: bridgeManager.getStatus(),
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      if (request.method === 'GET' && pathname === '/api/structure') {
        return jsonResponse(DIRECTORY_STRUCTURE_PLAN);
      }

      if (request.method === 'GET' && pathname === '/api/projects') {
        return jsonResponse(options.store.listProjects());
      }

      const projectParams = matchPath('/api/projects/:projectId', pathname);
      if (request.method === 'GET' && projectParams) {
        const project = options.store.getProject(projectParams.projectId);
        return project
          ? jsonResponse(project)
          : notFoundResponse('Project', projectParams.projectId);
      }

      if (request.method === 'GET' && pathname === '/api/sprints') {
        return jsonResponse(options.store.listSprints(searchParams.get('projectId') ?? undefined));
      }

      const sprintParams = matchPath('/api/sprints/:sprintId', pathname);
      if (request.method === 'GET' && sprintParams) {
        const sprint = options.store.getSprint(sprintParams.sprintId);
        return sprint
          ? jsonResponse(sprint)
          : notFoundResponse('Sprint', sprintParams.sprintId);
      }

      if (request.method === 'GET' && pathname === '/api/tasks') {
        return jsonResponse(options.store.listTaskSessions());
      }

      const taskParams = matchPath('/api/tasks/:taskSessionId', pathname);
      if (request.method === 'GET' && taskParams) {
        const taskSession = options.store.getTaskSession(taskParams.taskSessionId);
        return taskSession
          ? jsonResponse(taskSession)
          : notFoundResponse('Task session', taskParams.taskSessionId);
      }

      if (request.method === 'GET' && pathname === '/api/instances') {
        return jsonResponse(options.store.listAgentInstances());
      }

      const instanceParams = matchPath('/api/instances/:instanceId', pathname);
      if (request.method === 'GET' && instanceParams) {
        const instance = options.store.getAgentInstance(instanceParams.instanceId);
        return instance
          ? jsonResponse(instance)
          : notFoundResponse('Agent instance', instanceParams.instanceId);
      }

      if (request.method === 'GET' && pathname === '/api/approvals') {
        return jsonResponse(
          options.store.listPendingApprovals(searchParams.get('taskSessionId') ?? undefined),
        );
      }

      const approvalParams = matchPath('/api/approvals/:approvalId', pathname);
      if (request.method === 'GET' && approvalParams) {
        const approval = options.store.getPendingApproval(approvalParams.approvalId);
        return approval
          ? jsonResponse(approval)
          : notFoundResponse('Approval', approvalParams.approvalId);
      }

      if (request.method === 'POST' && pathname === '/api/projects') {
        return jsonResponse(options.store.upsertProject(await readRequestBody<Project>(request)), 201);
      }

      if (request.method === 'POST' && pathname === '/api/workflows/sprints/start') {
        return jsonResponse(
          await options.workflowService.startSprint(await readRequestBody<unknown>(request)),
          201,
        );
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/assign') {
        return jsonResponse(
          await options.workflowService.assignTask(await readRequestBody<unknown>(request)),
          201,
        );
      }

      const submitReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/submit-review', pathname);
      if (request.method === 'POST' && submitReviewParams) {
        const payload = await readRequestBody<{ commitMessage: string; prTitle: string; prBody: string }>(request);
        return jsonResponse(
          await options.workflowService.submitTaskForReview({
            taskSessionId: submitReviewParams.taskSessionId,
            commitMessage: payload.commitMessage,
            prTitle: payload.prTitle,
            prBody: payload.prBody,
          }),
        );
      }

      const testingStartParams = matchPath('/api/workflows/tasks/:taskSessionId/start-testing', pathname);
      if (request.method === 'POST' && testingStartParams) {
        return jsonResponse(
          await options.workflowService.startTesting(testingStartParams.taskSessionId),
        );
      }

      const testingFailParams = matchPath('/api/workflows/tasks/:taskSessionId/testing/fail', pathname);
      if (request.method === 'POST' && testingFailParams) {
        const payload = await readRequestBody<{ summary: string; log: string }>(request);
        return jsonResponse(
          await options.workflowService.handleTestFailure({
            taskSessionId: testingFailParams.taskSessionId,
            summary: payload.summary,
            log: payload.log,
          }),
        );
      }

      const closeTaskParams = matchPath('/api/workflows/tasks/:taskSessionId/close', pathname);
      if (request.method === 'POST' && closeTaskParams) {
        return jsonResponse(
          await options.workflowService.closeTask(closeTaskParams.taskSessionId),
        );
      }

      if (request.method === 'POST' && approvalParams) {
        return jsonResponse({
          ok: options.workflowService.resolveApproval(
            approvalParams.approvalId,
            await readRequestBody<unknown>(request),
          ),
        });
      }

      if (request.method === 'POST' && pathname === '/api/instances/reconcile') {
        await options.instanceManager.reconcile();
        return jsonResponse({
          ok: true,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      const instanceStartParams = matchPath('/api/instances/:instanceId/start', pathname);
      if (request.method === 'POST' && instanceStartParams) {
        await options.instanceManager.startInstance(instanceStartParams.instanceId);
        return jsonResponse({
          ok: true,
          instanceId: instanceStartParams.instanceId,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      const instanceStopParams = matchPath('/api/instances/:instanceId/stop', pathname);
      if (request.method === 'POST' && instanceStopParams) {
        await options.instanceManager.stopInstance(instanceStopParams.instanceId);
        return jsonResponse({
          ok: true,
          instanceId: instanceStopParams.instanceId,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      if (request.method === 'POST' && pathname === '/api/webhooks/jira') {
        return jsonResponse({
          ok: true,
          result: await options.workflowService.handleJiraWebhook(
            await readRequestBody<unknown>(request),
          ),
        });
      }

      if (request.method === 'GET' && pathname === '/api/bridge/status') {
        return jsonResponse(bridgeManager.getStatus());
      }

      const bridgeActionParams = matchPath('/api/bridge/:action', pathname);
      if (request.method === 'POST' && bridgeActionParams) {
        if (bridgeActionParams.action === 'start') {
          await bridgeManager.start();
          return jsonResponse(bridgeManager.getStatus());
        }
        if (bridgeActionParams.action === 'stop') {
          await bridgeManager.stop();
          return jsonResponse(bridgeManager.getStatus());
        }
        if (bridgeActionParams.action === 'auto-start') {
          bridgeManager.tryAutoStart();
          return jsonResponse(bridgeManager.getStatus());
        }
        return jsonResponse({ error: `Unknown bridge action: ${bridgeActionParams.action}` }, 404);
      }

      return jsonResponse({ error: `Route not found: ${request.method} ${pathname}` }, 404);
    } catch (error) {
      requestLogger.error({ error }, 'Platform request failed');
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    } finally {
      requestLogger.info('Platform request completed');
    }
  }

  let server: Server | null = null;

  return {
    handle,
    listen(port: number, callback?: () => void): Server {
      if (!server) {
        server = createServer(async (request, response) => {
          const webRequest = await toWebRequest(request);
          const result = await handle(webRequest);
          await writeNodeResponse(response, result);
        });
      }
      return server.listen(port, callback);
    },
  };
}
