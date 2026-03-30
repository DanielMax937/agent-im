import crypto from 'node:crypto';
import path from 'node:path';

import { CompensationService } from './compensation-service';
import { resolveKanbanAgent } from './kanban-agents';
import { createApprovalQueueKey, createTaskQueueKey, JsonPlatformStore } from './json-platform-store';
import { GitService } from './git-service';
import { InstanceManager } from './instance-manager';
import type { PullRequestRef, ScmClient } from './scm-client';
import type {
  AgentInstanceRecord,
  AgentRole,
  AgentRuntime,
  ApprovalResolutionInput,
  AssignTaskInput,
  CreateTaskInput,
  JiraWebhookPayload,
  KanbanAgentKind,
  Sprint,
  StartSprintInput,
  SubmitTaskForReviewInput,
  TaskFailurePayload,
  TaskSession,
  TaskWorkflowState,
} from './types';

const ALLOWED_TRANSITIONS: Record<TaskWorkflowState, TaskWorkflowState[]> = {
  todo: ['in_progress'],
  in_progress: ['review', 'testing'],
  review: ['testing', 'in_progress'],
  testing: ['closed', 'in_progress', 'regression_testing'],
  regression_testing: ['closed', 'testing', 'in_progress'],
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

function runtimeForRole(role: AgentRole, taskSession: TaskSession): AgentRuntime {
  if (role === 'reviewer') return 'claude';
  if (role === 'tester') return 'copilot';
  return taskSession.runtime;
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

  /** Create a task in **todo** (no branch, no runner). */
  async createTask(input: CreateTaskInput): Promise<TaskSession> {
    const project = this.requireProject(input.projectId);
    const sprint = this.requireSprint(input.sprintId);
    if (this.deps.store.getTaskSessionByIssueId(input.issueId)) {
      throw new Error(`Task already exists for issue ${input.issueId}`);
    }

    const id = crypto.randomUUID();
    const taskSession = this.deps.store.upsertTaskSession({
      id,
      projectId: project.id,
      sprintId: sprint.id,
      taskId: input.issueId,
      issueId: input.issueId,
      title: input.title,
      workflowState: 'todo',
      runtime: 'claude',
      role: 'developer',
      sessionId: crypto.randomUUID(),
      workingDirectory: project.repository.localPath,
      messageQueueKey: createTaskQueueKey(input.issueId),
      approvalQueueKey: createApprovalQueueKey(input.issueId),
      conversationHistory: [],
      createdAt: now(),
      updatedAt: now(),
    });

    if (!sprint.taskIds.includes(taskSession.id)) {
      this.deps.store.upsertSprint({
        ...sprint,
        taskIds: [...sprint.taskIds, taskSession.id],
      });
    }

    await this.appendWorkflowComment(
      taskSession.id,
      `Created task ${input.issueId} in project ${project.name} (todo).`,
    );
    return taskSession;
  }

  /**
   * Assign work to a lane runner. Use `taskSessionId` + `kanbanAgent` to pick up a **todo** card;
   * otherwise legacy one-shot assign (creates **in_progress** immediately).
   */
  async assignTask(input: AssignTaskInput): Promise<TaskSession> {
    if (input.taskSessionId) {
      return this.assignFromTodo(input);
    }

    const existingTodo = this.deps.store.getTaskSessionByIssueId(input.issueId);
    if (existingTodo?.workflowState === 'todo') {
      throw new Error('Task exists in todo; assign with taskSessionId and kanbanAgent, or use assignFromTodo');
    }

    if (!input.title?.trim() || !input.runtime) {
      throw new Error('Legacy assignTask requires title and runtime');
    }

    const project = this.requireProject(input.projectId);
    const sprint = this.requireSprint(input.sprintId);
    const role = input.role ?? 'developer';
    if (role !== 'developer') {
      throw new Error('Legacy assignTask supports developer role only');
    }

    const branchName = `${project.repository.taskBranchPrefix}${slugify(input.issueId)}`;
    const useWt = process.env.CTI_KANBAN_USE_WORKTREE === '1';
    let workingDir = project.repository.localPath;
    let worktreePath: string | undefined;
    if (useWt) {
      worktreePath = path.join(path.dirname(project.repository.localPath), `wt-${slugify(input.issueId)}`);
      await this.deps.gitService.createTaskWorktree({
        repoPath: project.repository.localPath,
        baseBranch: sprint.branchName,
        worktreePath,
        branchName,
      });
      workingDir = worktreePath;
    } else {
      await this.deps.gitService.createTaskBranch({
        repoPath: project.repository.localPath,
        baseBranch: sprint.branchName,
        nextBranch: branchName,
      });
    }

    const existing = this.deps.store.getTaskSessionByIssueId(input.issueId);
    const taskSession: TaskSession = this.deps.store.upsertTaskSession({
      id: existing?.id ?? crypto.randomUUID(),
      projectId: project.id,
      sprintId: sprint.id,
      taskId: input.issueId,
      issueId: input.issueId,
      title: input.title!,
      workflowState: 'in_progress',
      runtime: input.runtime,
      runtimeProfileId: input.runtimeProfileId ?? existing?.runtimeProfileId,
      role,
      kanbanAgent: 'agent-dev',
      preferredSkills: resolveKanbanAgent('agent-dev').preferredSkills,
      sessionId: existing?.sessionId ?? crypto.randomUUID(),
      providerSessionId: existing?.providerSessionId,
      workingDirectory: workingDir,
      worktreePath,
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
    await this.appendWorkflowComment(
      taskSession.id,
      `Assigned to ${instance.runtime} ${instance.role} on ${branchName}${worktreePath ? ` (worktree ${worktreePath})` : ''}.`,
    );
    return this.requireTaskSession(taskSession.id);
  }

  private async assignFromTodo(input: AssignTaskInput): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(input.taskSessionId!);
    if (taskSession.workflowState !== 'todo') {
      throw new Error('assignFromTodo requires workflowState=todo');
    }
    if (taskSession.projectId !== input.projectId || taskSession.sprintId !== input.sprintId) {
      throw new Error('projectId/sprintId mismatch for taskSession');
    }
    if (input.issueId !== taskSession.issueId) {
      throw new Error('issueId must match the task session');
    }

    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);
    const kind: KanbanAgentKind = input.kanbanAgent ?? 'agent-dev';
    if (kind !== 'agent-dev' && kind !== 'codex-senior') {
      throw new Error('assignFromTodo only supports kanbanAgent agent-dev or codex-senior');
    }
    const rejectionCount = taskSession.reviewRejectionCount ?? 0;
    const resolved = resolveKanbanAgent(kind, rejectionCount);

    const branchName = `${project.repository.taskBranchPrefix}${slugify(taskSession.issueId)}`;
    const useWt = process.env.CTI_KANBAN_USE_WORKTREE === '1';
    let workingDir = project.repository.localPath;
    let worktreePath: string | undefined;
    if (useWt) {
      worktreePath = path.join(path.dirname(project.repository.localPath), `wt-${slugify(taskSession.issueId)}`);
      await this.deps.gitService.createTaskWorktree({
        repoPath: project.repository.localPath,
        baseBranch: sprint.branchName,
        worktreePath,
        branchName,
      });
      workingDir = worktreePath;
    } else {
      await this.deps.gitService.createTaskBranch({
        repoPath: project.repository.localPath,
        baseBranch: sprint.branchName,
        nextBranch: branchName,
      });
    }

    const handoff = input.handoffComment ?? taskSession.handoffComment;

    const next = this.deps.store.upsertTaskSession({
      ...taskSession,
      title: input.title || taskSession.title,
      workflowState: 'in_progress',
      runtime: resolved.runtime,
      role: resolved.role,
      kanbanAgent: resolved.kanbanAgent,
      preferredSkills: resolved.preferredSkills,
      handoffComment: handoff,
      branchName,
      worktreePath,
      workingDirectory: workingDir,
      runtimeProfileId: input.runtimeProfileId ?? taskSession.runtimeProfileId,
      updatedAt: now(),
    });

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(next, resolved.role));
    if (handoff?.trim()) {
      await this.appendWorkflowComment(
        next.id,
        `Handoff (read before running): ${handoff.trim()}`,
      );
    }
    await this.appendWorkflowComment(
      next.id,
      `Assigned from todo → ${resolved.kanbanAgent} (${resolved.role}/${resolved.runtime}).`,
    );
    return this.requireTaskSession(next.id);
  }

  async rejectReview(taskSessionId: string, comment: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'in_progress');
    const nextCount = (taskSession.reviewRejectionCount ?? 0) + 1;
    const resolved = resolveKanbanAgent('agent-dev', nextCount);

    const updated = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'in_progress',
      reviewRejectionCount: nextCount,
      runtime: resolved.runtime,
      kanbanAgent: resolved.kanbanAgent,
      preferredSkills: resolved.preferredSkills,
      handoffComment: comment,
      updatedAt: now(),
    });

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(updated, 'developer'));
    await this.appendWorkflowComment(
      updated.id,
      `Review rejected (round ${nextCount}). Escalation runtime: ${resolved.runtime}. Comment: ${comment}`,
    );
    return updated;
  }

  async submitTaskForReview(input: SubmitTaskForReviewInput): Promise<{ taskSession: TaskSession; pullRequest: PullRequestRef }> {
    const taskSession = this.requireTaskSession(input.taskSessionId);
    this.assertTransition(taskSession.workflowState, 'review');

    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);
    const repoPath = taskSession.worktreePath ?? project.repository.localPath;

    const commitResult = await this.deps.gitService.commitAll({
      repoPath,
      message: input.commitMessage,
    });

    if (commitResult.committed) {
      await this.deps.gitService.pushBranch(repoPath, taskSession.branchName!);
    }

    const pullRequest = await this.deps.scmClient.createPullRequest({
      project,
      title: input.prTitle,
      body: input.prBody,
      sourceBranch: taskSession.branchName!,
      targetBranch: sprint.branchName,
    });

    const reviewerPreset = resolveKanbanAgent('claude-review');

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'review',
      pullRequestUrl: pullRequest.url,
      preferredSkills: reviewerPreset.preferredSkills,
      kanbanAgent: 'claude-review',
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'reviewer'),
    );

    await this.appendWorkflowComment(updatedTaskSession.id, `Created PR ${pullRequest.url} and started reviewer.`);

    return { taskSession: updatedTaskSession, pullRequest };
  }

  async startTesting(taskSessionId: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'testing');

    const testerPreset = resolveKanbanAgent('copilot-test');

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'testing',
      preferredSkills: testerPreset.preferredSkills,
      kanbanAgent: 'copilot-test',
      handoffComment:
        taskSession.handoffComment ??
        'Feature testing: run focused tests on the task branch only; defer merge conflict resolution.',
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );

    await this.appendWorkflowComment(updatedTaskSession.id, 'Started feature tester (branch scope).');

    return updatedTaskSession;
  }

  async startRegressionTesting(taskSessionId: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'regression_testing');

    const project = this.requireProject(taskSession.projectId);
    const repoPath = project.repository.localPath;
    const base = project.repository.baseBranch;
    const remoteRef = `origin/${base}`;

    await this.deps.gitService.fetchOrigin(repoPath);
    const masterSha = await this.deps.gitService.resolveRefSha(repoPath, remoteRef);

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'regression_testing',
      regressionMasterSha: masterSha,
      preferredSkills: [
        'verification-before-completion',
        'Regression on master: if new commits landed, discard stale test branches and re-pull master before running suites.',
      ],
      handoffComment:
        taskSession.handoffComment ??
        'Regression phase: test against master; refresh regression cases when the app changes.',
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );

    await this.appendWorkflowComment(
      updatedTaskSession.id,
      `Started regression tester (master ${base} @ ${masterSha.slice(0, 7)}).`,
    );

    return updatedTaskSession;
  }

  /**
   * Compares current `origin/<baseBranch>` to `regressionMasterSha`. If master moved, updates baseline,
   * appends workflow comments (Telegram via store), refreshes handoff, and restarts the tester runner.
   */
  async refreshRegressionIfMasterAdvanced(taskSessionId: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    if (taskSession.workflowState !== 'regression_testing') {
      throw new Error('refreshRegressionIfMasterAdvanced requires workflowState=regression_testing');
    }

    const project = this.requireProject(taskSession.projectId);
    const repoPath = project.repository.localPath;
    const base = project.repository.baseBranch;
    const remoteRef = `origin/${base}`;

    await this.deps.gitService.fetchOrigin(repoPath);
    const currentSha = await this.deps.gitService.resolveRefSha(repoPath, remoteRef);
    const baseline = taskSession.regressionMasterSha;

    if (!baseline) {
      const next = this.deps.store.upsertTaskSession({
        ...taskSession,
        regressionMasterSha: currentSha,
      });
      await this.appendWorkflowComment(taskSessionId, `Regression baseline recorded at ${currentSha.slice(0, 7)}.`);
      return next;
    }

    if (currentSha === baseline) {
      await this.appendWorkflowComment(
        taskSessionId,
        `Regression check: ${base} unchanged (${currentSha.slice(0, 7)}).`,
      );
      return this.requireTaskSession(taskSessionId);
    }

    const next = this.deps.store.upsertTaskSession({
      ...taskSession,
      regressionMasterSha: currentSha,
      handoffComment: [
        `主分支 ${base} 已前进（${baseline.slice(0, 7)} → ${currentSha.slice(0, 7)}）。`,
        '请废弃当前用于回归的测试分支或旧 checkout，从 origin 拉取最新代码后重新执行全量回归测试；勿在过时检出上继续补测。',
      ].join(' '),
    });

    await this.appendWorkflowComment(
      taskSessionId,
        `主分支 ${base} 有新合并；已废弃基于旧 SHA 的回归基线。请拉取 ${base} @ ${currentSha.slice(0, 7)} 后重新跑回归。`,
    );

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(next, 'tester'));
    return next;
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

    await this.appendWorkflowComment(updatedTaskSession.id, 'Task closed.');
    return updatedTaskSession;
  }

  async handleTestFailure(payload: TaskFailurePayload): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(payload.taskSessionId);
    if (taskSession.workflowState !== 'testing' && taskSession.workflowState !== 'regression_testing') {
      throw new Error('Task is not in testing or regression_testing state');
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

    if (normalizedStatus === 'regression' || normalizedStatus === 'regression testing') {
      return this.startRegressionTesting(taskSession.id);
    }

    if (normalizedStatus === 'closed' || normalizedStatus === 'done') {
      return this.closeTask(taskSession.id);
    }

    return taskSession;
  }

  async ensureAgentInstance(
    taskSessionId: string,
    role: AgentRole,
    runtimeProfileId?: string,
  ): Promise<AgentInstanceRecord> {
    const taskSession = this.requireTaskSession(taskSessionId);
    const instance = this.buildAgentInstance(taskSession, role);
    return this.deps.instanceManager.upsertAndStart({
      ...instance,
      ...(runtimeProfileId !== undefined ? { runtimeProfileId } : {}),
    });
  }

  /** Owner / dashboard: aggregate snapshot + per-project counts (requirement k). */
  getKanbanStatus(): {
    projects: ReturnType<JsonPlatformStore['listProjects']>;
    tasksByState: Record<TaskWorkflowState, number>;
    instances: ReturnType<JsonPlatformStore['listAgentInstances']>;
    tasksByProject: {
      projectId: string;
      name: string;
      owner?: string;
      tasksByState: Record<TaskWorkflowState, number>;
    }[];
  } {
    const tasks = this.deps.store.listTaskSessions();
    const emptyCounts = (): Record<TaskWorkflowState, number> => ({
      todo: 0,
      in_progress: 0,
      review: 0,
      testing: 0,
      regression_testing: 0,
      closed: 0,
    });
    const tasksByState = emptyCounts();
    for (const t of tasks) {
      tasksByState[t.workflowState] += 1;
    }
    const projects = this.deps.store.listProjects();
    const tasksByProject = projects.map((p) => {
      const counts = emptyCounts();
      for (const t of tasks) {
        if (t.projectId === p.id) counts[t.workflowState] += 1;
      }
      return {
        projectId: p.id,
        name: p.name,
        ...(p.owner ? { owner: p.owner } : {}),
        tasksByState: counts,
      };
    });
    return {
      projects,
      tasksByState,
      instances: this.deps.store.listAgentInstances(),
      tasksByProject,
    };
  }

  private async appendWorkflowComment(taskSessionId: string, content: string): Promise<void> {
    this.deps.store.appendConversationEntry(taskSessionId, {
      role: 'system',
      source: 'workflow',
      content,
    });
  }

  private buildAgentInstance(taskSession: TaskSession, role: AgentRole): AgentInstanceRecord {
    const project = this.requireProject(taskSession.projectId);
    const existing = this.deps.store.findAgentInstance(taskSession.id, role);
    const rt = runtimeForRole(role, taskSession);

    return {
      id: existing?.id ?? crypto.randomUUID(),
      projectId: taskSession.projectId,
      sprintId: taskSession.sprintId,
      taskId: taskSession.taskId,
      taskSessionId: taskSession.id,
      runtime: rt,
      runtimeProfileId: taskSession.runtimeProfileId ?? existing?.runtimeProfileId,
      role,
      status: existing?.status ?? 'starting',
      branchName: taskSession.branchName,
      workingDirectory: taskSession.workingDirectory || project.repository.localPath,
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
