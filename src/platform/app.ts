import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';

import * as bridgeManager from '../lib/bridge/bridge-manager';
import {
  BRIDGE_LOG_APP_BASENAME,
  BRIDGE_LOG_DAEMON_BASENAME,
  BRIDGE_LOG_LINES_DEFAULT,
  BRIDGE_LOG_LINES_MAX,
  readBridgeLogTail,
} from '../lib/bridge/bridge-log-file';
import {
  getBridgeStatusForApi,
  startBridgeDaemonChild,
  stopBridgeDaemonChild,
} from '../lib/bridge-app-child';
import { readBridgeDaemonDiskStatus } from '../lib/bridge-daemon-status';
import {
  getCtiHomeForBridgeSlug,
  getSlaveEnvPath,
  listBridgeSlugs,
  loadConfig,
  normalizeRunners,
} from '../config';
import { readMonitorMessages, readRunnerStatusForMonitor } from '../lib/monitor-messages';
import { getLogger } from '../logger';
import type {
  PendingApprovalRecord,
  Project,
  Sprint,
  TaskSession,
  AgentInstanceRecord,
  AgentRole,
  KanbanAgentKind,
  KanbanRoleMember,
  KanbanAgentTurnRecord,
} from './types';
import { defaultSkillLinesForLane } from './kanban-agents';
import { listSkillCatalogEntries } from './skill-catalog';
import { roleForActiveWorkflowState } from './workflow-service';

const KANBAN_ROLE_KINDS: KanbanAgentKind[] = [
  'agent-dev',
  'codex-senior',
  'claude-review',
  'copilot-test',
];

function parseKanbanRoleRunnersInput(raw: unknown): Partial<Record<KanbanAgentKind, string>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Partial<Record<KanbanAgentKind, string>> = {};
  for (const kind of KANBAN_ROLE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) return null;
    out[kind] = v.trim();
  }
  return out;
}

function parseKanbanRoleMembersInput(raw: unknown): Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> = {};
  for (const kind of KANBAN_ROLE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return null;
    const members: KanbanRoleMember[] = [];
    for (const row of v) {
      if (typeof row !== 'object' || row === null) return null;
      const r = row as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      const runnerProfileId = typeof r.runnerProfileId === 'string' ? r.runnerProfileId.trim() : '';
      if (!id || !runnerProfileId) return null;
      members.push({ id, name: name || id, runnerProfileId });
    }
    out[kind] = members;
  }
  return out;
}

function enrichTaskSessionForApi(store: PlatformStoreApi, task: TaskSession): TaskSession {
  const role = roleForActiveWorkflowState(task.workflowState);
  if (!role) {
    return { ...task, agentGenerating: false };
  }
  const inst = store.listAgentInstances(task.id).find((i) => i.role === role);
  return {
    ...task,
    agentGenerating: inst?.generating === true,
  };
}

export interface PlatformStoreApi {
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  upsertProject(project: Project): Project;
  removeProject(projectId: string): { ok: true } | { ok: false; error: string };
  previewNextIssueId(projectId: string): string;
  getTaskSessionByProjectIssueId(projectId: string, issueId: string): TaskSession | null;
  listSprints(projectId?: string): Sprint[];
  getSprint(sprintId: string): Sprint | null;
  listTaskSessions(projectId?: string): TaskSession[];
  getTaskSession(taskSessionId: string): TaskSession | null;
  listAgentInstances(taskSessionId?: string): AgentInstanceRecord[];
  getAgentInstance(instanceId: string): AgentInstanceRecord | null;
  listPendingApprovals(taskSessionId?: string): PendingApprovalRecord[];
  getPendingApproval(approvalId: string): PendingApprovalRecord | null;
  listKanbanAgentTurns(filters: {
    projectId?: string;
    taskId?: string;
    taskSessionId?: string;
    limit?: number;
    offset?: number;
  }): { rows: KanbanAgentTurnRecord[]; total: number };
  getKanbanAgentTurn(id: string): KanbanAgentTurnRecord | null;
  updateKanbanAgentTurnStreamError(id: string, streamError: string | null): void;
}

export interface WorkflowServiceApi {
  startSprint(input: unknown): Promise<Sprint>;
  createTask(input: unknown): Promise<TaskSession>;
  assignTask(input: unknown): Promise<TaskSession>;
  submitTaskForReview(input: {
    taskSessionId: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
  }): Promise<unknown>;
  startTesting(taskSessionId: string): Promise<TaskSession>;
  startRegressionTesting(taskSessionId: string): Promise<TaskSession>;
  refreshRegressionIfMasterAdvanced(taskSessionId: string): Promise<TaskSession>;
  rejectReview(taskSessionId: string, comment: string): Promise<TaskSession>;
  handleTestFailure(input: { taskSessionId: string; summary: string; log: string }): Promise<TaskSession>;
  closeTask(taskSessionId: string): Promise<TaskSession>;
  syncReviewCommentToPrAndTask(taskSessionId: string, body: string): Promise<void>;
  deleteTask(taskSessionId: string): Promise<void>;
  resolveApproval(approvalId: string, input: unknown): boolean;
  getKanbanStatus(): unknown;
  ensureAgentInstance(
    taskSessionId: string,
    role: AgentRole,
    runtimeProfileId?: string,
  ): Promise<AgentInstanceRecord>;
  enqueueManualQueueMessage(taskSessionId: string, content: string): Promise<void>;
}

export interface InstanceManagerApi {
  listRunningInstanceIds(): string[];
  reconcile(): Promise<void>;
  startInstance(instanceId: string): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
  deleteInstance(instanceId: string): Promise<void>;
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
    'main.ts': 'standalone bridge daemon entrypoint',
    'app': 'Next.js app router entrypoint for the web platform',
    platform: {
      'app.ts': 'native HTTP platform router shared by Next.js and tests',
      'json-platform-store.ts': 'SQLite persistence for projects, sprints, tasks, instances, approvals, and queues',
      'instance-manager.ts': 'singleton runtime registry and task runners (local queue)',
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
    const searchParams = url.searchParams;
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const requestLogger = logger.child({
      method: request.method,
      pathname,
    });

    try {
      if (request.method === 'GET' && pathname === '/health') {
        return jsonResponse({
          ok: true,
          bridge: getBridgeStatusForApi(),
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      if (request.method === 'GET' && pathname === '/api/bridge/logs') {
        const raw = parseInt(searchParams.get('lines') || '', 10);
        const lines =
          Number.isFinite(raw) && raw > 0
            ? Math.min(raw, BRIDGE_LOG_LINES_MAX)
            : BRIDGE_LOG_LINES_DEFAULT;
        const source = searchParams.get('source')?.trim() ?? 'daemon';
        const fileBasename =
          source === 'app' ? BRIDGE_LOG_APP_BASENAME : BRIDGE_LOG_DAEMON_BASENAME;
        const { text, logPath, missing } = await readBridgeLogTail(lines, fileBasename);
        return jsonResponse({
          ok: true,
          text,
          logPath,
          missing,
          lines,
          source: source === 'app' ? 'app' : 'daemon',
        });
      }

      if (request.method === 'GET' && pathname === '/api/structure') {
        return jsonResponse(DIRECTORY_STRUCTURE_PLAN);
      }

      if (request.method === 'GET' && pathname === '/api/platform/runners') {
        const cfg = loadConfig();
        const runners = normalizeRunners(cfg).map((r) => ({
          id: r.id,
          label: r.label ?? r.id,
          runtime: r.runtime,
        }));
        return jsonResponse({ runners });
      }

      if (request.method === 'GET' && pathname === '/api/skills/catalog') {
        return jsonResponse({ skills: listSkillCatalogEntries() });
      }

      if (request.method === 'GET' && pathname === '/api/projects') {
        return jsonResponse(options.store.listProjects());
      }

      const projectNextIssueParams = matchPath('/api/projects/:projectId/next-issue-id', pathname);
      if (request.method === 'GET' && projectNextIssueParams) {
        try {
          const issueId = options.store.previewNextIssueId(projectNextIssueParams.projectId);
          return jsonResponse({ issueId });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 404);
        }
      }

      const kanbanRolesParams = matchPath('/api/projects/:projectId/kanban-roles', pathname);
      if (request.method === 'GET' && kanbanRolesParams) {
        const project = options.store.getProject(kanbanRolesParams.projectId);
        if (!project) return notFoundResponse('Project', kanbanRolesParams.projectId);
        const cfg = loadConfig();
        const runners = normalizeRunners(cfg).map((r) => ({
          id: r.id,
          label: r.label ?? r.id,
          runtime: r.runtime,
        }));
        return jsonResponse({
          projectId: project.id,
          kinds: KANBAN_ROLE_KINDS,
          roleLabels: {
            'agent-dev': '开发（agent-dev）',
            'codex-senior': '高级开发（codex-senior）',
            'claude-review': '评审（claude-review）',
            'copilot-test': '测试（copilot-test）',
          },
          runners,
          mapping: project.kanbanRoleRunners ?? {},
          members: project.kanbanRoleMembers ?? {},
          defaultLaneSkills: Object.fromEntries(
            KANBAN_ROLE_KINDS.map((k) => [k, defaultSkillLinesForLane(k, 0)]),
          ) as Record<KanbanAgentKind, string[]>,
          kanbanLaneSkills: project.kanbanLaneSkills ?? {},
        });
      }

      if (request.method === 'PUT' && kanbanRolesParams) {
        const project = options.store.getProject(kanbanRolesParams.projectId);
        if (!project) return notFoundResponse('Project', kanbanRolesParams.projectId);
        const body = await readRequestBody<{
          kanbanRoleRunners?: unknown;
          kanbanRoleMembers?: unknown;
          kanbanLaneSkills?: unknown;
        }>(request);
        if (
          body.kanbanRoleRunners === undefined &&
          body.kanbanRoleMembers === undefined &&
          body.kanbanLaneSkills === undefined
        ) {
          return jsonResponse(
            { error: 'kanbanRoleRunners, kanbanRoleMembers, and/or kanbanLaneSkills is required' },
            400,
          );
        }
        const cfg = loadConfig();
        const validIds = new Set(normalizeRunners(cfg).map((r) => r.id));
        const next: Project = { ...project };

        if (body.kanbanRoleMembers !== undefined) {
          const rawMembers = body.kanbanRoleMembers as Record<string, unknown>;
          const parsedMembers = parseKanbanRoleMembersInput(body.kanbanRoleMembers);
          if (parsedMembers === null) {
            return jsonResponse({ error: 'kanbanRoleMembers must be lane → { id, name, runnerProfileId }[]' }, 400);
          }
          const mergedMembers: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> = {
            ...(project.kanbanRoleMembers ?? {}),
          };
          for (const k of KANBAN_ROLE_KINDS) {
            if (Object.prototype.hasOwnProperty.call(rawMembers, k)) {
              const list = parsedMembers[k] ?? [];
              mergedMembers[k] = list;
              for (const m of list) {
                if (!validIds.has(m.runnerProfileId)) {
                  return jsonResponse({ error: `Unknown runner id: ${m.runnerProfileId}` }, 400);
                }
              }
            }
          }
          if (Object.keys(mergedMembers).length === 0) {
            delete next.kanbanRoleMembers;
          } else {
            next.kanbanRoleMembers = mergedMembers;
          }
        }

        if (body.kanbanRoleRunners !== undefined) {
          const parsed = parseKanbanRoleRunnersInput(body.kanbanRoleRunners);
          if (parsed === null) {
            return jsonResponse({ error: 'kanbanRoleRunners must be an object with string runner ids' }, 400);
          }
          for (const v of Object.values(parsed)) {
            if (!validIds.has(v)) {
              return jsonResponse({ error: `Unknown runner id: ${v}` }, 400);
            }
          }
          if (Object.keys(parsed).length === 0) {
            delete next.kanbanRoleRunners;
          } else {
            next.kanbanRoleRunners = parsed;
          }
        }

        if (body.kanbanLaneSkills !== undefined) {
          const rawLaneSkills = body.kanbanLaneSkills;
          if (typeof rawLaneSkills !== 'object' || rawLaneSkills === null || Array.isArray(rawLaneSkills)) {
            return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
          }
          const nextLaneSkills: Partial<Record<KanbanAgentKind, string[]>> = {
            ...(project.kanbanLaneSkills ?? {}),
          };
          for (const k of KANBAN_ROLE_KINDS) {
            if (!Object.prototype.hasOwnProperty.call(rawLaneSkills, k)) continue;
            const v = (rawLaneSkills as Record<string, unknown>)[k];
            if (!Array.isArray(v)) {
              return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
            }
            const ids: string[] = [];
            for (const x of v) {
              if (typeof x !== 'string' || !x.trim()) {
                return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
              }
              ids.push(x.trim());
            }
            if (ids.length > 0) nextLaneSkills[k] = ids;
            else delete nextLaneSkills[k];
          }
          if (Object.keys(nextLaneSkills).length === 0) {
            delete next.kanbanLaneSkills;
          } else {
            next.kanbanLaneSkills = nextLaneSkills;
          }
        }

        options.store.upsertProject(next);
        return jsonResponse({ ok: true, project: options.store.getProject(project.id) });
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
        const filterProjectId = searchParams.get('projectId')?.trim();
        const tasks = options.store.listTaskSessions(filterProjectId || undefined);
        return jsonResponse(tasks.map((t) => enrichTaskSessionForApi(options.store, t)));
      }

      const taskParams = matchPath('/api/tasks/:taskSessionId', pathname);
      if (request.method === 'GET' && taskParams) {
        const taskSession = options.store.getTaskSession(taskParams.taskSessionId);
        return taskSession
          ? jsonResponse(enrichTaskSessionForApi(options.store, taskSession))
          : notFoundResponse('Task session', taskParams.taskSessionId);
      }

      if (request.method === 'GET' && pathname === '/api/instances') {
        return jsonResponse(options.store.listAgentInstances());
      }

      if (request.method === 'POST' && pathname === '/api/instances') {
        const body = await readRequestBody<{
          taskSessionId?: string;
          role?: AgentRole;
          runtimeProfileId?: string;
        }>(request);
        if (!body.taskSessionId || !body.role) {
          return jsonResponse({ error: 'taskSessionId and role are required' }, 400);
        }
        const record = await options.workflowService.ensureAgentInstance(
          body.taskSessionId,
          body.role,
          body.runtimeProfileId,
        );
        return jsonResponse(record, 201);
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

      if (request.method === 'DELETE' && projectParams) {
        const result = options.store.removeProject(projectParams.projectId);
        if (!result.ok) {
          return jsonResponse({ error: result.error }, 400);
        }
        return jsonResponse({ ok: true, id: projectParams.projectId });
      }

      if (request.method === 'POST' && pathname === '/api/workflows/sprints/start') {
        return jsonResponse(
          await options.workflowService.startSprint(await readRequestBody<unknown>(request)),
          201,
        );
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/create') {
        return jsonResponse(
          await options.workflowService.createTask(await readRequestBody<unknown>(request)),
          201,
        );
      }

      if (request.method === 'GET' && pathname === '/api/kanban/monitor') {
        const projectId = searchParams.get('projectId')?.trim() || undefined;
        const taskId = searchParams.get('taskId')?.trim() || undefined;
        const taskSessionId = searchParams.get('taskSessionId')?.trim() || undefined;
        const limitRaw = parseInt(searchParams.get('limit') || '', 10);
        const offsetRaw = parseInt(searchParams.get('offset') || '', 10);
        const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
        const offset = Number.isFinite(offsetRaw) ? offsetRaw : undefined;
        return jsonResponse(
          options.store.listKanbanAgentTurns({ projectId, taskId, taskSessionId, limit, offset }),
        );
      }

      const kanbanMonitorTurnParams = matchPath('/api/kanban/monitor/:turnId', pathname);
      if (request.method === 'GET' && kanbanMonitorTurnParams) {
        const row = options.store.getKanbanAgentTurn(kanbanMonitorTurnParams.turnId);
        return row ? jsonResponse(row) : notFoundResponse('Kanban agent turn', kanbanMonitorTurnParams.turnId);
      }

      if (request.method === 'GET' && pathname === '/api/kanban/status') {
        return jsonResponse(options.workflowService.getKanbanStatus());
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/assign') {
        return jsonResponse(
          await options.workflowService.assignTask(await readRequestBody<unknown>(request)),
          201,
        );
      }

      const queueManualParams = matchPath('/api/workflows/tasks/:taskSessionId/queue-message', pathname);
      if (request.method === 'POST' && queueManualParams) {
        const body = await readRequestBody<{ content?: string }>(request);
        const content = typeof body.content === 'string' ? body.content : '';
        try {
          await options.workflowService.enqueueManualQueueMessage(queueManualParams.taskSessionId, content);
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const submitReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/submit-review', pathname);
      if (request.method === 'POST' && submitReviewParams) {
        const payload = await readRequestBody<{
          commitMessage: string;
          prTitle: string;
          prBody: string;
        }>(request);
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

      const regressionStartParams = matchPath('/api/workflows/tasks/:taskSessionId/start-regression', pathname);
      if (request.method === 'POST' && regressionStartParams) {
        return jsonResponse(
          await options.workflowService.startRegressionTesting(regressionStartParams.taskSessionId),
        );
      }

      const regressionRefreshParams = matchPath('/api/workflows/tasks/:taskSessionId/regression/refresh', pathname);
      if (request.method === 'POST' && regressionRefreshParams) {
        return jsonResponse(
          await options.workflowService.refreshRegressionIfMasterAdvanced(regressionRefreshParams.taskSessionId),
        );
      }

      const rejectReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/reject-review', pathname);
      if (request.method === 'POST' && rejectReviewParams) {
        const payload = await readRequestBody<{ comment: string }>(request);
        if (!payload.comment?.trim()) {
          return jsonResponse({ error: 'comment is required' }, 400);
        }
        return jsonResponse(
          await options.workflowService.rejectReview(rejectReviewParams.taskSessionId, payload.comment.trim()),
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

      const syncReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/sync-review-comment', pathname);
      if (request.method === 'POST' && syncReviewParams) {
        const payload = await readRequestBody<{ body?: string }>(request);
        const body = typeof payload.body === 'string' ? payload.body : '';
        try {
          await options.workflowService.syncReviewCommentToPrAndTask(syncReviewParams.taskSessionId, body);
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const closeTaskParams = matchPath('/api/workflows/tasks/:taskSessionId/close', pathname);
      if (request.method === 'POST' && closeTaskParams) {
        return jsonResponse(
          await options.workflowService.closeTask(closeTaskParams.taskSessionId),
        );
      }

      const deleteTaskParams = matchPath('/api/workflows/tasks/:taskSessionId', pathname);
      if (request.method === 'DELETE' && deleteTaskParams) {
        await options.workflowService.deleteTask(deleteTaskParams.taskSessionId);
        return jsonResponse({ ok: true });
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

      if (request.method === 'DELETE' && instanceParams) {
        await options.instanceManager.deleteInstance(instanceParams.instanceId);
        return jsonResponse({ ok: true, instanceId: instanceParams.instanceId });
      }

      if (request.method === 'GET' && pathname === '/api/bridge/status') {
        const slug = searchParams.get('slug')?.trim();
        const home = slug ? getCtiHomeForBridgeSlug(slug) : undefined;
        return jsonResponse(getBridgeStatusForApi(home));
      }

      const bridgeActionParams = matchPath('/api/bridge/:action', pathname);
      if (request.method === 'POST' && bridgeActionParams) {
        const bridgeBody = (await readRequestBody<{ slug?: string }>(request)) as {
          slug?: string;
        };
        const bridgeHome = bridgeBody.slug?.trim()
          ? getCtiHomeForBridgeSlug(bridgeBody.slug.trim())
          : undefined;

        if (bridgeActionParams.action === 'start') {
          // Preflight: if auto mode is enabled, config.slave.env must exist
          try {
            const cfg = loadConfig();
            if (cfg.imBot?.autoMode) {
              const slaveEnvPath = getSlaveEnvPath(bridgeHome);
              if (!fs.existsSync(slaveEnvPath)) {
                return jsonResponse(
                  {
                    error:
                      '已启用 Auto 模式，但未找到 config.slave.env。请先在管理页面配置 Slave Runner 并点击「保存 config.slave.env」。',
                  },
                  400,
                );
              }
            }
          } catch {
            /* config load failure will surface during daemon start */
          }
          await startBridgeDaemonChild(bridgeHome);
          return jsonResponse(getBridgeStatusForApi(bridgeHome));
        }
        if (bridgeActionParams.action === 'stop') {
          const stopped = await stopBridgeDaemonChild(bridgeHome);
          if (!stopped.ok) {
            // Not managed by app — try to kill via PID from status.json
            const disk = readBridgeDaemonDiskStatus(bridgeHome);
            if (disk.effectiveRunning && disk.pid) {
              try {
                process.kill(disk.pid, 'SIGTERM');
                // Wait briefly for process to exit
                for (let i = 0; i < 20; i++) {
                  await new Promise((r) => setTimeout(r, 500));
                  try { process.kill(disk.pid!, 0); } catch { break; }
                }
              } catch {
                /* already dead */
              }
            } else {
              return jsonResponse(
                { error: '桥接未在运行或无法找到 PID。' },
                409,
              );
            }
          }
          return jsonResponse(getBridgeStatusForApi(bridgeHome));
        }
        if (bridgeActionParams.action === 'auto-start') {
          bridgeManager.tryAutoStart();
          return jsonResponse(getBridgeStatusForApi());
        }
        return jsonResponse({ error: `Unknown bridge action: ${bridgeActionParams.action}` }, 404);
      }

      // ── Monitor API ──
      if (request.method === 'GET' && pathname === '/api/monitor/responses') {
        try {
          const slug = searchParams.get('bridge') ?? undefined;
          if (slug) {
            const home = getCtiHomeForBridgeSlug(slug);
            const data = readMonitorMessages(home);
            const status = readRunnerStatusForMonitor(home);
            // Tag entries with source bridge
            const tag = (e: { text: string; ts: number; bridgeSlug?: string }) => ({ ...e, homeBridge: slug });
            return jsonResponse({ masterOut: data.master.map(tag), slaveOut: data.slave.map(tag), runnerStatus: { [slug]: status } });
          }
          // No slug — merge from all bridges, tag with source
          const allSlugs = listBridgeSlugs();
          let masterOut: { text: string; ts: number; bridgeSlug?: string; homeBridge?: string }[] = [];
          let slaveOut: { text: string; ts: number; bridgeSlug?: string; homeBridge?: string }[] = [];
          const runnerStatus: Record<string, { masterBusy: boolean; slaveBusy: boolean; masterSince?: number; slaveSince?: number; updatedAt: number }> = {};
          for (const s of allSlugs) {
            try {
              const home = getCtiHomeForBridgeSlug(s);
              const data = readMonitorMessages(home);
              const tag = (e: { text: string; ts: number; bridgeSlug?: string }) => ({ ...e, homeBridge: s });
              masterOut = masterOut.concat(data.master.map(tag));
              slaveOut = slaveOut.concat(data.slave.map(tag));
              runnerStatus[s] = readRunnerStatusForMonitor(home);
            } catch { /* skip */ }
          }
          if (allSlugs.length === 0) {
            const data = readMonitorMessages();
            masterOut = data.master;
            slaveOut = data.slave;
            runnerStatus['default'] = readRunnerStatusForMonitor();
          }
          masterOut.sort((a, b) => a.ts - b.ts);
          slaveOut.sort((a, b) => a.ts - b.ts);
          return jsonResponse({ masterOut, slaveOut, runnerStatus });
        } catch (err) {
          return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
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
