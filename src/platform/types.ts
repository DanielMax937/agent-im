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
  source: 'jira' | 'workflow' | 'developer' | 'reviewer' | 'tester';
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

export interface JiraInstanceConfig {
  baseUrl: string;
  issueId: string;
  email: string;
  apiToken: string;
  pollIntervalMs: number;
  botAccountId?: string;
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
  jira: JiraInstanceConfig;
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
  issueId: string;
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
}

export interface SubmitTaskForReviewInput {
  taskSessionId: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface ApprovalResolutionInput {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface JiraWebhookPayload {
  projectId: string;
  sprintId?: string;
  issueId: string;
  issueKey?: string;
  title?: string;
  status?: string;
  runtime?: AgentRuntime;
}
