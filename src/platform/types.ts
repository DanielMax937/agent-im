export type AgentRuntime = 'claude' | 'codex' | 'cursor';
export type AgentRole = 'developer' | 'reviewer' | 'tester';
export type TaskWorkflowState = 'todo' | 'in_progress' | 'review' | 'testing' | 'closed';
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
  role: AgentRole;
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

export interface AssignTaskInput {
  projectId: string;
  sprintId: string;
  issueId: string;
  title: string;
  runtime: AgentRuntime;
  role?: AgentRole;
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
