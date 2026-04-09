import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getKanbanPlatformCtiHome } from '../config';
import { scheduleConversationEntryTelegram } from './kanban-notify';
import { allocateNextIssueId, resolveIssueIdPrefix } from './issue-id';
import { assertValidLocalRepositoryPath } from './repository-path';
import type {
  AgentInstanceRecord,
  KanbanAgentTurnRecord,
  PendingApprovalRecord,
  Project,
  ProjectCoverageHistoryEntry,
  ProjectCoverageRecord,
  Sprint,
  TaskConversationEntry,
  TaskQueueMessage,
  TaskSession,
} from './types';

/**
 * Directory for platform DB and legacy JSON migration.
 *
 * Default: `<cwd>/data/platform` (project-local).
 * Override: `CTI_KANBAN_PLATFORM_DIR` — absolute path, or relative to `process.cwd()`.
 * Legacy (under bridge home): `CTI_KANBAN_PLATFORM_DIR=cti-home` → `$CTI_HOME/data/platform`.
 *
 * SQLite file name under that directory defaults to `platform.db`; override with
 * `CTI_KANBAN_PLATFORM_DB_FILE` (e.g. `test.db` for unit/e2e so production `platform.db` is never used).
 */
export function platformDataDir(): string {
  const raw = process.env.CTI_KANBAN_PLATFORM_DIR?.trim();
  if (raw === 'cti-home' || raw === 'legacy') {
    return path.join(getKanbanPlatformCtiHome(), 'data', 'platform');
  }
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  }
  return path.join(process.cwd(), 'data', 'platform');
}

/** Basename only; default `platform.db`. Use `test.db` in automated tests via env. */
export function platformDbFileName(): string {
  const raw = process.env.CTI_KANBAN_PLATFORM_DB_FILE?.trim();
  const name = raw || 'platform.db';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('CTI_KANBAN_PLATFORM_DB_FILE must be a basename without path separators');
  }
  return name;
}

/** Full path to the platform SQLite file (same rules as {@link JsonPlatformStore} default). */
export function platformDbPath(): string {
  return path.join(platformDataDir(), platformDbFileName());
}

function defaultDbPath(): string {
  return platformDbPath();
}

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

function now(): string {
  return new Date().toISOString();
}

export function createTaskQueueKey(taskId: string, suffix = 'inbox'): string {
  return `task:${taskId}:${suffix}`;
}

export function createApprovalQueueKey(taskId: string): string {
  return createTaskQueueKey(taskId, 'approvals');
}

export type JsonPlatformStoreOptions = {
  /** Defaults to {@link platformDbPath} (`CTI_KANBAN_PLATFORM_DB_FILE`, default `platform.db`). Use `:memory:` for isolated tests. */
  dbPath?: string;
};

/**
 * Platform persistence (projects, sprints, tasks, instances, queues, approvals) in SQLite.
 * Legacy `*.json` files in the same directory are imported once when the DB is empty, then renamed to `*.migrated.bak`.
 */
export class JsonPlatformStore {
  private readonly db: DatabaseSync;
  private readonly baseDir: string;

  private projects = new Map<string, Project>();
  private sprints = new Map<string, Sprint>();
  private taskSessions = new Map<string, TaskSession>();
  private agentInstances = new Map<string, AgentInstanceRecord>();
  private queues = new Map<string, TaskQueueMessage[]>();
  private approvals = new Map<string, PendingApprovalRecord>();
  private coverageMap = new Map<string, ProjectCoverageRecord>();

  constructor(options?: JsonPlatformStoreOptions) {
    const dbPath = options?.dbPath ?? defaultDbPath();
    this.baseDir = platformDataDir();
    ensureDir(this.baseDir);
    if (dbPath !== ':memory:') {
      ensureDir(path.dirname(dbPath));
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.migrateKanbanAgentTurnsIfLegacy();
    this.migrateFromJsonIfNeeded();
    this.loadFromDb();
  }

  /** `node:sqlite` has no `transaction()` helper; mirror better-sqlite3 behavior with explicit BEGIN/COMMIT. */
  private runInTransaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Replace pre-schema-rename `kanban_agent_turns` (e.g. `full_prompt`) with the handoff-oriented columns. */
  private migrateKanbanAgentTurnsIfLegacy(): void {
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kanban_agent_turns'")
      .get() as { name: string } | undefined;
    if (!exists) return;
    const cols = this.db.prepare('PRAGMA table_info(kanban_agent_turns)').all() as { name: string }[];
    const hasNew = cols.some((c) => c.name === 'target_agent_prompt');
    if (hasNew) return;
    this.db.exec(`
      DROP TABLE IF EXISTS kanban_agent_turns;
      CREATE TABLE kanban_agent_turns (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        task_session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_agent TEXT NOT NULL DEFAULT '',
        target_agent TEXT NOT NULL,
        source_agent_response TEXT NOT NULL DEFAULT '',
        target_agent_prompt TEXT NOT NULL,
        stream_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_project ON kanban_agent_turns(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_project_task ON kanban_agent_turns(project_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_session ON kanban_agent_turns(task_session_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_created ON kanban_agent_turns(created_at);
    `);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sprints (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sprints_project_id ON sprints(project_id);

      CREATE TABLE IF NOT EXISTS task_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_sessions_project_id ON task_sessions(project_id);

      CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY NOT NULL,
        task_session_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_instances_task_session ON agent_instances(task_session_id);

      CREATE TABLE IF NOT EXISTS queues (
        queue_key TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY NOT NULL,
        task_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_task_session ON approvals(task_session_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

      CREATE TABLE IF NOT EXISTS kanban_agent_turns (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        task_session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_agent TEXT NOT NULL DEFAULT '',
        target_agent TEXT NOT NULL,
        source_agent_response TEXT NOT NULL DEFAULT '',
        target_agent_prompt TEXT NOT NULL,
        stream_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_project ON kanban_agent_turns(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_project_task ON kanban_agent_turns(project_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_session ON kanban_agent_turns(task_session_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_turns_created ON kanban_agent_turns(created_at);

      CREATE TABLE IF NOT EXISTS project_coverage (
        project_id TEXT PRIMARY KEY NOT NULL,
        coverage REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_coverage_history (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        coverage REAL NOT NULL,
        context TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_coverage_history_project ON project_coverage_history(project_id, recorded_at);
    `);
  }

  private migrateFromJsonIfNeeded(): void {
    const projectsPath = path.join(this.baseDir, 'projects.json');
    if (!fs.existsSync(projectsPath)) return;

    const count = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number | bigint }).c,
    );
    if (count > 0) return;

    const projectRows = readJson<Project[]>(projectsPath, []);
    const sprintRows = readJson<Sprint[]>(path.join(this.baseDir, 'sprints.json'), []);
    const taskRows = readJson<TaskSession[]>(path.join(this.baseDir, 'task_sessions.json'), []);
    const instanceRows = readJson<AgentInstanceRecord[]>(path.join(this.baseDir, 'agent_instances.json'), []);
    const queueRows = readJson<Array<[string, TaskQueueMessage[]]>>(path.join(this.baseDir, 'queues.json'), []);
    const approvalRows = readJson<PendingApprovalRecord[]>(path.join(this.baseDir, 'approvals.json'), []);

    const insertProject = this.db.prepare(
      'INSERT OR REPLACE INTO projects (id, payload) VALUES (?, ?)',
    );
    const insertSprint = this.db.prepare(
      'INSERT OR REPLACE INTO sprints (id, project_id, payload) VALUES (?, ?, ?)',
    );
    const insertTask = this.db.prepare(
      'INSERT OR REPLACE INTO task_sessions (id, project_id, payload) VALUES (?, ?, ?)',
    );
    const insertInstance = this.db.prepare(
      'INSERT OR REPLACE INTO agent_instances (id, task_session_id, payload) VALUES (?, ?, ?)',
    );
    const insertQueue = this.db.prepare(
      'INSERT OR REPLACE INTO queues (queue_key, payload) VALUES (?, ?)',
    );
    const insertApproval = this.db.prepare(
      'INSERT OR REPLACE INTO approvals (id, task_session_id, status, payload) VALUES (?, ?, ?, ?)',
    );

    this.runInTransaction(() => {
      for (const p of projectRows) insertProject.run(p.id, JSON.stringify(p));
      for (const s of sprintRows) insertSprint.run(s.id, s.projectId, JSON.stringify(s));
      for (const t of taskRows) insertTask.run(t.id, t.projectId, JSON.stringify(t));
      for (const a of instanceRows) insertInstance.run(a.id, a.taskSessionId, JSON.stringify(a));
      for (const [queueKey, messages] of queueRows) {
        insertQueue.run(queueKey, JSON.stringify(messages));
      }
      for (const ap of approvalRows) {
        insertApproval.run(ap.id, ap.taskSessionId, ap.status, JSON.stringify(ap));
      }
    });

    for (const name of [
      'projects.json',
      'sprints.json',
      'task_sessions.json',
      'agent_instances.json',
      'queues.json',
      'approvals.json',
    ]) {
      const fp = path.join(this.baseDir, name);
      if (fs.existsSync(fp)) {
        try {
          fs.renameSync(fp, `${fp}.migrated.bak`);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private loadFromDb(): void {
    this.projects.clear();
    this.sprints.clear();
    this.taskSessions.clear();
    this.agentInstances.clear();
    this.queues.clear();
    this.approvals.clear();
    this.coverageMap.clear();

    for (const row of this.db.prepare('SELECT id, payload FROM projects').all() as { id: string; payload: string }[]) {
      this.projects.set(row.id, JSON.parse(row.payload) as Project);
    }
    for (const row of this.db.prepare('SELECT id, payload FROM sprints').all() as { id: string; payload: string }[]) {
      this.sprints.set(row.id, JSON.parse(row.payload) as Sprint);
    }
    for (const row of this.db.prepare('SELECT id, payload FROM task_sessions').all() as { id: string; payload: string }[]) {
      this.taskSessions.set(row.id, JSON.parse(row.payload) as TaskSession);
    }
    for (const row of this.db.prepare('SELECT id, payload FROM agent_instances').all() as { id: string; payload: string }[]) {
      this.agentInstances.set(row.id, JSON.parse(row.payload) as AgentInstanceRecord);
    }
    for (const row of this.db.prepare('SELECT queue_key, payload FROM queues').all() as {
      queue_key: string;
      payload: string;
    }[]) {
      this.queues.set(row.queue_key, JSON.parse(row.payload) as TaskQueueMessage[]);
    }
    for (const row of this.db.prepare('SELECT id, payload FROM approvals').all() as { id: string; payload: string }[]) {
      this.approvals.set(row.id, JSON.parse(row.payload) as PendingApprovalRecord);
    }
    for (const row of this.db.prepare('SELECT project_id, coverage, updated_at FROM project_coverage').all() as { project_id: string; coverage: number; updated_at: string }[]) {
      this.coverageMap.set(row.project_id, { projectId: row.project_id, coverage: row.coverage, updatedAt: row.updated_at });
    }
  }

  private persistProjects(): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO projects (id, payload) VALUES (?, ?)');
    this.runInTransaction(() => {
      for (const p of this.projects.values()) stmt.run(p.id, JSON.stringify(p));
    });
    this.pruneByIdColumn('projects', Array.from(this.projects.keys()));
  }

  private persistSprints(): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO sprints (id, project_id, payload) VALUES (?, ?, ?)',
    );
    this.runInTransaction(() => {
      for (const s of this.sprints.values()) stmt.run(s.id, s.projectId, JSON.stringify(s));
    });
    this.pruneByIdColumn('sprints', Array.from(this.sprints.keys()));
  }

  private persistTaskSessions(): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO task_sessions (id, project_id, payload) VALUES (?, ?, ?)',
    );
    this.runInTransaction(() => {
      for (const t of this.taskSessions.values()) stmt.run(t.id, t.projectId, JSON.stringify(t));
    });
    this.pruneByIdColumn('task_sessions', Array.from(this.taskSessions.keys()));
  }

  private persistAgentInstances(): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO agent_instances (id, task_session_id, payload) VALUES (?, ?, ?)',
    );
    this.runInTransaction(() => {
      for (const a of this.agentInstances.values()) stmt.run(a.id, a.taskSessionId, JSON.stringify(a));
    });
    this.pruneByIdColumn('agent_instances', Array.from(this.agentInstances.keys()));
  }

  private persistQueues(): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO queues (queue_key, payload) VALUES (?, ?)');
    this.runInTransaction(() => {
      for (const [queueKey, messages] of this.queues.entries()) {
        stmt.run(queueKey, JSON.stringify(messages));
      }
    });
    const keys = Array.from(this.queues.keys());
    if (keys.length === 0) {
      this.db.prepare('DELETE FROM queues').run();
      return;
    }
    const placeholders = keys.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM queues WHERE queue_key NOT IN (${placeholders})`).run(...keys);
  }

  private persistApprovals(): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO approvals (id, task_session_id, status, payload) VALUES (?, ?, ?, ?)',
    );
    this.runInTransaction(() => {
      for (const a of this.approvals.values()) {
        stmt.run(a.id, a.taskSessionId, a.status, JSON.stringify(a));
      }
    });
    this.pruneByIdColumn('approvals', Array.from(this.approvals.keys()));
  }

  private pruneByIdColumn(table: 'projects' | 'sprints' | 'task_sessions' | 'agent_instances' | 'approvals', keepIds: string[]): void {
    if (keepIds.length === 0) {
      this.db.prepare(`DELETE FROM ${table}`).run();
      return;
    }
    const placeholders = keepIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM ${table} WHERE id NOT IN (${placeholders})`).run(...keepIds);
  }

  listProjects(): Project[] {
    return Array.from(this.projects.values());
  }

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  upsertProject(project: Project): Project {
    assertValidLocalRepositoryPath(project.repository.localPath);

    const existing = this.projects.get(project.id);
    const nextProject: Project = {
      ...project,
      createdAt: existing?.createdAt ?? project.createdAt ?? now(),
      updatedAt: now(),
    };
    if (!nextProject.issueIdPrefix?.trim()) {
      delete nextProject.issueIdPrefix;
    }
    this.projects.set(project.id, nextProject);
    this.persistProjects();
    return nextProject;
  }

  removeProject(projectId: string): { ok: true } | { ok: false; error: string } {
    if (!this.projects.has(projectId)) {
      return { ok: false, error: `Project not found: ${projectId}` };
    }
    const sprintCount = this.listSprints(projectId).length;
    const taskCount = this.listTaskSessions(projectId).length;
    if (sprintCount > 0 || taskCount > 0) {
      return {
        ok: false,
        error: `Cannot delete project: ${sprintCount} sprint(s) and ${taskCount} task session(s) still reference it. Remove or reassign them first.`,
      };
    }
    this.projects.delete(projectId);
    this.persistProjects();
    return { ok: true };
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

  getTaskSessionByProjectIssueId(projectId: string, issueId: string): TaskSession | null {
    for (const session of this.taskSessions.values()) {
      if (session.projectId === projectId && session.issueId === issueId) return session;
    }
    return null;
  }

  previewNextIssueId(projectId: string): string {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const prefix = resolveIssueIdPrefix(project);
    return allocateNextIssueId(projectId, prefix, (pid) =>
      this.listTaskSessions(pid).map((t) => t.issueId),
    );
  }

  upsertTaskSession(taskSession: TaskSession): TaskSession {
    const existing = this.taskSessions.get(taskSession.id);
    let nextTaskSession: TaskSession = {
      ...taskSession,
      createdAt: existing?.createdAt ?? taskSession.createdAt ?? now(),
      updatedAt: now(),
    };
    if (existing && existing.workflowState !== nextTaskSession.workflowState) {
      nextTaskSession = {
        ...nextTaskSession,
        confirmationLoopCount: 0,
      };
    }
    this.taskSessions.set(nextTaskSession.id, nextTaskSession);
    this.persistTaskSessions();
    return nextTaskSession;
  }

  /**
   * Remove a task session and related queues, instances, approvals, monitor rows, and sprint link.
   * Caller should stop/delete agent instances first.
   */
  removeTaskSession(taskSessionId: string): void {
    const task = this.getTaskSession(taskSessionId);
    if (!task) return;

    const sprint = this.getSprint(task.sprintId);
    if (sprint?.taskIds.includes(task.id)) {
      this.upsertSprint({
        ...sprint,
        taskIds: sprint.taskIds.filter((tid) => tid !== task.id),
      });
    }

    this.queues.delete(task.messageQueueKey);
    this.persistQueues();

    for (const id of Array.from(this.approvals.keys())) {
      const a = this.approvals.get(id);
      if (a?.taskSessionId === taskSessionId) {
        this.approvals.delete(id);
      }
    }
    this.persistApprovals();

    this.db.prepare('DELETE FROM kanban_agent_turns WHERE task_session_id = ?').run(taskSessionId);

    for (const inst of this.listAgentInstances(taskSessionId)) {
      this.agentInstances.delete(inst.id);
    }
    this.persistAgentInstances();

    this.taskSessions.delete(taskSessionId);
    this.persistTaskSessions();
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
    scheduleConversationEntryTelegram(session.issueId, nextEntry);
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

  insertKanbanAgentTurn(record: KanbanAgentTurnRecord): KanbanAgentTurnRecord {
    this.db
      .prepare(
        `INSERT INTO kanban_agent_turns (
          id, project_id, task_session_id, task_id, created_at,
          source_agent, target_agent, source_agent_response, target_agent_prompt, stream_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.taskSessionId,
        record.taskId,
        record.createdAt,
        record.sourceAgent,
        record.targetAgent,
        record.sourceAgentResponse,
        record.targetAgentPrompt,
        record.streamError ?? null,
      );
    return record;
  }

  /** Called after `streamChat` completes; records stream failure if any. */
  updateKanbanAgentTurnStreamError(id: string, streamError: string | null): void {
    this.db
      .prepare('UPDATE kanban_agent_turns SET stream_error = ? WHERE id = ?')
      .run(streamError, id);
  }

  getKanbanAgentTurn(id: string): KanbanAgentTurnRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_session_id, task_id, created_at,
          source_agent, target_agent, source_agent_response, target_agent_prompt, stream_error
        FROM kanban_agent_turns WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          project_id: string;
          task_session_id: string;
          task_id: string;
          created_at: string;
          source_agent: string;
          target_agent: string;
          source_agent_response: string;
          target_agent_prompt: string;
          stream_error: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      taskSessionId: row.task_session_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      sourceAgent: row.source_agent,
      targetAgent: row.target_agent,
      sourceAgentResponse: row.source_agent_response,
      targetAgentPrompt: row.target_agent_prompt,
      streamError: row.stream_error ?? undefined,
    };
  }

  listKanbanAgentTurns(filters: {
    projectId?: string;
    taskId?: string;
    taskSessionId?: string;
    limit?: number;
    offset?: number;
  }): { rows: KanbanAgentTurnRecord[]; total: number } {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.projectId) {
      clauses.push('project_id = ?');
      params.push(filters.projectId);
    }
    if (filters.taskId) {
      clauses.push('task_id = ?');
      params.push(filters.taskId);
    }
    if (filters.taskSessionId) {
      clauses.push('task_session_id = ?');
      params.push(filters.taskSessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db.prepare(`SELECT COUNT(*) AS c FROM kanban_agent_turns ${where}`).get(...params) as {
      c: number | bigint;
    };
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_session_id, task_id, created_at,
          source_agent, target_agent, source_agent_response, target_agent_prompt, stream_error
        FROM kanban_agent_turns ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      id: string;
      project_id: string;
      task_session_id: string;
      task_id: string;
      created_at: string;
      source_agent: string;
      target_agent: string;
      source_agent_response: string;
      target_agent_prompt: string;
      stream_error: string | null;
    }>;
    return {
      total: Number(countRow.c),
      rows: rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        taskSessionId: row.task_session_id,
        taskId: row.task_id,
        createdAt: row.created_at,
        sourceAgent: row.source_agent,
        targetAgent: row.target_agent,
        sourceAgentResponse: row.source_agent_response,
        targetAgentPrompt: row.target_agent_prompt,
        streamError: row.stream_error ?? undefined,
      })),
    };
  }

  // ─── Project Coverage ──────────────────────────────────────────────────────

  /**
   * Returns the coverage record for a project. Defaults to coverage=0 if not yet set.
   */
  getProjectCoverage(projectId: string): ProjectCoverageRecord {
    return (
      this.coverageMap.get(projectId) ?? {
        projectId,
        coverage: 0,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  /**
   * Updates the project's coverage only when `newCoverage > current`.
   * Returns whether an update was performed and the new current value.
   * Also appends an entry to the coverage history regardless of whether the max was updated.
   */
  updateProjectCoverage(
    projectId: string,
    newCoverage: number,
    context?: string,
  ): { updated: boolean; coverage: number } {
    const current = this.getProjectCoverage(projectId);
    const ts = now();
    // Always record history (even if this run is lower than current max)
    const historyId = crypto.randomUUID();
    this.db
      .prepare(
        'INSERT INTO project_coverage_history (id, project_id, coverage, context, recorded_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(historyId, projectId, newCoverage, context ?? null, ts);

    if (newCoverage <= current.coverage) {
      return { updated: false, coverage: current.coverage };
    }
    const record: ProjectCoverageRecord = {
      projectId,
      coverage: newCoverage,
      updatedAt: ts,
    };
    this.coverageMap.set(projectId, record);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO project_coverage (project_id, coverage, updated_at) VALUES (?, ?, ?)',
      )
      .run(projectId, newCoverage, ts);
    return { updated: true, coverage: newCoverage };
  }

  /**
   * Returns the most-recent N coverage history entries for a project (descending by recorded_at).
   */
  getCoverageHistory(projectId: string, limit = 20): ProjectCoverageHistoryEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, project_id, coverage, context, recorded_at FROM project_coverage_history WHERE project_id = ? ORDER BY recorded_at DESC LIMIT ?',
      )
      .all(projectId, limit) as {
      id: string;
      project_id: string;
      coverage: number;
      context: string | null;
      recorded_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      coverage: r.coverage,
      context: r.context ?? undefined,
      recordedAt: r.recorded_at,
    }));
  }
}
