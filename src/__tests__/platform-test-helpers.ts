import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import fs from 'node:fs';

import { JsonPlatformStore, platformDataDir } from '../platform/json-platform-store';
import type { GitService } from '../platform/git-service';
import type { InstanceManager } from '../platform/instance-manager';
import type {
  FindOpenPullRequestInput,
  PullRequestMergeStatus,
  PullRequestRef,
  ScmClient,
} from '../platform/scm-client';
import type {
  AgentInstanceRecord,
  KanbanAgentKind,
  PendingApprovalRecord,
  Project,
  ProjectAgentProfile,
  Sprint,
  TaskSession,
} from '../platform/types';

export const PLATFORM_DIR = platformDataDir();

(function assertSafeTestPlatformDir() {
  const raw = process.env.CTI_KANBAN_PLATFORM_DIR?.trim();
  if (raw === 'cti-home' || raw === 'legacy') {
    throw new Error(
      'Unit tests must not use CTI_KANBAN_PLATFORM_DIR=cti-home or legacy (that targets ~/.claude-to-im/kanban/data/platform). Use CTI_KANBAN_PLATFORM_DIR=$(mktemp -d) and CTI_KANBAN_PLATFORM_DB_FILE=test.db as in npm test.',
    );
  }
})();

/** Clears the isolated platform directory (npm test uses a temp CTI_KANBAN_PLATFORM_DIR + test.db). */
export function resetTestPlatformDir(): void {
  fs.rmSync(PLATFORM_DIR, { recursive: true, force: true });
}

/** Isolated store for tests (avoids SQLite file locks vs `rmSync` on the default `platform.db`). */
export function createTestJsonPlatformStore(): JsonPlatformStore {
  return new JsonPlatformStore({ dbPath: ':memory:' });
}

export class FakeGitService {
  public calls: string[] = [];
  public createSprintBranchResult = 'feature/sprint-alpha';
  public createTaskBranchResult = 'dev/issue-101';
  public commitResult = { committed: true };
  public workingTreeStatusResult: Array<{
    path: string;
    indexStatus: string;
    worktreeStatus: string;
    raw: string;
  }> = [];

  async createSprintBranch(): Promise<string> {
    this.calls.push('createSprintBranch');
    return this.createSprintBranchResult;
  }

  async createTaskBranch(): Promise<string> {
    this.calls.push('createTaskBranch');
    return this.createTaskBranchResult;
  }

  async createTaskWorktree(): Promise<string> {
    this.calls.push('createTaskWorktree');
    return this.createTaskBranchResult;
  }

  async fetchOrigin(): Promise<void> {
    this.calls.push('fetchOrigin');
  }

  /** Incrementing index into `resolveRefShaResults` (simulate master SHA changes between calls). */
  public resolveRefShaCounter = 0;
  public resolveRefShaResults: string[] = ['sha-default'];

  async resolveRefSha(_repoPath: string, ref: string): Promise<string> {
    this.calls.push(`resolveRefSha:${ref}`);
    const sha = this.resolveRefShaResults[this.resolveRefShaCounter] ?? 'sha-default';
    this.resolveRefShaCounter += 1;
    return sha;
  }

  async getWorkingTreeStatus(_repoPath?: string): Promise<
    Array<{ path: string; indexStatus: string; worktreeStatus: string; raw: string }>
  > {
    this.calls.push('getWorkingTreeStatus');
    return this.workingTreeStatusResult;
  }

  async commitAll(): Promise<{ committed: boolean }> {
    this.calls.push('commitAll');
    return this.commitResult;
  }

  async pushBranch(): Promise<void> {
    this.calls.push('pushBranch');
  }

  async checkoutOriginTrackingBranch(repoPath: string, branch: string): Promise<{ discardedEntries: Array<{ path: string; indexStatus: string; worktreeStatus: string; raw: string }> }> {
    const dirtyEntries = await this.getWorkingTreeStatus(repoPath);
    this.calls.push(`checkoutOriginTrackingBranch:${branch}`);
    if (dirtyEntries.length > 0) {
      this.calls.push(`resetHardOrigin:${branch}`);
      this.calls.push('cleanFd');
    }
    return { discardedEntries: dirtyEntries };
  }

  async removeTaskWorktree(_repoPath: string, worktreePath: string): Promise<void> {
    this.calls.push(`removeTaskWorktree:${worktreePath}`);
  }

  async createCoverageWorktree(_repoPath: string, worktreePath: string, _branch: string): Promise<void> {
    this.calls.push(`createCoverageWorktree:${worktreePath}`);
  }
}

export class FakeScmClient implements ScmClient {
  public calls: string[] = [];
  public pullRequest: PullRequestRef = {
    url: 'https://example.test/pr/42',
    number: 42,
  };
  public createPullRequestError: Error | null = null;

  /** When set, `mergePullRequest` throws (e.g. simulate GitHub 405 not mergeable). */
  public mergePullRequestError: Error | null = null;

  /** When null, `findOpenPullRequest` returns null (no existing release PR). */
  public findOpenPullRequestResult: PullRequestRef | null = null;
  public findOpenPullRequestResults: Array<PullRequestRef | null> | null = null;

  public mergeStatusResult: PullRequestMergeStatus = { canMerge: true };

  async getPullRequestMergeStatus(): Promise<PullRequestMergeStatus> {
    this.calls.push('getPullRequestMergeStatus');
    return this.mergeStatusResult;
  }

  async createPullRequest(): Promise<PullRequestRef> {
    this.calls.push('createPullRequest');
    if (this.createPullRequestError) throw this.createPullRequestError;
    return this.pullRequest;
  }

  async mergePullRequest(): Promise<void> {
    this.calls.push('mergePullRequest');
    if (this.mergePullRequestError) throw this.mergePullRequestError;
  }

  async postPullRequestDiscussionComment(): Promise<void> {
    this.calls.push('postPullRequestDiscussionComment');
  }

  async findOpenPullRequest(input: FindOpenPullRequestInput): Promise<PullRequestRef | null> {
    this.calls.push(`findOpenPullRequest:${input.sourceBranch}->${input.targetBranch}`);
    if (this.findOpenPullRequestResults && this.findOpenPullRequestResults.length > 0) {
      return this.findOpenPullRequestResults.shift() ?? null;
    }
    return this.findOpenPullRequestResult;
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

  async deleteInstance(instanceId: string): Promise<void> {
    await this.stopInstance(instanceId);
    this.store?.removeAgentInstance(instanceId);
  }

  resolveApproval(approvalId: string, input: unknown): boolean {
    this.approvalResponses.push({ approvalId, input });
    return this.resolveApprovalResult;
  }
}

/**
 * Kanban lane → runner id; must match `CTI_RUNNERS` in `package.json` `npm test`.
 * - 开发: Cursor (`test-kanban-dev`) · 前置测试: Copilot (`test-copilot-test`)
 * - 高级开发: Codex · 评审: Claude · 功能测试: Copilot
 */
export const TEST_KANBAN_LANE_RUNNER_IDS: Partial<Record<KanbanAgentKind, string>> = {
  'agent-dev': 'test-kanban-dev',
  'pre-tester': 'test-copilot-test',
  'codex-senior': 'test-codex-senior',
  'claude-review': 'test-claude-review',
  'copilot-test': 'test-copilot-test',
};

/** Primary Cursor profile for dev lanes; kept for tests that pin a single Kanban runner id. */
export const TEST_DEFAULT_RUNNER_ID = 'test-kanban-dev';

/** Legacy `Project.agents` defaults: developer / reviewer / tester all use Cursor runtime. */
const DEFAULT_TEST_PROJECT_AGENTS: ProjectAgentProfile[] = [
  { id: 'test-profile-developer', name: 'Developer', runtime: 'cursor', role: 'developer' },
  { id: 'test-profile-reviewer', name: 'Reviewer', runtime: 'cursor', role: 'reviewer' },
  { id: 'test-profile-tester', name: 'Tester', runtime: 'cursor', role: 'tester' },
];

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
    // Disable coverage command in tests to avoid running real npm test.
    coverageCommand: overrides.coverageCommand ?? '',
    deployment:
      overrides.deployment !== undefined
        ? overrides.deployment
        : {
            enabled: false,
          },
    agents: overrides.agents ?? DEFAULT_TEST_PROJECT_AGENTS,
    kanbanRoleRunners:
      overrides.kanbanRoleRunners !== undefined ? overrides.kanbanRoleRunners : { ...TEST_KANBAN_LANE_RUNNER_IDS },
    ...(overrides.isPrivate !== undefined ? { isPrivate: overrides.isPrivate } : {}),
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
    runtime: overrides.runtime ?? 'cursor',
    role: overrides.role ?? 'developer',
    kanbanAgent: overrides.kanbanAgent,
    sessionId: overrides.sessionId ?? 'session-1',
    providerSessionId: overrides.providerSessionId,
    workingDirectory: overrides.workingDirectory ?? '/tmp/agent-im',
    worktreePath: overrides.worktreePath,
    branchName: overrides.branchName ?? 'dev/issue-101',
    reviewBranchName: overrides.reviewBranchName,
    pullRequestUrl: overrides.pullRequestUrl,
    pullRequestNumber: overrides.pullRequestNumber,
    regressionMasterSha: overrides.regressionMasterSha,
    releasePullRequestUrl: overrides.releasePullRequestUrl,
    releasePullRequestNumber: overrides.releasePullRequestNumber,
    reviewRejectionCount: overrides.reviewRejectionCount,
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
