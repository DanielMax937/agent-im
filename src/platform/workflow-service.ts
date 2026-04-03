import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, normalizeRunners, resolveRuntimeForPlatformInstance } from '../config';
import { PendingPermissions } from '../permission-gateway';
import { resolveProvider } from '../runtime-provider';
import {
  pickRunnerForCodexSenior,
  parsePreviewBatchSpecBody,
  runBatchTaskSpecLlm,
  normalizeBatchTaskPlan,
  type BatchTaskPlanItem,
} from './batch-task-spec';
import { BOARD_BRAINSTORM_SYSTEM, type BoardBrainstormChatInput } from './board-brainstorm';
import { CompensationService } from './compensation-service';
import { getKanbanLogger } from './kanban-logger';
import { preferredSkillsForProjectLane, resolveKanbanAgent } from './kanban-agents';
import { parseKanbanAction } from './kanban-workflow-parser';
import { buildSystemCheckPrompt, kanbanConfirmationMaxLoops } from './kanban-confirmation';
import { notifyKanbanTelegram } from './kanban-notify';
import { buildTransitionHistoryComment, notifyWorkflowStateTransition } from './kanban-transition-notify';
import { mergeKanbanAssignee, resolveKanbanAssignment } from './kanban-role-assign';
import { createApprovalQueueKey, createTaskQueueKey, JsonPlatformStore } from './json-platform-store';
import { GitService } from './git-service';
import { assertValidLocalRepositoryPath } from './repository-path';
import { InstanceManager } from './instance-manager';
import { isScmMergeNotMergeableError, type PullRequestRef, type ScmClient } from './scm-client';
import type {
  AgentInstanceRecord,
  AgentRole,
  AgentRuntime,
  ApprovalResolutionInput,
  AssignTaskInput,
  CreateTaskInput,
  KanbanAgentKind,
  Project,
  Sprint,
  StartSprintInput,
  SubmitTaskForReviewInput,
  TaskFailurePayload,
  TaskHistoryComment,
  TaskSession,
  TaskWorkflowState,
} from './types';

/**
 * Upstream dependency tasks must reach one of these columns before downstream cards may leave
 * `pending_start` and start development (`in_progress`).
 */
const DEPENDENCY_SATISFIED_STATES = new Set<TaskWorkflowState>(['pending_release', 'closed']);

/** Dev → pre-test → feature test → PR review → merge → regression on merge target branch. */
const ALLOWED_TRANSITIONS: Record<TaskWorkflowState, TaskWorkflowState[]> = {
  todo: ['pending_start'],
  pending_start: ['in_progress'],
  in_progress: ['pre_testing'],
  pre_testing: ['testing'],
  testing: ['review', 'in_progress'],
  review: ['in_progress', 'regression_testing'],
  regression_testing: ['pending_release'],
  pending_release: ['closed'],
  closed: [],
};

function useKanbanWorktree(): boolean {
  return process.env.CTI_KANBAN_USE_WORKTREE !== '0';
}

function now(): string {
  return new Date().toISOString();
}

export function roleForActiveWorkflowState(state: TaskWorkflowState): AgentRole | null {
  switch (state) {
    case 'pending_start':
      return null;
    case 'in_progress':
      return 'developer';
    case 'pre_testing':
      return 'tester';
    case 'review':
      return 'reviewer';
    case 'testing':
    case 'regression_testing':
      return 'tester';
    case 'pending_release':
      /** Human-only column: ensure/link release PR + PR comment; no runner. */
      return null;
    default:
      return null;
  }
}

function lastAssistantContentForRole(task: TaskSession, role: AgentRole): string | undefined {
  const entries = task.conversationHistory.filter(
    (e) => e.role === 'assistant' && e.source === role,
  );
  if (entries.length === 0) return undefined;
  return entries[entries.length - 1]!.content;
}

function previewForLog(text: string | undefined, max = 240): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Runner id from project Kanban mapping for this lane (see `Project.kanbanRoleRunners`). */
function runnerProfileForLane(project: Project, kind: KanbanAgentKind): string | undefined {
  const v = project.kanbanRoleRunners?.[kind]?.trim();
  return v || undefined;
}

/**
 * Explicit API `runtimeProfileId` wins, then per-project lane mapping, then fallbacks
 * (e.g. existing task session).
 */
function pickRuntimeProfile(
  project: Project,
  kind: KanbanAgentKind,
  explicit: string | undefined,
  ...fallbacks: (string | undefined)[]
): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const fromProject = runnerProfileForLane(project, kind);
  if (fromProject) return fromProject;
  for (const c of fallbacks) {
    if (c?.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Effective runtime + optional runner id for workflow logs. `task.runtime` is the lane default;
 * when `runtimeProfileId` is set, the running provider follows `resolveRuntimeForPlatformInstance`
 * (same as InstanceManager).
 */
function runnerSuffixForWorkflowLog(
  task: Pick<TaskSession, 'runtime' | 'runtimeProfileId'>,
): string {
  const cfg = loadConfig();
  const effective = resolveRuntimeForPlatformInstance(cfg, {
    runtime: task.runtime,
    runtimeProfileId: task.runtimeProfileId,
  });
  const pid = task.runtimeProfileId?.trim();
  if (!pid) return String(effective);
  const runner = normalizeRunners(cfg).find((r) => r.id === pid);
  const label = runner?.label?.trim();
  const showLabel = label && label !== pid;
  return `${effective} · runner ${pid}${showLabel ? ` (${label})` : ''}`;
}

function formatKanbanRunnerSummary(
  task: Pick<TaskSession, 'runtime' | 'runtimeProfileId' | 'kanbanAgent'>,
): string {
  const lane = task.kanbanAgent ?? 'agent-dev';
  return `${lane} / ${runnerSuffixForWorkflowLog(task)}`;
}

function formatDeveloperStartFromQueueLine(
  task: Pick<TaskSession, 'runtime' | 'runtimeProfileId' | 'kanbanAgent' | 'role'>,
  branchName: string,
  worktreePath: string | undefined,
): string {
  const lane = task.kanbanAgent ?? 'agent-dev';
  const role = task.role ?? 'developer';
  const inner = `${role}/${runnerSuffixForWorkflowLog(task)}`;
  return `Started from queue → ${lane} (${inner}) on ${branchName}${worktreePath ? ` (worktree ${worktreePath})` : ''}.`;
}

function runtimeForRole(role: AgentRole, taskSession: TaskSession): AgentRuntime {
  if (role === 'reviewer') return 'claude';
  if (role === 'tester') return 'copilot';
  return taskSession.runtime;
}

function isTransientHostMergeabilityReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /retry\s+APPROVE_MERGE\s+in\s+a\s+moment/i.test(reason) || /still computing/i.test(reason);
}

function defaultSubmitTaskForReviewInput(task: TaskSession): SubmitTaskForReviewInput {
  return {
    taskSessionId: task.id,
    commitMessage: `chore(${task.issueId}): submit for review`,
    prTitle: `[${task.issueId}] ${task.title}`,
    prBody: `Automated PR from Kanban workflow.\n\n${task.title}`,
  };
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

  /**
   * Append a manual note to the task (API / UI). Does not change workflow state.
   */
  async addTaskHistoryComment(
    taskSessionId: string,
    input: { content: string; role?: AgentRole | null },
  ): Promise<TaskSession> {
    const text = input.content.trim();
    if (!text) throw new Error('content is required');
    const task = this.requireTaskSession(taskSessionId);
    const entry: TaskHistoryComment = {
      id: crypto.randomUUID(),
      role: input.role === undefined ? null : input.role,
      kind: 'manual',
      content: text,
      createdAt: now(),
    };
    return this.deps.store.upsertTaskSession({
      ...task,
      historyComments: [...(task.historyComments ?? []), entry],
      updatedAt: now(),
    });
  }

  private normalizeDependsOnIssueIds(raw: string[] | undefined): string[] {
    if (!raw?.length) return [];
    return [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  }

  private dependsOnIssueIdsFor(projectId: string, issueId: string): string[] {
    return this.deps.store.getTaskSessionByProjectIssueId(projectId, issueId)?.dependsOnIssueIds ?? [];
  }

  /** Detects a directed cycle if `newIssueId` were added with edges `newIssueId -> newDeps`. */
  private wouldCreateDependencyCycle(projectId: string, newIssueId: string, newDeps: string[]): boolean {
    const dfs = (issue: string, stack: Set<string>): boolean => {
      if (stack.has(issue)) return true;
      stack.add(issue);
      const deps = issue === newIssueId ? newDeps : this.dependsOnIssueIdsFor(projectId, issue);
      for (const d of deps) {
        if (dfs(d, stack)) return true;
      }
      stack.delete(issue);
      return false;
    };
    return dfs(newIssueId, new Set());
  }

  /** True when every `dependsOnIssueId` is in {@link DEPENDENCY_SATISFIED_STATES} (merge主干 or 完成). */
  private dependencyTasksSatisfiedForQueue(task: TaskSession): boolean {
    const deps = task.dependsOnIssueIds ?? [];
    if (deps.length === 0) return true;
    for (const issueId of deps) {
      const t = this.deps.store.getTaskSessionByProjectIssueId(task.projectId, issueId);
      if (!t || !DEPENDENCY_SATISFIED_STATES.has(t.workflowState)) return false;
    }
    return true;
  }

  private enqueuePendingAssignmentSprint(sprint: Sprint, taskSessionId: string): void {
    const q = [...(sprint.pendingDeveloperAssignmentQueue ?? [])];
    if (!q.includes(taskSessionId)) q.push(taskSessionId);
    this.deps.store.upsertSprint({ ...sprint, pendingDeveloperAssignmentQueue: q, updatedAt: now() });
  }

  /**
   * Drains the sprint assignment queue: starts every `pending_start` task whose dependencies are
   * satisfied, **in queue order**, skipping blocked entries (they stay queued). Multiple tasks may
   * become `in_progress` in one run (concurrent agents).
   * Also invoked on a timer via `processAllDeveloperAssignmentQueues` (`CTI_KANBAN_QUEUE_POLL_MS`).
   */
  async processDeveloperAssignmentQueue(sprintId: string): Promise<void> {
    const sprint = this.requireSprint(sprintId);
    const queue = [...(sprint.pendingDeveloperAssignmentQueue ?? [])];
    if (queue.length === 0) return;

    const remaining: string[] = [];
    let changed = false;

    for (const taskSessionId of queue) {
      const task = this.deps.store.getTaskSession(taskSessionId);
      if (!task) {
        changed = true;
        continue;
      }
      if (task.workflowState !== 'pending_start') {
        changed = true;
        continue;
      }
      if (!this.dependencyTasksSatisfiedForQueue(task)) {
        remaining.push(taskSessionId);
        continue;
      }
      try {
        await this.materializeDeveloperAssignmentFromPending(task);
        changed = true;
      } catch (e) {
        getKanbanLogger().warn(
          { err: e, taskSessionId: task.id, sprintId },
          'materializeDeveloperAssignmentFromPending failed; will retry on next queue run',
        );
        remaining.push(taskSessionId);
        changed = true;
      }
    }

    if (!changed) return;

    const latest = this.requireSprint(sprintId);
    this.deps.store.upsertSprint({
      ...latest,
      pendingDeveloperAssignmentQueue: remaining,
      updatedAt: now(),
    });
  }

  /** Runs {@link processDeveloperAssignmentQueue} for every sprint (e.g. periodic poll). */
  async processAllDeveloperAssignmentQueues(): Promise<void> {
    for (const sp of this.deps.store.listSprints()) {
      await this.processDeveloperAssignmentQueue(sp.id);
    }
  }

  private async materializeDeveloperAssignmentFromPending(task: TaskSession): Promise<void> {
    const project = this.requireProject(task.projectId);
    const sprint = this.requireSprint(task.sprintId);
    this.assertProjectLocalRepositoryPath(project);
    const branchName = `${project.repository.taskBranchPrefix}${slugify(task.issueId)}`;
    const useWt = useKanbanWorktree();
    let workingDir = project.repository.localPath;
    let worktreePath: string | undefined;
    if (useWt) {
      worktreePath = path.join(path.dirname(project.repository.localPath), `wt-${slugify(task.issueId)}`);
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

    const prior = task;
    await notifyWorkflowStateTransition({
      task: prior,
      from: 'pending_start',
      to: 'in_progress',
      outgoingRole: null,
      actionLabel: '队列开始开发',
    });

    const next = this.deps.store.upsertTaskSession({
      ...prior,
      workflowState: 'in_progress',
      branchName,
      worktreePath,
      workingDirectory: workingDir,
      updatedAt: now(),
      historyComments: [
        ...(prior.historyComments ?? []),
        buildTransitionHistoryComment(prior, 'pending_start', 'in_progress', null, '队列开始开发'),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(next, next.role));
    this.enqueueKickoffPrompt(this.requireTaskSession(next.id));
    await this.appendWorkflowComment(
      next.id,
      formatDeveloperStartFromQueueLine(next, branchName, worktreePath),
    );
  }

  /**
   * After a successful assistant turn, parse `KANBAN_ACTION:...` from the latest reply for that role
   * and run the same workflow transitions as the dashboard API. Disabled when `CTI_KANBAN_WORKFLOW_AUTO=0`.
   * @returns true if `workflowState` changed.
   */
  async maybeAutoAdvanceAfterAgentTurn(
    taskSessionId: string,
    completedRole: AgentRole,
    instanceId: string,
  ): Promise<boolean> {
    if (process.env.CTI_KANBAN_WORKFLOW_AUTO === '0') return false;
    const taskSession = this.deps.store.getTaskSession(taskSessionId);
    if (!taskSession) {
      getKanbanLogger().debug(
        { taskSessionId, completedRole, instanceId },
        'auto-advance skipped: task session missing',
      );
      return false;
    }
    if (taskSession.workflowState === 'closed') {
      getKanbanLogger().debug(
        { taskSessionId, taskId: taskSession.taskId, issueId: taskSession.issueId, completedRole, instanceId },
        'auto-advance skipped: task already closed',
      );
      return false;
    }
    const workflowStateBefore = taskSession.workflowState;
    const last = [...taskSession.conversationHistory].reverse().find(
      (e) => e.role === 'assistant' && e.source === completedRole,
    );
    if (!last) {
      getKanbanLogger().info(
        {
          taskSessionId,
          taskId: taskSession.taskId,
          issueId: taskSession.issueId,
          completedRole,
          workflowState: taskSession.workflowState,
          instanceId,
        },
        'auto-advance skipped: no assistant reply found for completed role',
      );
      return false;
    }
    const parsed = parseKanbanAction(last.content);
    getKanbanLogger().info(
      {
        taskSessionId,
        taskId: taskSession.taskId,
        issueId: taskSession.issueId,
        completedRole,
        workflowState: taskSession.workflowState,
        instanceId,
        assistantReplyPreview: previewForLog(last.content),
        parsedAction: parsed?.action ?? null,
        parsedPayloadPreview: previewForLog(parsed?.payload),
      },
      parsed
        ? 'auto-advance parsed assistant workflow action'
        : 'auto-advance skipped: no parseable KANBAN_ACTION found in latest assistant reply',
    );
    if (!parsed) return false;
    try {
      await this.applyKanbanWorkflowAction(taskSession, completedRole, instanceId, parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      getKanbanLogger().warn(
        {
          err: e,
          taskSessionId,
          taskId: taskSession.taskId,
          issueId: taskSession.issueId,
          completedRole,
          workflowState: taskSession.workflowState,
          instanceId,
          parsedAction: parsed.action,
          parsedPayloadPreview: previewForLog(parsed.payload),
        },
        'auto-advance failed while applying parsed workflow action',
      );
      void notifyKanbanTelegram(`[Kanban][${taskSession.issueId}] Workflow auto-advance failed: ${msg}`);
      return false;
    }

    const after = this.deps.store.getTaskSession(taskSessionId);
    getKanbanLogger().info(
      {
        taskSessionId,
        taskId: taskSession.taskId,
        issueId: taskSession.issueId,
        completedRole,
        instanceId,
        workflowStateBefore,
        workflowStateAfter: after?.workflowState ?? null,
        parsedAction: parsed.action,
      },
      after !== null && after.workflowState !== workflowStateBefore
        ? 'auto-advance applied workflow action and changed lane'
        : 'auto-advance applied workflow action but lane did not change',
    );
    return after !== null && after.workflowState !== workflowStateBefore;
  }

  /**
   * Runs auto-advance when enabled; if the task did not change column, enqueues a `system_check` prompt
   * (bounded by `CTI_KANBAN_CONFIRMATION_MAX_LOOPS`).
   */
  async afterSuccessfulAssistantTurn(
    taskSessionId: string,
    completedRole: AgentRole,
    instanceId: string,
  ): Promise<void> {
    const before = this.deps.store.getTaskSession(taskSessionId);
    if (!before) return;
    const workflowStateBefore = before.workflowState;

    await this.maybeAutoAdvanceAfterAgentTurn(taskSessionId, completedRole, instanceId);

    const mid = this.deps.store.getTaskSession(taskSessionId);
    if (!mid) return;
    if (mid.workflowState !== workflowStateBefore) {
      return;
    }

    await this.maybeEnqueueSystemCheck(mid);
  }

  /** Queue a human-authored user message and reset confirmation loop count. */
  async enqueueManualQueueMessage(taskSessionId: string, content: string): Promise<void> {
    const text = content.trim();
    if (!text) throw new Error('content is required');
    const task = this.requireTaskSession(taskSessionId);
    if (
      task.workflowState === 'todo' ||
      task.workflowState === 'pending_start' ||
      task.workflowState === 'closed'
    ) {
      throw new Error('Cannot queue a manual message for todo, pending_start, or closed tasks');
    }
    const role = roleForActiveWorkflowState(task.workflowState);
    if (!role) throw new Error('No active lane for this workflow state');

    this.deps.store.enqueueTaskMessage({
      queueKey: task.messageQueueKey,
      taskSessionId: task.id,
      taskId: task.taskId,
      type: 'human_followup',
      content: text,
    });
    this.deps.store.upsertTaskSession({
      ...task,
      confirmationLoopCount: 0,
    });

    const inst = this.deps.store.findAgentInstance(task.id, role);
    if (inst) await this.deps.instanceManager.startInstance(inst.id);
  }

  private async maybeEnqueueSystemCheck(task: TaskSession): Promise<void> {
    if (task.workflowState === 'todo' || task.workflowState === 'pending_start' || task.workflowState === 'closed')
      return;
    const expected = roleForActiveWorkflowState(task.workflowState);
    if (!expected) return;

    const max = kanbanConfirmationMaxLoops();
    const n = task.confirmationLoopCount ?? 0;
    if (n >= max) {
      void notifyKanbanTelegram(
        `[Kanban][${task.issueId}] Human intervention requested: confirmation loop limit (${max}) reached without a workflow transition.`,
      );
      return;
    }

    const content = buildSystemCheckPrompt(task, expected);
    this.deps.store.enqueueTaskMessage({
      queueKey: task.messageQueueKey,
      taskSessionId: task.id,
      taskId: task.taskId,
      type: 'system_check',
      content,
    });
    this.deps.store.upsertTaskSession({
      ...task,
      confirmationLoopCount: n + 1,
    });

    const inst = this.deps.store.findAgentInstance(task.id, expected);
    if (inst) await this.deps.instanceManager.startInstance(inst.id);
  }

  private async applyKanbanWorkflowAction(
    taskSession: TaskSession,
    completedRole: AgentRole,
    instanceId: string,
    parsed: { action: string; payload?: string },
  ): Promise<void> {
    const defer = instanceId;
    const { workflowState } = taskSession;
    const logSkip = (reason: string) => {
      getKanbanLogger().info(
        {
          taskSessionId: taskSession.id,
          taskId: taskSession.taskId,
          issueId: taskSession.issueId,
          completedRole,
          workflowState,
          instanceId,
          parsedAction: parsed.action,
          parsedPayloadPreview: previewForLog(parsed.payload),
          reason,
        },
        'auto-advance ignored parsed workflow action',
      );
    };
    if (parsed.action === 'START_TESTING') {
      if (workflowState !== 'in_progress' || completedRole !== 'developer') {
        logSkip('START_TESTING requires developer in in_progress');
        return;
      }
      await this.startTesting(taskSession.id, defer);
      return;
    }

    if (parsed.action === 'START_FEATURE_TESTING') {
      if (workflowState !== 'pre_testing' || completedRole !== 'tester') {
        logSkip('START_FEATURE_TESTING requires tester in pre_testing');
        return;
      }
      await this.startFeatureTesting(taskSession.id, defer);
      return;
    }

    if (parsed.action === 'SUBMIT_REVIEW') {
      if (workflowState !== 'testing' || completedRole !== 'tester') {
        logSkip('SUBMIT_REVIEW requires tester in testing');
        return;
      }
      await this.submitTaskForReview({
        ...defaultSubmitTaskForReviewInput(taskSession),
        deferStopInstanceId: defer,
      });
      return;
    }

    if (parsed.action === 'REJECT_REVIEW') {
      if (workflowState !== 'review' || completedRole !== 'reviewer') {
        logSkip('REJECT_REVIEW requires reviewer in review');
        return;
      }
      await this.rejectReview(taskSession.id, parsed.payload?.trim() || 'Rejected by reviewer.', defer);
      return;
    }

    if (parsed.action === 'APPROVE_MERGE') {
      if (workflowState !== 'review' || completedRole !== 'reviewer') {
        logSkip('APPROVE_MERGE requires reviewer in review');
        return;
      }
      await this.mergeApprovedPullRequestAndStartRegression(taskSession.id, defer);
      return;
    }

    if (parsed.action === 'RETURN_TO_DEVELOPMENT') {
      if (workflowState !== 'testing' || completedRole !== 'tester') {
        logSkip('RETURN_TO_DEVELOPMENT requires tester in testing');
        return;
      }
      await this.returnTestingToDevelopment(
        taskSession.id,
        parsed.payload?.trim() || 'Feature tests failed; returning to development.',
        defer,
      );
      return;
    }

    if (parsed.action === 'PROCEED_TO_RELEASE') {
      if (workflowState !== 'regression_testing' || completedRole !== 'tester') {
        logSkip('PROCEED_TO_RELEASE requires tester in regression_testing');
        return;
      }
      await this.proceedToPendingRelease(taskSession.id, defer);
      return;
    }

    if (parsed.action === 'CLOSE') {
      if (completedRole !== 'tester') {
        logSkip('CLOSE requires tester role');
        return;
      }
      if (workflowState !== 'pending_release') {
        logSkip('CLOSE requires pending_release state');
        return;
      }
      await this.closeTask(taskSession.id, defer);
      return;
    }

    logSkip('unknown KANBAN_ACTION');
  }

  /**
   * Stops runners for a task before a workflow transition. When `deferStopInstanceId` is set (auto-advance
   * from that runner), that instance is stopped on the next macrotask so we do not await the same runner
   * while its `runLoop` is still awaiting this transition.
   */
  private async stopInstancesForTask(taskSessionId: string, deferStopInstanceId?: string): Promise<void> {
    for (const inst of this.deps.store.listAgentInstances(taskSessionId)) {
      if (deferStopInstanceId && inst.id === deferStopInstanceId) continue;
      await this.deps.instanceManager.stopInstance(inst.id);
    }
    if (deferStopInstanceId) {
      const id = deferStopInstanceId;
      setImmediate(() => {
        void this.deps.instanceManager.stopInstance(id);
      });
    }
  }

  private projectTasks(projectId: string): TaskSession[] {
    return this.deps.store.listTaskSessions(projectId);
  }

  private assertProjectLocalRepositoryPath(project: Project): void {
    assertValidLocalRepositoryPath(project.repository.localPath);
  }

  async startSprint(input: StartSprintInput): Promise<Sprint> {
    const project = this.requireProject(input.projectId);
    this.assertProjectLocalRepositoryPath(project);
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
    if (sprint.projectId !== project.id) {
      throw new Error('Sprint does not belong to the selected project');
    }
    let issueId = input.issueId?.trim();
    if (!issueId) {
      issueId = this.deps.store.previewNextIssueId(project.id);
    } else if (this.deps.store.getTaskSessionByProjectIssueId(project.id, issueId)) {
      throw new Error(`Task already exists for issue ${issueId} in this project`);
    }

    const dependsOnIssueIds = this.normalizeDependsOnIssueIds(input.dependsOnIssueIds);
    for (const dep of dependsOnIssueIds) {
      if (dep === issueId) {
        throw new Error('Task cannot depend on itself');
      }
      if (!this.deps.store.getTaskSessionByProjectIssueId(project.id, dep)) {
        throw new Error(`dependsOnIssueIds: no task with issue ${dep} in this project`);
      }
    }
    if (this.wouldCreateDependencyCycle(project.id, issueId, dependsOnIssueIds)) {
      throw new Error('dependsOnIssueIds would create a dependency cycle');
    }

    const id = crypto.randomUUID();
    const taskSession = this.deps.store.upsertTaskSession({
      id,
      projectId: project.id,
      sprintId: sprint.id,
      taskId: issueId,
      issueId,
      title: input.title,
      ...(dependsOnIssueIds.length ? { dependsOnIssueIds } : {}),
      workflowState: 'todo',
      runtime: 'claude',
      role: 'developer',
      sessionId: crypto.randomUUID(),
      workingDirectory: project.repository.localPath,
      messageQueueKey: createTaskQueueKey(issueId),
      approvalQueueKey: createApprovalQueueKey(issueId),
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
      `Created task ${issueId} in project ${project.name} (todo).`,
    );
    return taskSession;
  }

  /**
   * Assign work to a lane runner. Use `taskSessionId` + `kanbanAgent` to pick up a **todo** card
   * (queued `pending_start` until dependencies and FIFO allow **in_progress**);
   * otherwise legacy assign (existing non-todo rows keep immediate **in_progress**; new issues use create+queue).
   */
  async assignTask(input: AssignTaskInput): Promise<TaskSession> {
    if (input.taskSessionId) {
      return this.assignFromTodo(input);
    }

    const existingTodo = this.deps.store.getTaskSessionByProjectIssueId(input.projectId, input.issueId);
    if (existingTodo?.workflowState === 'todo') {
      throw new Error('Task exists in todo; assign with taskSessionId and kanbanAgent, or use assignFromTodo');
    }

    const existing = this.deps.store.getTaskSessionByProjectIssueId(input.projectId, input.issueId);
    if (!existing) {
      if (!input.title?.trim() || !input.runtime) {
        throw new Error('Legacy assignTask requires title and runtime');
      }
      const created = await this.createTask({
        projectId: input.projectId,
        sprintId: input.sprintId,
        issueId: input.issueId,
        title: input.title!,
        dependsOnIssueIds: input.dependsOnIssueIds,
      });
      return this.assignFromTodo({
        ...input,
        taskSessionId: created.id,
        kanbanAgent: input.kanbanAgent ?? 'agent-dev',
      });
    }

    if (existing.workflowState === 'pending_start') {
      throw new Error('Task is already queued for development; wait for dependencies or queue order');
    }

    if (!input.title?.trim() || !input.runtime) {
      throw new Error('Legacy assignTask requires title and runtime');
    }

    const project = this.requireProject(input.projectId);
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(input.sprintId);
    const role = input.role ?? 'developer';
    if (role !== 'developer') {
      throw new Error('Legacy assignTask supports developer role only');
    }

    const branchName = `${project.repository.taskBranchPrefix}${slugify(input.issueId)}`;
    const useWt = useKanbanWorktree();
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

    const priorSession = { kanbanAssignees: existing.kanbanAssignees } as TaskSession;
    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, 'agent-dev', priorSession, allTasks, {
      runtimeProfileId: input.runtimeProfileId,
      assigneeMemberId: input.assigneeMemberId,
      autoAssign: input.autoAssign,
    });
    const resolvedProfile = pickRuntimeProfile(
      project,
      'agent-dev',
      input.runtimeProfileId,
      runtimeProfileIdHint,
      existing?.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(priorSession, 'agent-dev', member?.id);
    const fromState = existing.workflowState;
    const taskDraft: TaskSession = {
      id: existing.id,
      projectId: project.id,
      sprintId: sprint.id,
      taskId: input.issueId,
      issueId: input.issueId,
      title: input.title!,
      workflowState: 'in_progress',
      runtime: input.runtime,
      runtimeProfileId: resolvedProfile,
      role,
      kanbanAgent: 'agent-dev',
      ...assignPatch,
      preferredSkills: preferredSkillsForProjectLane(project, 'agent-dev', 0),
      sessionId: existing.sessionId,
      providerSessionId: existing.providerSessionId,
      workingDirectory: workingDir,
      worktreePath,
      branchName,
      messageQueueKey: existing.messageQueueKey ?? createTaskQueueKey(input.issueId),
      approvalQueueKey: existing.approvalQueueKey ?? createApprovalQueueKey(input.issueId),
      conversationHistory: existing.conversationHistory ?? [],
      systemPrompt: existing.systemPrompt,
      lastError: undefined,
      createdAt: existing.createdAt ?? now(),
      updatedAt: now(),
    };
    await notifyWorkflowStateTransition({
      task: { ...taskDraft, workflowState: fromState },
      from: fromState,
      to: 'in_progress',
      outgoingRole: null,
      actionLabel: '分配开发（legacy）',
    });
    const taskSession = this.deps.store.upsertTaskSession({
      ...taskDraft,
      historyComments: [
        ...(existing.historyComments ?? []),
        buildTransitionHistoryComment(
          { ...taskDraft, workflowState: fromState },
          fromState,
          'in_progress',
          null,
          '分配开发（legacy）',
        ),
      ],
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
    this.enqueueKickoffPrompt(this.requireTaskSession(taskSession.id));
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
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(taskSession.sprintId);
    const kind: KanbanAgentKind = input.kanbanAgent ?? 'agent-dev';
    if (kind !== 'agent-dev' && kind !== 'codex-senior') {
      throw new Error('assignFromTodo only supports kanbanAgent agent-dev or codex-senior');
    }
    const rejectionCount = taskSession.reviewRejectionCount ?? 0;
    const resolved = resolveKanbanAgent(kind, rejectionCount);

    const handoff = input.handoffComment ?? taskSession.handoffComment;

    const laneKind = resolved.kanbanAgent;
    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, laneKind, taskSession, allTasks, {
      runtimeProfileId: input.runtimeProfileId,
      assigneeMemberId: input.assigneeMemberId,
      autoAssign: input.autoAssign,
    });
    const resolvedProfile = pickRuntimeProfile(
      project,
      laneKind,
      input.runtimeProfileId,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, laneKind, member?.id);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'todo',
      to: 'pending_start',
      outgoingRole: null,
      actionLabel: '从待办分配（排队）',
    });

    const next = this.deps.store.upsertTaskSession({
      ...taskSession,
      title: input.title || taskSession.title,
      workflowState: 'pending_start',
      runtime: resolved.runtime,
      role: resolved.role,
      kanbanAgent: resolved.kanbanAgent,
      preferredSkills: preferredSkillsForProjectLane(project, kind, rejectionCount),
      handoffComment: handoff,
      runtimeProfileId: resolvedProfile,
      workingDirectory: project.repository.localPath,
      ...assignPatch,
      updatedAt: now(),
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(taskSession, 'todo', 'pending_start', null, '从待办分配（排队）'),
      ],
    });

    this.enqueuePendingAssignmentSprint(sprint, next.id);

    if (handoff?.trim()) {
      await this.appendWorkflowComment(
        next.id,
        `Handoff (read before running): ${handoff.trim()}`,
      );
    }
    await this.appendWorkflowComment(next.id, `Queued for development (${formatKanbanRunnerSummary(next)}).`);

    await this.processDeveloperAssignmentQueue(sprint.id);
    return this.requireTaskSession(next.id);
  }

  async rejectReview(taskSessionId: string, comment: string, deferStopInstanceId?: string): Promise<TaskSession> {
    return this.transitionReviewToDevelopment(taskSessionId, deferStopInstanceId, 'reject', comment);
  }

  /**
   * Move from **review** → **in_progress** with developer runner (same as `rejectReview`, but labels and
   * workflow log differ when merge is blocked by SCM instead of reviewer feedback).
   */
  private async transitionReviewToDevelopment(
    taskSessionId: string,
    deferStopInstanceId: string | undefined,
    reason: 'reject' | 'merge_conflict',
    comment: string,
  ): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'in_progress');
    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);
    const nextCount = (taskSession.reviewRejectionCount ?? 0) + 1;
    const project = this.requireProject(taskSession.projectId);
    const resolved = resolveKanbanAgent('agent-dev', nextCount);
    const allTasks = this.projectTasks(project.id);
    const laneKind = resolved.kanbanAgent;
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, laneKind, taskSession, allTasks, {});
    const resolvedProfile = pickRuntimeProfile(
      project,
      laneKind,
      undefined,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, laneKind, member?.id);
    const commentWithPrContext = taskSession.pullRequestUrl?.trim()
      ? `${comment}\nPR URL: ${taskSession.pullRequestUrl.trim()}`
      : comment;

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'review',
      to: 'in_progress',
      outgoingRole: 'reviewer',
      actionLabel: reason === 'merge_conflict' ? '合并阻塞：解决冲突' : '打回开发',
    });

    const updated = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'in_progress',
      reviewRejectionCount: nextCount,
      runtime: resolved.runtime,
      kanbanAgent: resolved.kanbanAgent,
      preferredSkills: preferredSkillsForProjectLane(project, 'agent-dev', nextCount),
      handoffComment: commentWithPrContext,
      runtimeProfileId: resolvedProfile,
      ...assignPatch,
      updatedAt: now(),
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(
          taskSession,
          'review',
          'in_progress',
          'reviewer',
          reason === 'merge_conflict' ? '合并阻塞：解决冲突' : '打回开发',
        ),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(updated, 'developer'));
    this.enqueueKickoffPrompt(this.requireTaskSession(updated.id));

    const logLine =
      reason === 'merge_conflict'
        ? `Merge blocked (not mergeable). Round ${nextCount}. Assigned developer to resolve conflicts on the task branch, push, then re-run feature test → submit for review. Escalation: ${formatKanbanRunnerSummary(updated)}. Detail: ${commentWithPrContext}`
        : `Review rejected (round ${nextCount}). Escalation: ${formatKanbanRunnerSummary(updated)}. Comment: ${commentWithPrContext}`;
    await this.appendWorkflowComment(updated.id, logLine);
    return updated;
  }

  async submitTaskForReview(input: SubmitTaskForReviewInput): Promise<{ taskSession: TaskSession; pullRequest: PullRequestRef }> {
    const taskSession = this.requireTaskSession(input.taskSessionId);
    this.assertTransition(taskSession.workflowState, 'review');
    await this.stopInstancesForTask(taskSession.id, input.deferStopInstanceId);

    const project = this.requireProject(taskSession.projectId);
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(taskSession.sprintId);
    const repoPath = taskSession.worktreePath ?? project.repository.localPath;

    await this.deps.gitService.commitAll({
      repoPath,
      message: input.commitMessage,
    });

    // Always push before opening the PR: GitHub needs `head` on origin. If we only pushed when
    // `committed` was true, a no-op commit attempt could skip push and cause API 404 / missing head.
    await this.deps.gitService.pushBranch(repoPath, taskSession.branchName!);

    const ensured = await this.ensureOpenReviewPullRequest(taskSession, input.prTitle, input.prBody);
    const pullRequest = ensured.pullRequest;
    const reviewTaskSession = ensured.taskSession;
    let reviewMergeabilityNote = 'Host PR mergeability unavailable.';
    if (pullRequest.number != null) {
      try {
        const mergeStatus = await this.deps.scmClient.getPullRequestMergeStatus(project, pullRequest.number);
        reviewMergeabilityNote = mergeStatus.canMerge
          ? `Host PR status: merge-ready (PR #${pullRequest.number}).`
          : `Host PR status: not merge-ready yet (PR #${pullRequest.number}) — ${mergeStatus.reason ?? 'host reported blocked merge state'}.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reviewMergeabilityNote = `Host PR status unavailable for PR #${pullRequest.number}: ${msg.slice(0, 300)}`;
      }
    }

    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, 'claude-review', reviewTaskSession, allTasks, {});
    const reviewerProfile = pickRuntimeProfile(
      project,
      'claude-review',
      undefined,
      runtimeProfileIdHint,
      reviewTaskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(reviewTaskSession, 'claude-review', member?.id);

    await notifyWorkflowStateTransition({
      task: reviewTaskSession,
      from: 'testing',
      to: 'review',
      outgoingRole: 'tester',
      actionLabel: '提交评审（创建 PR）',
    });

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...reviewTaskSession,
      workflowState: 'review',
      pullRequestUrl: pullRequest.url,
      pullRequestNumber: pullRequest.number,
      preferredSkills: preferredSkillsForProjectLane(project, 'claude-review', 0),
      kanbanAgent: 'claude-review',
      runtimeProfileId: reviewerProfile,
      ...assignPatch,
      historyComments: [
        ...(reviewTaskSession.historyComments ?? []),
        buildTransitionHistoryComment(reviewTaskSession, 'testing', 'review', 'tester', '提交评审（创建 PR）'),
      ],
    });

    await this.appendWorkflowComment(updatedTaskSession.id, `Created/reused PR ${pullRequest.url} and started reviewer.`);
    await this.appendWorkflowComment(updatedTaskSession.id, reviewMergeabilityNote);

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(this.requireTaskSession(updatedTaskSession.id), 'reviewer'),
    );
    this.enqueueKickoffPrompt(this.requireTaskSession(updatedTaskSession.id));

    return { taskSession: this.requireTaskSession(updatedTaskSession.id), pullRequest };
  }

  private async ensureOpenReviewPullRequest(taskSession: TaskSession, title?: string, body?: string): Promise<{
    taskSession: TaskSession;
    pullRequest: PullRequestRef;
  }> {
    if (taskSession.pullRequestNumber != null && taskSession.pullRequestUrl?.trim()) {
      return {
        taskSession,
        pullRequest: {
          url: taskSession.pullRequestUrl,
          ...(taskSession.pullRequestNumber !== undefined ? { number: taskSession.pullRequestNumber } : {}),
        },
      };
    }

    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);
    const sourceBranch = taskSession.branchName;
    if (!sourceBranch) {
      throw new Error('branchName missing — cannot find or create review PR');
    }

    const existing = await this.deps.scmClient.findOpenPullRequest({
      project,
      sourceBranch,
      targetBranch: sprint.branchName,
    });
    if (existing) {
      await this.appendWorkflowComment(
        taskSession.id,
        `Review PR already exists (${existing.url}); reusing it for mergeability checks.`,
      );
      const updated = this.deps.store.upsertTaskSession({
        ...taskSession,
        pullRequestUrl: existing.url,
        ...(existing.number !== undefined ? { pullRequestNumber: existing.number } : {}),
      });
      return { taskSession: updated, pullRequest: existing };
    }
    let pullRequest: PullRequestRef;
    try {
      pullRequest = await this.deps.scmClient.createPullRequest({
        project,
        title: title ?? `[${taskSession.issueId}] ${taskSession.title}`,
        body:
          body ??
          [
            `Kanban issue: **${taskSession.issueId}**`,
            '',
            taskSession.title,
          ].join('\n'),
        sourceBranch,
        targetBranch: sprint.branchName,
      });
    } catch (e) {
      const retryExisting = await this.deps.scmClient.findOpenPullRequest({
        project,
        sourceBranch,
        targetBranch: sprint.branchName,
      });
      if (!retryExisting) throw e;
      pullRequest = retryExisting;
    }
    await this.appendWorkflowComment(
      taskSession.id,
      `Review PR was missing; created/reused PR ${pullRequest.url} before mergeability check.`,
    );
    const updated = this.deps.store.upsertTaskSession({
      ...taskSession,
      pullRequestUrl: pullRequest.url,
      ...(pullRequest.number !== undefined ? { pullRequestNumber: pullRequest.number } : {}),
    });
    return { taskSession: updated, pullRequest };
  }

  private async syncHostMergeBlockedComment(taskSession: TaskSession, detail: string): Promise<void> {
    const text = [
      'Host PR check failed after review approval attempt.',
      `Reason: ${detail}`,
      'Returned to development: update the task branch, resolve conflicts or host gating issues, push, then resubmit for review.',
    ].join(' ');
    if (taskSession.pullRequestNumber != null) {
      try {
        await this.syncReviewCommentToPrAndTask(taskSession.id, text);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.appendWorkflowComment(
          taskSession.id,
          `Could not sync merge-blocked review comment to PR #${taskSession.pullRequestNumber}: ${msg.slice(0, 400)}`,
        );
      }
    }
    await this.appendWorkflowComment(taskSession.id, `Review (merge blocked): ${text}`);
  }

  async startTesting(taskSessionId: string, deferStopInstanceId?: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'pre_testing');
    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    const project = this.requireProject(taskSession.projectId);
    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, 'pre-tester', taskSession, allTasks, {});
    const testerProfile = pickRuntimeProfile(
      project,
      'pre-tester',
      undefined,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, 'pre-tester', member?.id);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'in_progress',
      to: 'pre_testing',
      outgoingRole: 'developer',
      actionLabel: '进入前置测试',
    });

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'pre_testing',
      preferredSkills: preferredSkillsForProjectLane(project, 'pre-tester', 0),
      kanbanAgent: 'pre-tester',
      handoffComment:
        taskSession.handoffComment ??
        'Pre-test check: verify required environment variables, credentials, local services, and task prerequisites. If anything is missing, list missing items and require manual hookup without editing code.',
      runtimeProfileId: testerProfile,
      ...assignPatch,
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(taskSession, 'in_progress', 'pre_testing', 'developer', '进入前置测试'),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );
    this.enqueueKickoffPrompt(this.requireTaskSession(updatedTaskSession.id));

    await this.appendWorkflowComment(updatedTaskSession.id, 'Started pre-tester for prerequisite and environment validation.');

    return updatedTaskSession;
  }

  async startFeatureTesting(taskSessionId: string, deferStopInstanceId?: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'testing');
    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    const project = this.requireProject(taskSession.projectId);
    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, 'copilot-test', taskSession, allTasks, {});
    const testerProfile = pickRuntimeProfile(
      project,
      'copilot-test',
      undefined,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, 'copilot-test', member?.id);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'pre_testing',
      to: 'testing',
      outgoingRole: 'tester',
      actionLabel: '进入功能测试',
    });

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'testing',
      preferredSkills: preferredSkillsForProjectLane(project, 'copilot-test', 0),
      kanbanAgent: 'copilot-test',
      handoffComment:
        taskSession.handoffComment ??
        'Feature testing: run focused tests on the task branch only; defer merge conflict resolution.',
      runtimeProfileId: testerProfile,
      ...assignPatch,
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(taskSession, 'pre_testing', 'testing', 'tester', '进入功能测试'),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );
    this.enqueueKickoffPrompt(this.requireTaskSession(updatedTaskSession.id));

    await this.appendWorkflowComment(updatedTaskSession.id, 'Started feature tester (branch scope).');

    return updatedTaskSession;
  }

  /**
   * Merge the open PR/MR, then start regression testing on the merge-target branch in the main repo clone.
   * Call from **review** (reviewer `KANBAN_ACTION:APPROVE_MERGE`) or POST `/start-regression` when state is review.
   */
  async mergeApprovedPullRequestAndStartRegression(
    taskSessionId: string,
    deferStopInstanceId?: string,
  ): Promise<TaskSession> {
    let taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'regression_testing');

    const ensured = await this.ensureOpenReviewPullRequest(taskSession);
    taskSession = ensured.taskSession;
    if (taskSession.pullRequestNumber == null) {
      throw new Error('Missing pullRequestNumber — could not find or create review PR.');
    }

    const project = this.requireProject(taskSession.projectId);
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(taskSession.sprintId);
    const repoPath = project.repository.localPath;
    const mergeTarget = sprint.branchName;

    const mergeStatus = await this.deps.scmClient.getPullRequestMergeStatus(
      project,
      taskSession.pullRequestNumber,
    );
    getKanbanLogger().info(
      {
        taskSessionId: taskSession.id,
        issueId: taskSession.issueId,
        pullRequestNumber: taskSession.pullRequestNumber,
        canMerge: mergeStatus.canMerge,
        terminalState: mergeStatus.terminalState,
        reason: mergeStatus.reason,
      },
      'review merge-status fetched before regression transition',
    );
    if (!mergeStatus.canMerge) {
      const why = mergeStatus.reason ?? 'PR/MR is not mergeable';
      if (mergeStatus.terminalState === 'merged') {
        await this.appendWorkflowComment(
          taskSession.id,
          `Host PR #${taskSession.pullRequestNumber} is already merged on the host; continuing directly to regression startup.`,
        );
        getKanbanLogger().info(
          {
            taskSessionId: taskSession.id,
            issueId: taskSession.issueId,
            pullRequestNumber: taskSession.pullRequestNumber,
          },
          'review merge-status indicates PR already merged; skipping merge API and continuing to regression',
        );
      } else if (mergeStatus.terminalState === 'closed') {
        await this.syncHostMergeBlockedComment(
          taskSession,
          `PR #${taskSession.pullRequestNumber} is already closed on the host and cannot be merged from workflow`,
        );
        getKanbanLogger().warn(
          {
            taskSessionId: taskSession.id,
            issueId: taskSession.issueId,
            pullRequestNumber: taskSession.pullRequestNumber,
          },
          'review merge-status indicates PR already closed; returning task to development',
        );
        return this.transitionReviewToDevelopment(
          taskSession.id,
          deferStopInstanceId,
          'merge_conflict',
          `PR #${taskSession.pullRequestNumber} is already closed on the host and cannot be merged from workflow`,
        );
      } else if (isTransientHostMergeabilityReason(why)) {
        getKanbanLogger().info(
          {
            taskSessionId: taskSession.id,
            issueId: taskSession.issueId,
            pullRequestNumber: taskSession.pullRequestNumber,
            reason: why,
          },
          'review merge-status still computing; leaving task in review',
        );
        await this.appendWorkflowComment(
          taskSession.id,
          `Host PR status: not merge-ready yet (PR #${taskSession.pullRequestNumber}) — ${why}`,
        );
        return taskSession;
      } else {
        getKanbanLogger().warn(
          {
            taskSessionId: taskSession.id,
            issueId: taskSession.issueId,
            pullRequestNumber: taskSession.pullRequestNumber,
            reason: why,
          },
          'review merge-status blocked; returning task to development',
        );
        await this.syncHostMergeBlockedComment(
          taskSession,
          `PR #${taskSession.pullRequestNumber} is not ready to merge: ${why}`,
        );
        return this.transitionReviewToDevelopment(
          taskSession.id,
          deferStopInstanceId,
          'merge_conflict',
          `PR #${taskSession.pullRequestNumber} is not ready to merge: ${why}`,
        );
      }
    }

    if (mergeStatus.terminalState !== 'merged') {
      try {
        await this.deps.scmClient.mergePullRequest(project, taskSession.pullRequestNumber);
      } catch (e) {
        if (isScmMergeNotMergeableError(project, e)) {
          const detail = e instanceof Error ? e.message : String(e);
          await this.syncHostMergeBlockedComment(
            taskSession,
            `Merge API failed because PR became not mergeable: ${detail.slice(0, 600)}`,
          );
          void notifyKanbanTelegram(
            `[Kanban][${taskSession.issueId}] merge API failed (not mergeable); returning task to development for conflict or host-gate resolution.`,
          );
          getKanbanLogger().warn(
            { taskId: taskSession.id, issueId: taskSession.issueId, pullRequestNumber: taskSession.pullRequestNumber },
            'merge: API reported not mergeable after pre-check; returning task to development',
          );
          return this.transitionReviewToDevelopment(
            taskSession.id,
            deferStopInstanceId,
            'merge_conflict',
            `Merge failed (PR not mergeable): ${detail.slice(0, 400)}`,
          );
        }
        throw e;
      }
    }

    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    const taskWorktreePath = taskSession.worktreePath?.trim();
    if (taskWorktreePath) {
      try {
        await this.deps.gitService.removeTaskWorktree(repoPath, taskWorktreePath);
        taskSession = this.deps.store.upsertTaskSession({
          ...taskSession,
          workingDirectory: repoPath,
          worktreePath: undefined,
          updatedAt: now(),
        });
        await this.appendWorkflowComment(
          taskSession.id,
          `Removed local task worktree at ${taskWorktreePath} after PR merge.`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        getKanbanLogger().warn(
          { err: e, taskSessionId: taskSession.id, worktreePath: taskWorktreePath },
          'removeTaskWorktree after merge failed',
        );
        await this.appendWorkflowComment(
          taskSession.id,
          `Could not remove task worktree at ${taskWorktreePath} after PR merge (cleanup manually). ${msg.slice(0, 400)}`,
        );
      }
    }

    try {
      await this.deps.gitService.fetchOrigin(repoPath);
      const checkoutResult = await this.deps.gitService.checkoutOriginTrackingBranch(repoPath, mergeTarget);
      if (checkoutResult.discardedEntries.length > 0) {
        const dirtyList = checkoutResult.discardedEntries.map((entry) => `- ${entry.raw}`).join('\n');
        await this.appendWorkflowComment(
          taskSession.id,
          [
            `Regression startup reset sprint branch "${mergeTarget}" in ${repoPath} to origin/${mergeTarget} and discarded local changes from the workflow-owned main clone.`,
            'Discarded files:',
            dirtyList,
          ].join('\n'),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendWorkflowComment(
        taskSession.id,
        `Regression startup blocked: could not refresh sprint branch "${mergeTarget}" in ${repoPath}. ${msg.slice(0, 1200)}`,
      );
      throw e;
    }

    const remoteRef = `origin/${mergeTarget}`;
    const baselineSha = await this.deps.gitService.resolveRefSha(repoPath, remoteRef);

    const allTasks = this.projectTasks(project.id);
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, 'copilot-test', taskSession, allTasks, {});
    const testerProfile = pickRuntimeProfile(
      project,
      'copilot-test',
      undefined,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, 'copilot-test', member?.id);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'review',
      to: 'regression_testing',
      outgoingRole: 'reviewer',
      actionLabel: '合并 PR 并进入回归测试',
    });

    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'regression_testing',
      regressionMasterSha: baselineSha,
      workingDirectory: repoPath,
      worktreePath: undefined,
      branchName: mergeTarget,
      preferredSkills: [
        ...preferredSkillsForProjectLane(project, 'copilot-test', 0),
        'Final regression: you are on the main repo clone with branch matching the PR merge target (sprint/integration). Pull latest before suites; if origin moved, re-fetch and re-run.',
      ],
      handoffComment:
        taskSession.handoffComment ??
        `Regression phase: run full suites on local branch "${mergeTarget}" (merge target after PR). Compare new commits with regressionMasterSha when checking for drift.`,
      runtimeProfileId: testerProfile,
      ...assignPatch,
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(taskSession, 'review', 'regression_testing', 'reviewer', '合并 PR 并进入回归测试'),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(
      this.buildAgentInstance(updatedTaskSession, 'tester'),
    );
    this.enqueueKickoffPrompt(this.requireTaskSession(updatedTaskSession.id));

    await this.appendWorkflowComment(
      updatedTaskSession.id,
      `Merged PR #${taskSession.pullRequestNumber}; regression baseline ${mergeTarget} @ ${baselineSha.slice(0, 7)} (main repo checkout).`,
    );

    return updatedTaskSession;
  }

  /** @deprecated Prefer merge from review via APPROVE_MERGE. Kept for API: merges PR then starts regression when in **review**. */
  async startRegressionTesting(taskSessionId: string, deferStopInstanceId?: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    if (taskSession.workflowState !== 'review') {
      throw new Error('startRegressionTesting: task must be in review (open PR) to merge and start regression');
    }
    return this.mergeApprovedPullRequestAndStartRegression(taskSessionId, deferStopInstanceId);
  }

  private async returnTestingToDevelopment(
    taskSessionId: string,
    comment: string,
    deferStopInstanceId?: string,
  ): Promise<void> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'in_progress');
    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    const project = this.requireProject(taskSession.projectId);
    const resolved = resolveKanbanAgent('agent-dev', taskSession.reviewRejectionCount ?? 0);
    const allTasks = this.projectTasks(project.id);
    const laneKind = resolved.kanbanAgent;
    const { member, runtimeProfileIdHint } = resolveKanbanAssignment(project, laneKind, taskSession, allTasks, {});
    const resolvedProfile = pickRuntimeProfile(
      project,
      laneKind,
      undefined,
      runtimeProfileIdHint,
      taskSession.runtimeProfileId,
    );
    const assignPatch = mergeKanbanAssignee(taskSession, laneKind, member?.id);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: taskSession.workflowState,
      to: 'in_progress',
      outgoingRole: 'tester',
      actionLabel: taskSession.workflowState === 'regression_testing' ? '回归测试未通过，退回开发' : '功能测试未通过，退回开发',
    });

    const updated = this.deps.store.upsertTaskSession({
      ...taskSession,
      workflowState: 'in_progress',
      runtime: resolved.runtime,
      kanbanAgent: resolved.kanbanAgent,
      preferredSkills: preferredSkillsForProjectLane(project, 'agent-dev', taskSession.reviewRejectionCount ?? 0),
      handoffComment: comment,
      runtimeProfileId: resolvedProfile,
      ...assignPatch,
      updatedAt: now(),
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(
          taskSession,
          taskSession.workflowState,
          'in_progress',
          'tester',
          taskSession.workflowState === 'regression_testing' ? '回归测试未通过，退回开发' : '功能测试未通过，退回开发',
        ),
      ],
    });

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(updated, 'developer'));
    this.enqueueKickoffPrompt(this.requireTaskSession(updated.id));
    await this.appendWorkflowComment(
      updated.id,
      `${taskSession.workflowState === 'regression_testing' ? 'Returned from regression testing' : 'Returned from feature testing'} to development: ${comment}`,
    );
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
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(taskSession.sprintId);
    const repoPath = project.repository.localPath;
    const trackBranch = taskSession.branchName ?? sprint.branchName;
    const remoteRef = `origin/${trackBranch}`;

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
        `Regression check: ${trackBranch} unchanged (${currentSha.slice(0, 7)}).`,
      );
      return this.requireTaskSession(taskSessionId);
    }

    const next = this.deps.store.upsertTaskSession({
      ...taskSession,
      regressionMasterSha: currentSha,
      handoffComment: [
        `集成分支 ${trackBranch} 在 origin 上已前进（${baseline.slice(0, 7)} → ${currentSha.slice(0, 7)}）。`,
        '请拉取最新代码后重新执行全量回归测试；勿在过时检出上继续补测。',
      ].join(' '),
    });

    await this.appendWorkflowComment(
      taskSessionId,
      `origin/${trackBranch} 有新提交；已更新回归基线。请拉取 ${trackBranch} @ ${currentSha.slice(0, 7)} 后重新跑回归。`,
    );

    await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(next, 'tester'));
    this.enqueueKickoffPrompt(this.requireTaskSession(next.id));
    return next;
  }

  /**
   * Post a comment on the open PR/MR and append the same text as a workflow line on the task (Kanban “issue” comment).
   */
  async syncReviewCommentToPrAndTask(taskSessionId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text) throw new Error('body is required');
    const taskSession = this.requireTaskSession(taskSessionId);
    if (taskSession.workflowState !== 'review') {
      throw new Error('syncReviewCommentToPrAndTask requires workflowState=review');
    }
    const n = taskSession.pullRequestNumber;
    if (n == null) {
      throw new Error('pullRequestNumber missing — submit review (create PR) first');
    }
    const project = this.requireProject(taskSession.projectId);
    await this.deps.scmClient.postPullRequestDiscussionComment(project, n, text);
    await this.appendWorkflowComment(taskSessionId, `Review (synced to PR #${n}):\n${text}`);
  }

  /**
   * Before closing from regression: ensure an open PR exists from sprint merge target → repository base (e.g. master).
   * Only creates the PR; humans merge. Skips if merge target equals base or an open PR already exists.
   */
  private async ensureReleasePullRequestMergeTargetToBase(taskSession: TaskSession): Promise<Partial<TaskSession>> {
    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);
    const mergeTarget = sprint.branchName;
    const baseBranch = project.repository.baseBranch;

    if (mergeTarget === baseBranch) {
      await this.appendWorkflowComment(
        taskSession.id,
        `Release PR: merge target branch is the same as the repo base (\`${baseBranch}\`); no separate PR to open.`,
      );
      return {};
    }

    const existing = await this.deps.scmClient.findOpenPullRequest({
      project,
      sourceBranch: mergeTarget,
      targetBranch: baseBranch,
    });

    if (existing?.url) {
      await this.appendWorkflowComment(
        taskSession.id,
        `Release PR: open PR already exists (${existing.url}). Merge manually to integrate \`${mergeTarget}\` into \`${baseBranch}\`.`,
      );
      return {
        releasePullRequestUrl: existing.url,
        ...(existing.number !== undefined ? { releasePullRequestNumber: existing.number } : {}),
      };
    }

    const title = `[${taskSession.issueId}] Merge ${mergeTarget} → ${baseBranch}`;
    const body = [
      `Kanban: regression passed for **${taskSession.issueId}** (${taskSession.title}).`,
      '',
      `Merge **${mergeTarget}** into **${baseBranch}** to ship integration. Opened automatically; merge manually when ready.`,
    ].join('\n');

    try {
      const pr = await this.deps.scmClient.createPullRequest({
        project,
        title,
        body,
        sourceBranch: mergeTarget,
        targetBranch: baseBranch,
      });
      await this.appendWorkflowComment(
        taskSession.id,
        `Release PR created: ${pr.url} — merge \`${mergeTarget}\` into \`${baseBranch}\` (human merge).`,
      );
      return {
        releasePullRequestUrl: pr.url,
        ...(pr.number !== undefined ? { releasePullRequestNumber: pr.number } : {}),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('422') || /no commits between|nothing to merge|already merged|identical/i.test(msg)) {
        await this.appendWorkflowComment(
          taskSession.id,
          `Release PR: skipped (${msg.slice(0, 200)}). No new PR needed or branches already aligned.`,
        );
        return {};
      }
      throw e;
    }
  }

  /**
   * After regression passes: move to **pending_release** (human-only). Ensures sprint/integration → base
   * release PR (create or reuse), posts instructions on that PR, then stops — **no** agent runner.
   */
  async proceedToPendingRelease(taskSessionId: string, deferStopInstanceId?: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'pending_release');
    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    const project = this.requireProject(taskSession.projectId);
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(taskSession.sprintId);
    const mergeTarget = sprint.branchName;
    const baseBranch = project.repository.baseBranch;

    const releasePatch = await this.ensureReleasePullRequestMergeTargetToBase(taskSession);

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: 'regression_testing',
      to: 'pending_release',
      outgoingRole: 'tester',
      actionLabel: '回归通过，进入合并主干',
    });

    const updated = this.deps.store.upsertTaskSession({
      ...taskSession,
      ...releasePatch,
      workflowState: 'pending_release',
      branchName: mergeTarget,
      workingDirectory: project.repository.localPath,
      preferredSkills: [
        'This column has no automated agent. Merge the release PR on the SCM host, then close the card via POST /api/workflows/tasks/:taskSessionId/close.',
      ],
      handoffComment: `Human: merge \`${mergeTarget}\` → \`${baseBranch}\` using the release PR (see task fields). When done, call the Kanban **close** API.`,
      historyComments: [
        ...(taskSession.historyComments ?? []),
        buildTransitionHistoryComment(
          taskSession,
          'regression_testing',
          'pending_release',
          'tester',
          '回归通过，进入合并主干',
        ),
      ],
    });

    await this.postPendingReleaseInstructionsOnReleasePr(project, updated, mergeTarget, baseBranch);

    await this.appendWorkflowComment(
      updated.id,
      `**pending_release** (no runner): release PR ensured; instructions posted on the PR when applicable. Merge on the host, then close this task via the API.`,
    );

    await this.processDeveloperAssignmentQueue(sprint.id);
    return updated;
  }

  private async postPendingReleaseInstructionsOnReleasePr(
    project: Project,
    taskSession: TaskSession,
    mergeTarget: string,
    baseBranch: string,
  ): Promise<void> {
    const n = taskSession.releasePullRequestNumber;
    if (n == null || mergeTarget === baseBranch) return;

    const body = [
      `**Kanban — ${taskSession.issueId}** · _pending release_`,
      '',
      `This task is waiting for **\`${mergeTarget}\` → \`${baseBranch}\`** to land (release/integration merge).`,
      'Automation has opened or linked this PR; **please merge on the host when ready**, then **close the Kanban card** from your dashboard (or `POST /api/workflows/tasks/<id>/close`).',
      '',
      `**Task:** ${taskSession.title}`,
    ].join('\n');

    try {
      await this.deps.scmClient.postPullRequestDiscussionComment(project, n, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      getKanbanLogger().warn({ err: e, taskSessionId: taskSession.id, pr: n }, 'postPendingReleaseInstructionsOnReleasePr failed');
      await this.appendWorkflowComment(
        taskSession.id,
        `Could not post pending-release instructions on PR #${n}: ${msg.slice(0, 400)}`,
      );
    }
  }

  async closeTask(taskSessionId: string, deferStopInstanceId?: string): Promise<TaskSession> {
    const taskSession = this.requireTaskSession(taskSessionId);
    this.assertTransition(taskSession.workflowState, 'closed');

    let releasePatch: Partial<TaskSession> = {};
    if (taskSession.workflowState === 'pending_release') {
      if (!taskSession.releasePullRequestUrl?.trim() && taskSession.releasePullRequestNumber == null) {
        releasePatch = await this.ensureReleasePullRequestMergeTargetToBase(taskSession);
      }
    }

    await notifyWorkflowStateTransition({
      task: taskSession,
      from: taskSession.workflowState,
      to: 'closed',
      outgoingRole: 'tester',
      actionLabel: '标记完成',
    });

    const { kanbanAssignees: _omitAssignees, ...taskRest } = taskSession;
    const historyEntry = buildTransitionHistoryComment(
      taskSession,
      taskSession.workflowState,
      'closed',
      'tester',
      '标记完成',
    );
    const updatedTaskSession = this.deps.store.upsertTaskSession({
      ...taskRest,
      ...releasePatch,
      workflowState: 'closed',
      historyComments: [...(taskSession.historyComments ?? []), historyEntry],
    });

    await this.stopInstancesForTask(taskSession.id, deferStopInstanceId);

    await this.appendWorkflowComment(updatedTaskSession.id, 'Task closed.');
    await this.processDeveloperAssignmentQueue(taskSession.sprintId);
    return updatedTaskSession;
  }

  /**
   * Permanently remove task data (instances, queues, approvals, monitor rows).
   * Stops all agent runners / LLM providers for this task the same way as `closeTask` (no defer).
   */
  async deleteTask(taskSessionId: string): Promise<void> {
    const task = this.requireTaskSession(taskSessionId);
    await this.stopInstancesForTask(taskSessionId);
    const sprint = this.requireSprint(task.sprintId);
    const q = sprint.pendingDeveloperAssignmentQueue?.filter((id) => id !== taskSessionId);
    if (q && q.length !== (sprint.pendingDeveloperAssignmentQueue?.length ?? 0)) {
      this.deps.store.upsertSprint({
        ...sprint,
        pendingDeveloperAssignmentQueue: q,
        updatedAt: now(),
      });
    }
    this.deps.store.removeTaskSession(taskSessionId);
    await this.processDeveloperAssignmentQueue(sprint.id);
  }

  /**
   * After process restart: apply pending `KANBAN_ACTION` lines (regression → PROCEED_TO_RELEASE,
   * pending_release → CLOSE); ensure an agent instance exists for every non-todo/non-closed task;
   * if the task queue is empty, enqueue a resume or kickoff so runners continue. Ends with
   * `instanceManager.reconcile()`.
   */
  async resumeKanbanAfterRestart(): Promise<void> {
    const sprints = this.deps.store.listSprints();
    for (const sp of sprints) {
      await this.processDeveloperAssignmentQueue(sp.id);
    }

    const tasks = this.deps.store.listTaskSessions();
    for (const rawTask of tasks) {
      const task = this.normalizeTaskWorkingCopy(rawTask);
      if (task.workflowState === 'todo' || task.workflowState === 'pending_start' || task.workflowState === 'closed')
        continue;

      if (task.workflowState === 'regression_testing') {
        const last = lastAssistantContentForRole(task, 'tester');
        if (last) {
          const parsed = parseKanbanAction(last);
          if (parsed?.action === 'PROCEED_TO_RELEASE' || parsed?.action === 'CLOSE') {
            try {
              await this.proceedToPendingRelease(task.id);
            } catch (e) {
              getKanbanLogger().warn({ err: e, taskId: task.id }, 'resumeKanbanAfterRestart: proceedToPendingRelease failed');
            }
            continue;
          }
        }
      }

      if (task.workflowState === 'pending_release') {
        const last = lastAssistantContentForRole(task, 'tester');
        if (last) {
          const parsed = parseKanbanAction(last);
          if (parsed?.action === 'CLOSE') {
            try {
              await this.closeTask(task.id);
            } catch (e) {
              getKanbanLogger().warn({ err: e, taskId: task.id }, 'resumeKanbanAfterRestart: closeTask failed');
            }
            continue;
          }
        }
      }

      const role = roleForActiveWorkflowState(task.workflowState);
      if (!role) continue;

      let inst = this.deps.store.findAgentInstance(task.id, role);
      if (!inst) {
        await this.deps.instanceManager.upsertAndStart(this.buildAgentInstance(task, role));
      } else if (inst.status === 'stopped' || inst.status === 'error') {
        this.deps.store.upsertAgentInstance({
          ...inst,
          status: 'starting',
          lastError: undefined,
          workingDirectory: task.workingDirectory,
          updatedAt: now(),
        });
      }

      const t = this.requireTaskSession(task.id);
      const q = this.deps.store.peekTaskQueue(t.messageQueueKey);
      if (q.length === 0) {
        if (t.conversationHistory.length > 0) {
          this.enqueueResumeAfterRestartPrompt(t);
        } else {
          this.enqueueKickoffPrompt(t);
        }
      }
    }

    await this.deps.instanceManager.reconcile();
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

  async ensureAgentInstance(
    taskSessionId: string,
    role: AgentRole,
    runtimeProfileId?: string,
  ): Promise<AgentInstanceRecord> {
    const taskSession = this.normalizeTaskWorkingCopy(this.requireTaskSession(taskSessionId));
    const instance = this.buildAgentInstance(taskSession, role);
    const out = await this.deps.instanceManager.upsertAndStart({
      ...instance,
      ...(runtimeProfileId !== undefined ? { runtimeProfileId } : {}),
    });
    this.enqueueKickoffPrompt(this.requireTaskSession(taskSessionId));
    return out;
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
      pending_start: 0,
      in_progress: 0,
      pre_testing: 0,
      review: 0,
      testing: 0,
      regression_testing: 0,
      pending_release: 0,
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

  /**
   * Uses the **codex-senior** (高级开发) runner to turn pasted text into a task plan with dependencies.
   */
  async previewBatchTasksFromSpec(input: unknown): Promise<{ tasks: BatchTaskPlanItem[] }> {
    const { projectId, sprintId, rawText } = parsePreviewBatchSpecBody(input);
    const project = this.requireProject(projectId);
    this.assertProjectLocalRepositoryPath(project);
    const sprint = this.requireSprint(sprintId);
    if (sprint.projectId !== project.id) {
      throw new Error('Sprint does not belong to the selected project');
    }
    const config = loadConfig();
    const runner = pickRunnerForCodexSenior(project, config);
    if (!runner) {
      throw new Error(
        'No runner for batch spec: configure CTI_RUNNERS with a Codex runtime, or set project Kanban role runner for codex-senior.',
      );
    }
    const eff = resolveRuntimeForPlatformInstance(config, {
      runtime: resolveKanbanAgent('codex-senior').runtime,
      runtimeProfileId: runner.id,
    });
    const pendingPermissions = new PendingPermissions();
    const provider = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: eff,
      runner,
      /** Headless JSON extraction; allow runner to complete without blocking on tool approval. */
      autoApproveOverride: true,
    });
    const tasks = await runBatchTaskSpecLlm({
      provider,
      rawText,
      workingDirectory: project.repository.localPath,
    });
    return { tasks };
  }

  /**
   * Persists a validated batch plan as **todo** tasks.
   * Each task’s `dependsOnIndices` are resolved to **real** `dependsOnIssueIds` pointing at tasks created earlier in this batch (same order as `input.tasks`).
   */
  async createTasksFromBatchPlan(input: {
    projectId: string;
    sprintId: string;
    tasks: BatchTaskPlanItem[];
  }): Promise<{ created: TaskSession[] }> {
    const project = this.requireProject(input.projectId);
    const sprint = this.requireSprint(input.sprintId);
    if (sprint.projectId !== project.id) {
      throw new Error('Sprint does not belong to the selected project');
    }
    const plan = normalizeBatchTaskPlan({ tasks: input.tasks });
    const created: TaskSession[] = [];
    const issueIdsByIndex: string[] = [];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      const dependsOnIssueIds = item.dependsOnIndices.map((j) => {
        const id = issueIdsByIndex[j];
        if (!id) {
          throw new Error(`Invalid plan: missing issue id for dependency index ${j}`);
        }
        return id;
      });
      const task = await this.createTask({
        projectId: input.projectId,
        sprintId: input.sprintId,
        title: item.title,
        ...(dependsOnIssueIds.length ? { dependsOnIssueIds } : {}),
      });
      created.push(task);
      issueIdsByIndex[i] = task.issueId;
    }
    return { created };
  }

  /**
   * Streamed chat with **codex-senior** (高级开发), guided by the brainstorming skill — board UI only (no task).
   */
  async streamBoardBrainstormChat(input: BoardBrainstormChatInput): Promise<ReadableStream<string>> {
    const project = this.requireProject(input.projectId);
    this.assertProjectLocalRepositoryPath(project);
    const config = loadConfig();
    const runner = pickRunnerForCodexSenior(project, config);
    if (!runner) {
      throw new Error(
        'No runner for board brainstorm: configure CTI_RUNNERS with a Codex runtime, or set project Kanban role runner for codex-senior.',
      );
    }
    const eff = resolveRuntimeForPlatformInstance(config, {
      runtime: resolveKanbanAgent('codex-senior').runtime,
      runtimeProfileId: runner.id,
    });
    const pendingPermissions = new PendingPermissions();
    const provider = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: eff,
      runner,
      /** Never auto-approve tool runs in plan-only board chat */
      autoApproveOverride: false,
    });
    const laneHints = preferredSkillsForProjectLane(project, 'codex-senior');
    const systemPrompt = [
      BOARD_BRAINSTORM_SYSTEM,
      '',
      'Lane skill hints (optional):',
      ...laneHints.map((h) => `- ${h}`),
    ].join('\n');

    return provider.streamChat({
      prompt: input.message,
      sessionId: input.sessionId,
      sdkSessionId: input.sdkSessionId,
      systemPrompt,
      workingDirectory: project.repository.localPath,
      conversationHistory: input.conversationHistory,
      disableLlmStreaming: false,
      /** Brainstorm chat: plan only — Codex OS sandbox blocks workspace writes */
      permissionMode: 'plan',
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
  }

  private async appendWorkflowComment(taskSessionId: string, content: string): Promise<void> {
    this.deps.store.appendConversationEntry(taskSessionId, {
      role: 'system',
      source: 'workflow',
      content,
    });
  }

  /** First user turn for the runner: local Kanban only (no external issue tracker). */
  private enqueueKickoffPrompt(taskSession: TaskSession): void {
    this.deps.store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskSessionId: taskSession.id,
      taskId: taskSession.taskId,
      type: 'directive',
      content: [
        `Begin work on task ${taskSession.issueId}: ${taskSession.title}.`,
        'Follow your role-specific instructions and the task context in this conversation.',
      ].join(' '),
    });
  }

  /** Nudge runner after platform restart when the queue was drained at shutdown. */
  private enqueueResumeAfterRestartPrompt(taskSession: TaskSession): void {
    this.deps.store.enqueueTaskMessage({
      queueKey: taskSession.messageQueueKey,
      taskSessionId: taskSession.id,
      taskId: taskSession.taskId,
      type: 'directive',
      content: [
        'The Kanban platform restarted while this task was active.',
        'Continue from the current conversation; do not redo work already recorded.',
      ].join(' '),
    });
  }

  private buildAgentInstance(taskSession: TaskSession, role: AgentRole): AgentInstanceRecord {
    const normalizedTaskSession = this.normalizeTaskWorkingCopy(taskSession);
    const project = this.requireProject(normalizedTaskSession.projectId);
    const existing = this.deps.store.findAgentInstance(taskSession.id, role);
    const rt = runtimeForRole(role, normalizedTaskSession);

    return {
      id: existing?.id ?? crypto.randomUUID(),
      projectId: normalizedTaskSession.projectId,
      sprintId: normalizedTaskSession.sprintId,
      taskId: normalizedTaskSession.taskId,
      taskSessionId: normalizedTaskSession.id,
      runtime: rt,
      runtimeProfileId: normalizedTaskSession.runtimeProfileId ?? existing?.runtimeProfileId,
      role,
      status: existing?.status ?? 'starting',
      branchName: normalizedTaskSession.branchName,
      workingDirectory: normalizedTaskSession.workingDirectory || project.repository.localPath,
      approvalsRequired: true,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      startedAt: existing?.startedAt,
      stoppedAt: existing?.stoppedAt,
      lastError: existing?.lastError,
    };
  }

  private normalizeTaskWorkingCopy(taskSession: TaskSession): TaskSession {
    const project = this.requireProject(taskSession.projectId);
    const repoPath = project.repository.localPath;
    const worktreePath = taskSession.worktreePath?.trim();
    const workingDirectory = taskSession.workingDirectory?.trim();
    const worktreeExists = worktreePath ? fs.existsSync(worktreePath) : false;
    const workingDirectoryExists = workingDirectory ? fs.existsSync(workingDirectory) : false;
    const normalizeInstances = (taskId: string) => {
      for (const instance of this.deps.store.listAgentInstances(taskId)) {
        const instanceWorkingDirectory = instance.workingDirectory?.trim();
        const instanceWorkingDirectoryExists = instanceWorkingDirectory ? fs.existsSync(instanceWorkingDirectory) : false;
        if (instanceWorkingDirectoryExists) continue;
        this.deps.store.upsertAgentInstance({
          ...instance,
          workingDirectory: repoPath,
          updatedAt: now(),
        });
      }
    };

    if ((worktreePath && worktreeExists) || (workingDirectory && workingDirectoryExists)) {
      normalizeInstances(taskSession.id);
      return taskSession;
    }

    const normalized: TaskSession = {
      ...taskSession,
      workingDirectory: repoPath,
      worktreePath: undefined,
      updatedAt: now(),
    };
    this.deps.store.upsertTaskSession(normalized);
    normalizeInstances(taskSession.id);
    return normalized;
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
