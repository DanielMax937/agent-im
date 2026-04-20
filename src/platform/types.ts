export type AgentRuntime = 'claude' | 'codex' | 'cursor' | 'copilot';
export type AgentRole = 'developer' | 'reviewer' | 'tester';
/**
 * Kanban columns:
 * 待办 | 队列 | 开发中 | 前置测试 | 测试中 | 评审 | 回归测试中 | UAT | 合并主干 | 关闭中 | 完成
 *
 * New states added:
 * - `blocked`: task is externally blocked (any active lane → blocked → resume back to same lane)
 * - `pending_uat`: optional UAT approval gate between regression_testing and pending_release
 * - `closing`: async PR-merge verification + coverage check running; moves to closed or back to pending_release
 */
export type TaskWorkflowState =
  | 'todo'
  | 'pending_start'
  | 'in_progress'
  | 'pre_testing'
  | 'review'
  | 'testing'
  | 'regression_testing'
  /** Optional UAT gate: enabled when `project.requiresUat` is true; human approves to proceed to pending_release. */
  | 'pending_uat'
  /** Sprint/integration → base release PR ensured when entering; then human merges on host and tester closes. */
  | 'pending_release'
  /** Async close in progress: PR merge verified, coverage check running. Moves to closed or back to pending_release. */
  | 'closing'
  /** Task was blocked by an external dependency; runner paused. Unblocks back to `blockedFromState`. */
  | 'blocked'
  | 'closed';

/**
 * Human-facing agent lanes for assignment UI and routing.
 * - agent-dev: default developer (Claude)
 * - pre-tester: prerequisite/env validation before feature testing
 * - claude-review: code review
 * - copilot-test: feature testing on task branch
 * - codex-senior: escalation developer after repeated review pushback
 * - self-host-runner: CI gate for private repos; no AI agent — waits for GitHub Actions
 *   self-hosted runner webhook callback to advance the workflow
 */
export type KanbanAgentKind = 'agent-dev' | 'pre-tester' | 'claude-review' | 'copilot-test' | 'codex-senior' | 'self-host-runner';

/** One human or logical assignee in a Kanban lane; each has their own runner profile. */
export interface KanbanRoleMember {
  id: string;
  name: string;
  /** Runner id from `CTI_RUNNERS` / project mapping. */
  runnerProfileId: string;
}
export type SprintStatus = 'planned' | 'active' | 'closed';
export type AgentInstanceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type TaskMessageType =
  | 'directive'
  | 'review_feedback'
  | 'test_failure'
  | 'system'
  | 'system_check'
  | 'human_followup';

export interface ProjectAgentProfile {
  id: string;
  name: string;
  runtime: AgentRuntime;
  role: AgentRole;
  model?: string;
}

export interface ProjectRepository {
  remoteUrl: string;
  localPath: string;
  baseBranch: string;
  sprintBranchPrefix: string;
  taskBranchPrefix: string;
  scmProvider: 'github' | 'gitlab';
  scmProject: string;
  scmApiBaseUrl?: string;
  scmTokenEnvVar?: string;
}

/**
 * Optional per-project auto-deploy contract for Kanban developer lane prompts.
 *
 * When `enabled !== false`, the developer lane must preserve or create a GitHub Actions workflow
 * that deploys with Vercel CLI after merges land on the configured integration branch and notifies
 * Telegram on success.
 */
export interface ProjectDeploymentConfig {
  /** Defaults to `true` when omitted. Set `false` to disable deploy automation requirements. */
  enabled?: boolean;
  /** Vercel project name. Defaults to the Kanban project id when omitted. */
  vercelProjectName?: string;
  /** Optional Vercel team / scope slug used by `vercel project add` and `vercel link`. */
  vercelScope?: string;
 /** Optional IDs resolved from `.vercel/project.json` after linking. */
  vercelProjectId?: string;
  vercelOrgId?: string;
  /**
   * Sprint / integration Git branch name (e.g. `feature/mvp-sprint`). Before merging a review PR, Kanban may
   * PATCH Vercel's Git `productionBranch` to this ref so the merge triggers a **Production** build; after merge,
   * this value is persisted for polling Telegram notifications against READY deployments on that branch.
   */
  productionBranch?: string;
  /** Whether successful Vercel deployments for {@link productionBranch} should send Telegram notifications. Defaults to true. */
  notifyTelegram?: boolean;
  /** Last Vercel deployment id already notified to Telegram (sprint-branch poll dedupe). */
  lastNotifiedDeploymentId?: string;
  /**
   * When `false`, Kanban will not call `vercel api` to PATCH the Vercel project's
   * `link.productionBranch` before merging a PR into the sprint branch. Defaults to `true`
   * when deployment is enabled (so Git-triggered builds target Production for that branch).
   */
  applyVercelGitProductionBranchPatch?: boolean;
  /**
   * When `false`, skip PATCH + `vercel deploy --prod` after a task closes (normally restores Git
   * production branch to the repo base). Defaults to `true` when deployment is enabled.
   */
  restoreVercelGitProductionBranchOnClose?: boolean;
  /**
   * When set (e.g. `nextjs`), Kanban issues `PATCH /v9/projects/{id}` with `{ "framework": "<value>" }`
   * after Vercel link / Git connect so the project preset matches the repo (avoids dashboard `Other`
   * + wrong output directory). Omit to skip the API call.
   */
  vercelFramework?: string;
}

/** Options for HTTP `POST .../tasks/:id/close` and `WorkflowService.closeTask`. */
export type CloseTaskOptions = {
  /**
   * When `true`, do not PATCH Vercel production branch back to base or trigger a deploy (used so
   * **bulk** closes only run restore once per project — on the last task in that batch).
   */
  skipVercelRestoreAfterClose?: boolean;
};

/**
 * Per-project unit-test coverage record. Coverage is the total lines percentage (0–100) from
 * coverage/coverage-summary.json. Only updated when the new value is higher than the stored value.
 */
export interface ProjectCoverageRecord {
  projectId: string;
  /** Lines coverage percentage (0–100). Starts at 0 for new projects. */
  coverage: number;
  updatedAt: string;
}

/** One entry in the per-project coverage history (immutable; inserted on every successful update). */
export interface ProjectCoverageHistoryEntry {
  id: string;
  projectId: string;
  coverage: number;
  /** Optional context label (e.g. branch name or sprint id). */
  context?: string;
  recordedAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** Optional human owner (e.g. @telegram or name) for status queries. */
  owner?: string;
  /**
   * Prefix for auto-generated issue ids (`PREFIX-1`, …). Unique per project is enforced
   * by `(projectId, issueId)`; if unset, derived from the first segment of `id` (e.g. `demo-x` → `DEMO`).
   */
  issueIdPrefix?: string;
  /**
   * Maps Kanban lane → runner id (`CTI_RUNNERS` / `config.env`). When set, overrides default
   * runtime-only resolution for that lane (developer / reviewer / tester instances).
   * If `kanbanRoleMembers[kind]` is non-empty, members take precedence for assignment.
   */
  kanbanRoleRunners?: Partial<Record<KanbanAgentKind, string>>;
  /**
   * Multiple assignees per lane; each row has a runner. Used for auto (sticky + least-loaded) or manual pick.
   */
  kanbanRoleMembers?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>>;
  /**
   * Per-lane skill catalog ids (e.g. `cursor/foo`). When set and non-empty for a lane, replaces
   * built-in default lines for that lane in prompts. Ids are resolved to labels via `/api/skills/catalog`.
   */
  kanbanLaneSkills?: Partial<Record<KanbanAgentKind, string[]>>;
  repository: ProjectRepository;
  /** Project-level deploy automation contract for GitHub workflow generation. Defaults to enabled when omitted. */
  deployment?: ProjectDeploymentConfig;
  /**
   * Vercel `framework` slug for this repo (`PATCH /v9/projects`), chosen at bootstrap or overridden via API.
   * Used for Vercel preset updates and injected into Kanban / batch-spec prompts.
   */
  vercelDeploymentFramework?: string;
  /**
   * Shell command to run unit tests and produce coverage output.
   * Defaults to `npm test -- --coverage --coverageReporters=json-summary`.
   * Set to empty string to skip automated coverage checking on close.
   */
  coverageCommand?: string;
  /**
   * Path (relative to repo root) where the coverage summary JSON lives.
   * Supports `coverage/coverage-summary.json` (Jest/c8 json-summary format, default)
   * or `coverage/lcov.info` (lcov format — lines coverage extracted from SF/LH/LF records).
   */
  coverageSummaryPath?: string;
  /**
   * When true, a `pending_uat` state is inserted between `regression_testing` and `pending_release`.
   * A human must explicitly approve (POST /api/workflows/tasks/:id/uat-approve) to proceed.
   */
  requiresUat?: boolean;
  /**
   * When true, this project's repository is private and CI runs on a self-hosted GitHub Actions
   * runner (e.g. a local Mac Mini). The `regression_testing` lane will not start an AI agent;
   * instead it waits for a webhook callback from the CI runner:
   *   POST /api/workflows/tasks/:taskSessionId/ci-result
   */
  isPrivate?: boolean;
  agents: ProjectAgentProfile[];
  createdAt: string;
  updatedAt: string;
}

export interface Sprint {
  id: string;
  projectId: string;
  name: string;
  branchName: string;
  baseBranch: string;
  status: SprintStatus;
  taskIds: string[];
  startedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Ordered list of `taskSessionId` values waiting for first developer execution after assign-from-todo.
   * The server scans this list (also on a timer) and starts each `pending_start` task whose dependencies
   * are satisfied; blocked entries stay listed until ready — others behind them can still start.
   */
  pendingDeveloperAssignmentQueue?: string[];
}

export interface TaskConversationEntry {
  id: string;
  role: 'system' | 'user' | 'assistant';
  source: 'kanban' | 'workflow' | 'human' | 'developer' | 'reviewer' | 'tester';
  content: string;
  createdAt: string;
}

/** Persisted handoff / manual notes on a task (shown in board detail → 交接记录). */
export interface TaskHistoryComment {
  id: string;
  /** Role whose work is summarized when `kind === 'transition'`; null for system-only steps or manual notes without role. */
  role: AgentRole | null;
  kind: 'transition' | 'manual';
  content: string;
  createdAt: string;
  transition?: {
    from: TaskWorkflowState;
    to: TaskWorkflowState;
    actionLabel: string;
  };
}

export interface TaskSession {
  id: string;
  projectId: string;
  sprintId: string;
  taskId: string;
  issueId: string;
  title: string;
  workflowState: TaskWorkflowState;
  runtime: AgentRuntime;
  /** When set, resolves runtime from `config.runners` (overrides `runtime` for execution). */
  runtimeProfileId?: string;
  role: AgentRole;
  /** Last lane used when assigning work (drives prompts + runner selection). */
  kanbanAgent?: KanbanAgentKind;
  /** Sticky assignee per lane (`KanbanRoleMember.id`) for auto-routing and history. */
  kanbanAssignees?: Partial<Record<KanbanAgentKind, string>>;
  /** Review rounds pushed back to development (used to escalate to codex-senior). */
  reviewRejectionCount?: number;
  /**
   * Other tasks’ **issue ids** in the same project that must reach **pending_release** or **closed**
   * before this task may leave the assignment queue and start development (first assign from todo).
   */
  dependsOnIssueIds?: string[];
  /** Read by the next agent at start (also mirrored into prompts). */
  handoffComment?: string;
  /** Skill hints appended to system prompt (from kanban agent presets). */
  preferredSkills?: string[];
  /** Optional isolated checkout via `git worktree` (developer workdir). */
  worktreePath?: string;
  /** `origin/<baseBranch>` SHA when regression started; used to detect new merges on master. */
  regressionMasterSha?: string;
  sessionId: string;
  providerSessionId?: string;
  workingDirectory: string;
  branchName?: string;
  reviewBranchName?: string;
  pullRequestUrl?: string;
  /** Set when a PR/MR is created (GitHub/GitLab number) — used to merge via API. */
  pullRequestNumber?: number;
  /** Open PR/MR to merge sprint integration branch into repository base (e.g. master); manual merge only. */
  releasePullRequestUrl?: string;
  releasePullRequestNumber?: number;
  messageQueueKey: string;
  approvalQueueKey: string;
  /** Count of automated `system_check` prompts enqueued without a workflow transition; resets on transition or human queue. */
  confirmationLoopCount?: number;
  lastError?: string;
  systemPrompt?: string;
  /** When true, this task is a hotfix: the pre_testing lane is skipped (in_progress → testing directly). */
  isHotfix?: boolean;
  /** When `workflowState === 'blocked'`: the state to restore when unblocked. */
  blockedFromState?: TaskWorkflowState;
  /** Human-readable reason why this task was blocked. */
  blockReason?: string;
  /** Latest structured test result from the tester lane. Updated each time a tester turn completes. */
  lastTestResult?: {
    /** Lines coverage percentage 0–100 (if available). */
    coverage?: number;
    /** Number of tests run. */
    testCount?: number;
    /** Short list of failing test names/commands. */
    failingTests?: string[];
    /** ISO timestamp when this result was recorded. */
    timestamp: string;
  };
  conversationHistory: TaskConversationEntry[];
  /** Chronological handoff summaries (per transition) and manual API comments; also appended to each role’s system prompt. */
  historyComments?: TaskHistoryComment[];
  createdAt: string;
  updatedAt: string;
  /** Set by GET /api/tasks when the active lane instance is streaming an LLM reply. */
  agentGenerating?: boolean;
}

export interface AgentInstanceRecord {
  id: string;
  projectId: string;
  sprintId: string;
  taskId: string;
  taskSessionId: string;
  runtime: AgentRuntime;
  /** Optional; copied from task session — selects a named runtime profile from config. */
  runtimeProfileId?: string;
  role: AgentRole;
  status: AgentInstanceStatus;
  branchName?: string;
  workingDirectory: string;
  approvalsRequired: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  /** True while this instance is inside an LLM stream for one turn. */
  generating?: boolean;
}

export interface TaskQueueMessage {
  id: string;
  queueKey: string;
  taskSessionId: string;
  taskId: string;
  type: TaskMessageType;
  content: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface PendingApprovalRecord {
  id: string;
  instanceId: string;
  taskSessionId: string;
  taskId: string;
  toolName: string;
  toolInput: string;
  queueKey: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  resolvedAt?: string;
  resolutionMessage?: string;
}

export interface TaskFailurePayload {
  taskSessionId: string;
  summary: string;
  log: string;
}

export interface StartSprintInput {
  projectId: string;
  sprintName: string;
  baseBranch?: string;
}

export interface CreateTaskInput {
  projectId: string;
  sprintId: string;
  /** Omit to auto-generate `{issueIdPrefix}-n` unique within this project. */
  issueId?: string;
  title: string;
  /** Issue ids of existing tasks in the same project that must reach pending_release or closed before this task can start dev. */
  dependsOnIssueIds?: string[];
  /** When true, skip pre_testing lane: developer hands off directly from in_progress to testing. */
  isHotfix?: boolean;
}

export interface AssignTaskInput {
  projectId: string;
  sprintId: string;
  issueId: string;
  /** Required for legacy assign; optional when `taskSessionId` picks up a todo card. */
  title?: string;
  /** Required for legacy assign; optional when `taskSessionId` is set (resolved from lane). */
  runtime?: AgentRuntime;
  /** Use a named runner id from `CTI_RUNNERS` (preferred over bare `runtime` when both set). */
  runtimeProfileId?: string;
  role?: AgentRole;
  /**
   * When set, assigns an existing **todo** task (queued `pending_start` → `in_progress`) or **re-assigns**
   * the developer lane on an **in_progress** task (same escalation rules as todo pick-up, including
   * codex-senior when `reviewRejectionCount > 2` and `kanbanAgent` is `agent-dev`).
   * Omit for legacy “create + assign developer in one shot”.
   */
  taskSessionId?: string;
  kanbanAgent?: KanbanAgentKind;
  handoffComment?: string;
  /** When project defines members for this lane, pick this assignee; omit for auto (sticky → least load). */
  assigneeMemberId?: string;
  /** Default true. Set false to require `assigneeMemberId` when members exist. */
  autoAssign?: boolean;
  /**
   * When legacy assign creates a new task (no existing row for `issueId`), optional dependency list
   * (same as `CreateTaskInput.dependsOnIssueIds`).
   */
  dependsOnIssueIds?: string[];
}

export interface SubmitTaskForReviewInput {
  taskSessionId: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  /**
   * When set (e.g. workflow auto-advance from this runner), that instance is stopped
   * after the transition finishes so the runner is not awaited while still inside its loop.
   */
  deferStopInstanceId?: string;
}

export interface ApprovalResolutionInput {
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * One row per queue turn toward a target agent: who handed off, who receives,
 * prior agent’s last reply (empty on first assignment), and the prompt sent to the target.
 *
 * Rows are inserted when the target run is **about to start** (prompt known); `streamError`
 * is updated after the stream finishes.
 */
export interface KanbanAgentTurnRecord {
  id: string;
  projectId: string;
  taskSessionId: string;
  /** Issue id (board / filter). */
  taskId: string;
  createdAt: string;
  /** Who handed off (lane/role label); empty when none (e.g. first assignment from todo). */
  sourceAgent: string;
  /** Who is prompted this turn (lane/role). */
  targetAgent: string;
  /** Last assistant message before this turn; empty on first assignment or no prior reply. */
  sourceAgentResponse: string;
  /** Full prompt bundle sent to the target runtime (system + history + user turn). */
  targetAgentPrompt: string;
  /** Set after the stream ends if the run failed. */
  streamError?: string;
}
