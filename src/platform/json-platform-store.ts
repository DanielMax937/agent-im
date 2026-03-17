import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config';
import type {
  AgentInstanceRecord,
  PendingApprovalRecord,
  Project,
  Sprint,
  TaskConversationEntry,
  TaskQueueMessage,
  TaskSession,
} from './types';

const PLATFORM_DIR = path.join(CTI_HOME, 'data', 'platform');

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function now(): string {
  return new Date().toISOString();
}

export function createTaskQueueKey(taskId: string, suffix = 'inbox'): string {
  return `task:${taskId}:${suffix}`;
}

export function createApprovalQueueKey(taskId: string): string {
  return createTaskQueueKey(taskId, 'approvals');
}

export class JsonPlatformStore {
  private projects = new Map<string, Project>();
  private sprints = new Map<string, Sprint>();
  private taskSessions = new Map<string, TaskSession>();
  private agentInstances = new Map<string, AgentInstanceRecord>();
  private queues = new Map<string, TaskQueueMessage[]>();
  private approvals = new Map<string, PendingApprovalRecord>();

  constructor(private readonly baseDir = PLATFORM_DIR) {
    ensureDir(this.baseDir);
    this.load();
  }

  private load(): void {
    const projects = readJson<Project[]>(path.join(this.baseDir, 'projects.json'), []);
    const sprints = readJson<Sprint[]>(path.join(this.baseDir, 'sprints.json'), []);
    const taskSessions = readJson<TaskSession[]>(path.join(this.baseDir, 'task_sessions.json'), []);
    const agentInstances = readJson<AgentInstanceRecord[]>(path.join(this.baseDir, 'agent_instances.json'), []);
    const queueEntries = readJson<Array<[string, TaskQueueMessage[]]>>(path.join(this.baseDir, 'queues.json'), []);
    const approvals = readJson<PendingApprovalRecord[]>(path.join(this.baseDir, 'approvals.json'), []);

    for (const item of projects) this.projects.set(item.id, item);
    for (const item of sprints) this.sprints.set(item.id, item);
    for (const item of taskSessions) this.taskSessions.set(item.id, item);
    for (const item of agentInstances) this.agentInstances.set(item.id, item);
    for (const [queueKey, messages] of queueEntries) this.queues.set(queueKey, messages);
    for (const item of approvals) this.approvals.set(item.id, item);
  }

  private persistProjects(): void {
    writeJson(path.join(this.baseDir, 'projects.json'), Array.from(this.projects.values()));
  }

  private persistSprints(): void {
    writeJson(path.join(this.baseDir, 'sprints.json'), Array.from(this.sprints.values()));
  }

  private persistTaskSessions(): void {
    writeJson(path.join(this.baseDir, 'task_sessions.json'), Array.from(this.taskSessions.values()));
  }

  private persistAgentInstances(): void {
    writeJson(path.join(this.baseDir, 'agent_instances.json'), Array.from(this.agentInstances.values()));
  }

  private persistQueues(): void {
    writeJson(path.join(this.baseDir, 'queues.json'), Array.from(this.queues.entries()));
  }

  private persistApprovals(): void {
    writeJson(path.join(this.baseDir, 'approvals.json'), Array.from(this.approvals.values()));
  }

  listProjects(): Project[] {
    return Array.from(this.projects.values());
  }

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  upsertProject(project: Project): Project {
    const existing = this.projects.get(project.id);
    const nextProject = {
      ...project,
      createdAt: existing?.createdAt ?? project.createdAt ?? now(),
      updatedAt: now(),
    };
    this.projects.set(project.id, nextProject);
    this.persistProjects();
    return nextProject;
  }

  listSprints(projectId?: string): Sprint[] {
    const items = Array.from(this.sprints.values());
    if (!projectId) return items;
    return items.filter((item) => item.projectId === projectId);
  }

  getSprint(sprintId: string): Sprint | null {
    return this.sprints.get(sprintId) ?? null;
  }

  upsertSprint(sprint: Sprint): Sprint {
    const existing = this.sprints.get(sprint.id);
    const nextSprint = {
      ...sprint,
      createdAt: existing?.createdAt ?? sprint.createdAt ?? now(),
      updatedAt: now(),
    };
    this.sprints.set(nextSprint.id, nextSprint);
    this.persistSprints();
    return nextSprint;
  }

  listTaskSessions(projectId?: string): TaskSession[] {
    const items = Array.from(this.taskSessions.values());
    if (!projectId) return items;
    return items.filter((item) => item.projectId === projectId);
  }

  getTaskSession(taskSessionId: string): TaskSession | null {
    return this.taskSessions.get(taskSessionId) ?? null;
  }

  getTaskSessionByIssueId(issueId: string): TaskSession | null {
    for (const session of this.taskSessions.values()) {
      if (session.issueId === issueId) return session;
    }
    return null;
  }

  upsertTaskSession(taskSession: TaskSession): TaskSession {
    const existing = this.taskSessions.get(taskSession.id);
    const nextTaskSession = {
      ...taskSession,
      createdAt: existing?.createdAt ?? taskSession.createdAt ?? now(),
      updatedAt: now(),
    };
    this.taskSessions.set(nextTaskSession.id, nextTaskSession);
    this.persistTaskSessions();
    return nextTaskSession;
  }

  appendConversationEntry(taskSessionId: string, entry: Omit<TaskConversationEntry, 'id' | 'createdAt'>): TaskConversationEntry {
    const session = this.getTaskSession(taskSessionId);
    if (!session) {
      throw new Error(`Task session not found: ${taskSessionId}`);
    }

    const nextEntry: TaskConversationEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: now(),
    };

    session.conversationHistory.push(nextEntry);
    session.updatedAt = now();
    this.taskSessions.set(session.id, session);
    this.persistTaskSessions();
    return nextEntry;
  }

  listAgentInstances(taskSessionId?: string): AgentInstanceRecord[] {
    const items = Array.from(this.agentInstances.values());
    if (!taskSessionId) return items;
    return items.filter((item) => item.taskSessionId === taskSessionId);
  }

  getAgentInstance(instanceId: string): AgentInstanceRecord | null {
    return this.agentInstances.get(instanceId) ?? null;
  }

  findAgentInstance(taskSessionId: string, role: AgentInstanceRecord['role']): AgentInstanceRecord | null {
    for (const item of this.agentInstances.values()) {
      if (item.taskSessionId === taskSessionId && item.role === role) return item;
    }
    return null;
  }

  upsertAgentInstance(instance: AgentInstanceRecord): AgentInstanceRecord {
    const existing = this.agentInstances.get(instance.id);
    const nextInstance = {
      ...instance,
      createdAt: existing?.createdAt ?? instance.createdAt ?? now(),
      updatedAt: now(),
    };
    this.agentInstances.set(nextInstance.id, nextInstance);
    this.persistAgentInstances();
    return nextInstance;
  }

  removeAgentInstance(instanceId: string): void {
    this.agentInstances.delete(instanceId);
    this.persistAgentInstances();
  }

  enqueueTaskMessage(message: Omit<TaskQueueMessage, 'id' | 'createdAt'>): TaskQueueMessage {
    const nextMessage: TaskQueueMessage = {
      ...message,
      id: crypto.randomUUID(),
      createdAt: now(),
    };
    const queue = this.queues.get(message.queueKey) ?? [];
    queue.push(nextMessage);
    this.queues.set(message.queueKey, queue);
    this.persistQueues();
    return nextMessage;
  }

  drainTaskQueue(queueKey: string): TaskQueueMessage[] {
    const queued = this.queues.get(queueKey) ?? [];
    this.queues.set(queueKey, []);
    this.persistQueues();
    return queued;
  }

  peekTaskQueue(queueKey: string): TaskQueueMessage[] {
    return [...(this.queues.get(queueKey) ?? [])];
  }

  savePendingApproval(record: PendingApprovalRecord): PendingApprovalRecord {
    const existing = this.approvals.get(record.id);
    const nextRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? now(),
    };
    this.approvals.set(nextRecord.id, nextRecord);
    this.persistApprovals();
    return nextRecord;
  }

  getPendingApproval(approvalId: string): PendingApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  listPendingApprovals(taskSessionId?: string): PendingApprovalRecord[] {
    const items = Array.from(this.approvals.values());
    const filtered = items.filter((item) => item.status === 'pending');
    if (!taskSessionId) return filtered;
    return filtered.filter((item) => item.taskSessionId === taskSessionId);
  }

  resolvePendingApproval(
    approvalId: string,
    status: PendingApprovalRecord['status'],
    resolutionMessage?: string,
  ): PendingApprovalRecord | null {
    const record = this.approvals.get(approvalId);
    if (!record) return null;
    const nextRecord: PendingApprovalRecord = {
      ...record,
      status,
      resolutionMessage,
      resolvedAt: now(),
    };
    this.approvals.set(approvalId, nextRecord);
    this.persistApprovals();
    return nextRecord;
  }
}
