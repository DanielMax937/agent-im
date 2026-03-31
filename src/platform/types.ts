export type AgentRuntime = 'claude' | 'codex' | 'cursor' | 'copilot';
export type AgentRole = 'developer' | 'reviewer' | 'tester';
/** Kanban columns: 待办 | 开发中 | 评审 | 测试中 | 回归测试中 | 完成 */
export type TaskWorkflowState =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'testing'
  | 'regression_testing'
  | 'closed';

/**
 * Human-facing agent lanes for assignment UI and routing.
 * - agent-dev: default developer (Claude)
 * - claude-review: code review
 * - copilot-test: feature testing on task branch
 * - codex-senior: escalation developer after repeated review pushback
 */
export type KanbanAgentKind = 'agent-dev' | 'claude-review' | 'copilot-test' | 'codex-senior';

/** One human or logical assignee in a Kanban lane; each has their own runner profile. */
export interface KanbanRoleMember {
  id: string;
  name: string;
  /** Runner id from `CTI_RUNNERS` / project mapping. */
  runnerProfileId: string;
}
export type SprintStatus = 'planned' | 'active' | 'closed';
export type AgentInstanceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type TaskMessageType = 'directive' | 'review_feedback' | 'test_failure' | 'system';

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
  repository: ProjectRepository;
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
}

export interface TaskConversationEntry {
  id: string;
  role: 'system' | 'user' | 'assistant';
  source: 'kanban' | 'workflow' | 'developer' | 'reviewer' | 'tester';
  content: string;
  createdAt: string;
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
  messageQueueKey: string;
  approvalQueueKey: string;
  lastError?: string;
  systemPrompt?: string;
  conversationHistory: TaskConversationEntry[];
  createdAt: string;
  updatedAt: string;
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
   * When set, assigns an existing **todo** task: creates branch/worktree and starts the mapped runner.
   * Omit for legacy “create + assign developer in one shot”.
   */
  taskSessionId?: string;
  kanbanAgent?: KanbanAgentKind;
  handoffComment?: string;
  /** When project defines members for this lane, pick this assignee; omit for auto (sticky → least load). */
  assigneeMemberId?: string;
  /** Default true. Set false to require `assigneeMemberId` when members exist. */
  autoAssign?: boolean;
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
 */
export interface KanbanAgentTurnRecord {
  id: string;
  projectId: string;
  taskSessionId: string;
  /** Issue id (board / filter). */
  taskId: string;
  createdAt: string;
  /** Who handed off (lane/role label); empty on first todo → assign kickoff. */
  sourceAgent: string;
  /** Who is prompted this turn (lane/role). */
  targetAgent: string;
  /** Last assistant message before this turn; empty on first assignment. */
  sourceAgentResponse: string;
  /** Full prompt bundle sent to the target runtime (system + history + user turn). */
  targetAgentPrompt: string;
  /** Set when the stream failed. */
  streamError?: string;
}
