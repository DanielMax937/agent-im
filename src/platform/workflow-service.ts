import crypto from 'node:crypto';

import { CompensationService } from './compensation-service.js';
import { createApprovalQueueKey, createTaskQueueKey, JsonPlatformStore } from './json-platform-store.js';
import { GitService } from './git-service.js';
import { InstanceManager } from './instance-manager.js';
import type { PullRequestRef, ScmClient } from './scm-client.js';
import type {
  AgentInstanceRecord,
  AgentRole,
  ApprovalResolutionInput,
  AssignTaskInput,
  JiraWebhookPayload,
  Sprint,
  StartSprintInput,
  SubmitTaskForReviewInput,
  TaskFailurePayload,
  TaskSession,
  TaskWorkflowState,
} from './types.js';

const ALLOWED_TRANSITIONS: Record<TaskWorkflowState, TaskWorkflowState[]> = {
  todo: ['in_progress'],
  in_progress: ['review', 'testing'],
  review: ['testing', 'in_progress'],
  testing: ['closed', 'in_progress'],
  closed: [],
};

function now(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export interface WorkflowServiceDeps {
  store: JsonPlatformStore;
  gitService: GitService;
  scmClient: ScmClient;
  instanceManager: InstanceManager;
  compensationService: CompensationService;
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  async startSprint(input: StartSprintInput): Promise<Sprint> {
    const project = this.requireProject(input.projectId);
    const sprintBranchName = `${project.repository.sprintBranchPrefix}${slugify(input.sprintName)}`;
    await this.deps.gitService.createSprintBranch({
      repoPath: project.repository.localPath,
      baseBranch: input.baseBranch ?? project.repository.baseBranch,
      nextBranch: sprintBranchName,
    });

    const sprint: Sprint = {
      id: crypto.randomUUID(),
      projectId: project.id,
      name: input.sprintName,
      branchName: sprintBranchName,
      baseBranch: input.baseBranch ?? project.repository.baseBranch,
      status: 'active',
      taskIds: [],
      startedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    return this.deps.store.upsertSprint(sprint);
  }

  async assignTask(input: AssignTaskInput): Promise<TaskSession> {
    const project = this.requireProject(input.projectId);
    const sprint = this.requireSprint(input.sprintId);
    const role = input.role ?? 'developer';
    if (role !== 'developer') {
      throw new Error('Task assignment entrypoint currently supports developer role only');
    }

    const branchName = `${project.repository.taskBranchPrefix}${slugify(input.issueId)}`;
    await this.deps.gitService.createTaskBranch({
      repoPath: project.repository.localPath,
      baseBranch: sprint.branchName,
      nextBranch: branchName,
    });

    const existing = this.deps.store.getTaskSessionByIssueId(input.issueId);
    const taskSession: TaskSession = this.deps.store.upsertTaskSession({
      id: existing?.id ?? crypto.randomUUID(),
      projectId: project.id,
      sprintId: sprint.id,
      taskId: input.issueId,
      issueId: input.issueId,
      title: input.title,
      workflowState: 'in_progress',
      runtime: input.runtime,
      role,
      sessionId: existing?.sessionId ?? crypto.randomUUID(),
      providerSessionId: existing?.providerSessionId,
      workingDirectory: project.repository.localPath,
      branchName,
      messageQueueKey: existing?.messageQueueKey ?? createTaskQueueKey(input.issueId),
      approvalQueueKey: existing?.approvalQueueKey ?? createApprovalQueueKey(input.issueId),
      conversationHistory: existing?.conversationHistory ?? [],
      systemPrompt: existing?.systemPrompt,
      lastError: undefined,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    });

    if (!sprint.taskIds.includes(taskSession.id)) {
      this.deps.store.upsertSprint({
        ...sprint,
        taskIds: [...sprint.taskIds, taskSession.id],
      });
    }

    const instance = await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(taskSession, role),
    );
    this.deps.store.appendConversationEntry(taskSession.id, {
      role: 'system',
      source: 'workflow',
      content: `Assigned to ${instance.runtime} ${instance.role} agent on branch ${branchName}.`,
    });
    return this.requireTaskSession(taskSession.id);
  }

  async submitTaskForReview(input: SubmitTaskForReviewInput): Promise<{ taskSession: TaskSession; pullRequest: PullRequestRef }> {
    const taskSession = this.requireTaskSession(input.taskSessionId);
    this.assertTransition(taskSession.workflowState, 'review');

    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);

    const commitResult = await this.deps.gitService.commitAll({
      repoPath: project.repository.localPath,
      message: input.commitMessage,
    });

    if (commitResult.committed) {
      await this.deps.gitService.pushBranch(project.repository.localPath, taskSession.branchName!);
    }

    const pullRequest = await this.deps.scmClient.createPullRequest({
      project,
      title: input.prTitle,
      body: input.prBody,
      sourceBranch: taskSession.branchName!,
      targetBranch: sprint.branchName,
    });

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'review',
      pullRequestUrl: pullRequest.url,
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'reviewer'),
    );

    this.deps.store.appendConversationEntry(updatedTaskSession.id, {
      role: 'system',
      source: 'workflow',
      content: `Created PR ${pullRequest.url} and started reviewer agent.`,
    });

    return { taskSession: updatedTaskSession, pullRequest };
  }

  async startTesting(taskSessionId: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'testing');

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'testing',
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );

    this.deps.store.appendConversationEntry(updatedTaskSession.id, {
      role: 'system',
      source: 'workflow',
      content: 'Started tester agent.',
    });

    return updatedTaskSession;
  }

  async closeTask(taskSessionId: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'closed');

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'closed',
    });

    for (const instance of this.deps.store.listAgentInstances(taskSession.id)) {
      await this.deps.instanceManager.stopInstance(instance.id);
    }

    return updatedTaskSession;
  }

  async handleTestFailure(payload: TaskFailurePayload): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(payload.taskSessionId);
    if (taskSession.workflowState !== 'testing') {
      throw new Error('Task is not in testing state');
    }

    await this.deps.compensationService.returnTaskToDeveloper(payload);
    return this.requireTaskSession(payload.taskSessionId);
  }

  resolveApproval(permissionRequestId: string, input: ApprovalResolutionInput): boolean {
    return this.deps.instanceManager.resolveApproval(permissionRequestId, {
      behavior: input.behavior,
      message: input.message,
    });
  }

  async handleJiraWebhook(payload: JiraWebhookPayload): Promise<TaskSession | Sprint | null> {
    const normalizedStatus = payload.status?.trim().toLowerCase();
    if (!normalizedStatus) return null;

    if (normalizedStatus === 'in progress') {
      if (!payload.sprintId || !payload.title || !payload.runtime) {
        throw new Error('Jira in-progress transition requires sprintId, title, and runtime');
      }
      return this.assignTask({
        projectId: payload.projectId,
        sprintId: payload.sprintId,
        issueId: payload.issueId,
        title: payload.title,
        runtime: payload.runtime,
      });
    }

    const taskSession = this.deps.store.getTaskSessionByIssueId(payload.issueId);
    if (!taskSession) return null;

    if (normalizedStatus === 'review') {
      await this.submitTaskForReview({
        taskSessionId: taskSession.id,
        commitMessage: `feat(${taskSession.issueId}): submit task for review`,
        prTitle: `[${taskSession.issueId}] ${taskSession.title}`,
        prBody: 'Automated PR created by agent-im workflow service.',
      });
      return this.requireTaskSession(taskSession.id);
    }

    if (normalizedStatus === 'testing') {
      return this.startTesting(taskSession.id);
    }

    if (normalizedStatus === 'closed' || normalizedStatus === 'done') {
      return this.closeTask(taskSession.id);
    }

    return taskSession;
  }

  private buildAgentInstance(taskSession: TaskSession, role: AgentRole): AgentInstanceRecord {
    const project = this.requireProject(taskSession.projectId);
    const existing = this.deps.store.findAgentInstance(taskSession.id, role);

    return {
      id: existing?.id ?? crypto.randomUUID(),
      projectId: taskSession.projectId,
      sprintId: taskSession.sprintId,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: taskSession.runtime,
      role,
      status: existing?.status ?? 'starting',
      branchName: taskSession.branchName,
      workingDirectory: project.repository.localPath,
      jira: existing?.jira ?? {
        baseUrl: process.env.CTI_JIRA_BASE_URL || '',
        issueId: taskSession.issueId,
        email: process.env.CTI_JIRA_EMAIL || '',
        apiToken: process.env.CTI_JIRA_API_TOKEN || '',
        pollIntervalMs: Number(process.env.CTI_JIRA_POLL_INTERVAL_MS || 5000),
        botAccountId: process.env.CTI_JIRA_BOT_ACCOUNT_ID || undefined,
      },
      approvalsRequired: true,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      startedAt: existing?.startedAt,
      stoppedAt: existing?.stoppedAt,
      lastError: existing?.lastError,
    };
  }

  private assertTransition(from: TaskWorkflowState, to: TaskWorkflowState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
    }
  }

  private requireProject(projectId: string) {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  private requireSprint(sprintId: string) {
    const sprint = this.deps.store.getSprint(sprintId);
    if (!sprint) throw new Error(`Sprint not found: ${sprintId}`);
    return sprint;
  }

  private requireTaskSession(taskSessionId: string) {
    const taskSession = this.deps.store.getTaskSession(taskSessionId);
    if (!taskSession) throw new Error(`Task session not found: ${taskSessionId}`);
    return taskSession;
  }
}
