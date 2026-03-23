import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { CTI_HOME } from '../config';
import { JsonPlatformStore } from '../platform/json-platform-store';
import type { GitService } from '../platform/git-service';
import type { InstanceManager } from '../platform/instance-manager';
import type { PullRequestRef, ScmClient } from '../platform/scm-client';
import type { AgentInstanceRecord, PendingApprovalRecord, Project, Sprint, TaskSession } from '../platform/types';

export const PLATFORM_DIR = path.join(CTI_HOME, 'data', 'platform');

export class FakeGitService {
  public calls: string[] = [];
  public createSprintBranchResult = 'feature/sprint-alpha';
  public createTaskBranchResult = 'dev/issue-101';
  public commitResult = { committed: true };

  async createSprintBranch(): Promise<string> {
    this.calls.push('createSprintBranch');
    return this.createSprintBranchResult;
  }

  async createTaskBranch(): Promise<string> {
    this.calls.push('createTaskBranch');
    return this.createTaskBranchResult;
  }

  async commitAll(): Promise<{ committed: boolean }> {
    this.calls.push('commitAll');
    return this.commitResult;
  }

  async pushBranch(): Promise<void> {
    this.calls.push('pushBranch');
  }
}

export class FakeScmClient implements ScmClient {
  public calls: string[] = [];
  public pullRequest: PullRequestRef = {
    url: 'https://example.test/pr/42',
    number: 42,
  };

  async createPullRequest(): Promise<PullRequestRef> {
    this.calls.push('createPullRequest');
    return this.pullRequest;
  }
}

export class FakeInstanceManager {
  public runningInstanceIds = new Set<string>();
  public started: string[] = [];
  public restarted: string[] = [];
  public stopped: string[] = [];
  public reconciled = 0;
  public approvalResponses: Array<{ approvalId: string; input: unknown }> = [];
  public resolveApprovalResult = true;

  constructor(private readonly store?: JsonPlatformStore) {}

  listRunningInstanceIds(): string[] {
    return Array.from(this.runningInstanceIds);
  }

  async reconcile(): Promise<void> {
    this.reconciled += 1;
  }

  async upsertAndStart(instance: AgentInstanceRecord): Promise<AgentInstanceRecord> {
    this.started.push(`${instance.role}:${instance.taskSessionId}`);
    this.runningInstanceIds.add(instance.id);
    const persisted = this.store?.upsertAgentInstance({
      ...instance,
      status: 'running',
    }) ?? {
      ...instance,
      status: 'running',
    };
    return persisted;
  }

  async startInstance(instanceId: string): Promise<void> {
    this.restarted.push(instanceId);
    this.runningInstanceIds.add(instanceId);
  }

  async stopInstance(instanceId: string): Promise<void> {
    this.stopped.push(instanceId);
    this.runningInstanceIds.delete(instanceId);
  }

  resolveApproval(approvalId: string, input: unknown): boolean {
    this.approvalResponses.push({ approvalId, input });
    return this.resolveApprovalResult;
  }
}

export function createProject(store: JsonPlatformStore, overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return store.upsertProject({
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'agent-im',
    repository: overrides.repository ?? {
      remoteUrl: 'git@example.test:agent-im.git',
      localPath: '/tmp/agent-im',
      baseBranch: 'master',
      sprintBranchPrefix: 'feature/',
      taskBranchPrefix: 'dev/',
      scmProvider: 'github',
      scmProject: 'demo/agent-im',
      scmTokenEnvVar: 'GITHUB_TOKEN',
    },
    agents: overrides.agents ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  });
}

export function createSprint(store: JsonPlatformStore, projectId: string, overrides: Partial<Sprint> = {}): Sprint {
  const now = new Date().toISOString();
  return store.upsertSprint({
    id: overrides.id ?? 'sprint-1',
    projectId,
    name: overrides.name ?? 'Sprint Alpha',
    branchName: overrides.branchName ?? 'feature/sprint-alpha',
    baseBranch: overrides.baseBranch ?? 'master',
    status: overrides.status ?? 'active',
    taskIds: overrides.taskIds ?? [],
    startedAt: overrides.startedAt ?? now,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  });
}

export function createTaskSession(
  store: JsonPlatformStore,
  projectId: string,
  sprintId: string,
  overrides: Partial<TaskSession> = {},
): TaskSession {
  const now = new Date().toISOString();
  return store.upsertTaskSession({
    id: overrides.id ?? 'task-session-1',
    projectId,
    sprintId,
    taskId: overrides.taskId ?? 'ISSUE-101',
    issueId: overrides.issueId ?? 'ISSUE-101',
    title: overrides.title ?? 'Implement workflow',
    workflowState: overrides.workflowState ?? 'in_progress',
    runtime: overrides.runtime ?? 'codex',
    role: overrides.role ?? 'developer',
    sessionId: overrides.sessionId ?? 'session-1',
    providerSessionId: overrides.providerSessionId,
    workingDirectory: overrides.workingDirectory ?? '/tmp/agent-im',
    branchName: overrides.branchName ?? 'dev/issue-101',
    reviewBranchName: overrides.reviewBranchName,
    pullRequestUrl: overrides.pullRequestUrl,
    messageQueueKey: overrides.messageQueueKey ?? 'task:ISSUE-101:inbox',
    approvalQueueKey: overrides.approvalQueueKey ?? 'task:ISSUE-101:approvals',
    lastError: overrides.lastError,
    systemPrompt: overrides.systemPrompt,
    conversationHistory: overrides.conversationHistory ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  });
}

export function createApproval(
  store: JsonPlatformStore,
  overrides: Partial<PendingApprovalRecord> = {},
): PendingApprovalRecord {
  return store.savePendingApproval({
    id: overrides.id ?? 'approval-1',
    instanceId: overrides.instanceId ?? 'instance-1',
    taskSessionId: overrides.taskSessionId ?? 'task-session-1',
    taskId: overrides.taskId ?? 'ISSUE-101',
    toolName: overrides.toolName ?? 'bash',
    toolInput: overrides.toolInput ?? 'npm test',
    queueKey: overrides.queueKey ?? 'task:ISSUE-101:approvals',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    resolvedAt: overrides.resolvedAt,
    resolutionMessage: overrides.resolutionMessage,
  });
}

export interface ListenableApp {
  listen(port: number, callback?: () => void): Server;
}

export async function startHttpApp(app: ListenableApp): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = await new Promise<Server>((resolve) => {
    const httpServer = app.listen(0, () => resolve(httpServer));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function fetchJson(baseUrl: string, pathname: string, init?: RequestInit): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json();
  return {
    status: response.status,
    body,
  };
}

export async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail('waitFor timed out');
}

export function asGitService(fake: FakeGitService): GitService {
  return fake as unknown as GitService;
}

export function asScmClient(fake: FakeScmClient): ScmClient {
  return fake;
}

export function asInstanceManager(fake: FakeInstanceManager): InstanceManager {
  return fake as unknown as InstanceManager;
}
