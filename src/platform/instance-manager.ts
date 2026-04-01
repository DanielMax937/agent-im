import crypto from 'node:crypto';

import type { LLMProvider, PermissionResolution } from '../lib/bridge/host';
import { loadConfig, normalizeRunners, resolveRuntimeForPlatformInstance } from '../config';
import { PendingPermissions } from '../permission-gateway';
import { resolveProvider } from '../runtime-provider';
import {
  buildKanbanMonitorTurnRecord,
  formatKanbanAgentFullPrompt,
} from './kanban-agent-turn';
import { JsonPlatformStore } from './json-platform-store';
import { notifyKanbanTelegram } from './kanban-notify';
import { buildRolePrompt } from './prompts';
import { consumeAgentStream, type StreamConsumeResult } from './stream-consumer';
import type {
  AgentInstanceRecord,
  AgentRole,
  TaskConversationEntry,
  TaskQueueMessage,
} from './types';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default 5 minutes per stream read. Set `CTI_KANBAN_STREAM_TIMEOUT_MS=0` to disable (no timeout). */
function kanbanStreamTimeoutMs(): number {
  const raw = process.env.CTI_KANBAN_STREAM_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 300_000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 300_000;
  if (n <= 0) return 0;
  return n;
}

/** Retries after a timed-out attempt (default 3 → 4 attempts total including the first). */
function kanbanStreamTimeoutRetries(): number {
  const raw = process.env.CTI_KANBAN_STREAM_TIMEOUT_RETRIES;
  if (raw === undefined || raw === '') return 3;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function notifyKanbanSideChannel(issueId: string, text: string): void {
  void notifyKanbanTelegram(`[Kanban][${issueId}] ${text}`);
}

export interface ProviderFactory {
  (instance: AgentInstanceRecord, pendingPermissions: PendingPermissions): Promise<LLMProvider>;
}

interface ManagedRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  resolveApproval(permissionRequestId: string, resolution: PermissionResolution): boolean;
}

interface InstanceManagerDeps {
  store: JsonPlatformStore;
  providerFactory?: ProviderFactory;
  /** Invoked after a successful assistant turn (conversation entry persisted). */
  onAgentTurnComplete?: (
    taskSessionId: string,
    role: AgentRole,
    instanceId: string,
  ) => Promise<void>;
}

class TaskAgentRunner implements ManagedRunner {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private provider: LLMProvider | null = null;
  private readonly pendingPermissions = new PendingPermissions();

  constructor(
    private readonly store: JsonPlatformStore,
    private readonly instanceId: string,
    private readonly providerFactory: ProviderFactory,
    private readonly onAgentTurnComplete?: InstanceManagerDeps['onAgentTurnComplete'],
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  resolveApproval(permissionRequestId: string, resolution: PermissionResolution): boolean {
    return this.pendingPermissions.resolve(permissionRequestId, resolution);
  }

  async start(): Promise<void> {
    if (this.running) return;

    const instance = this.requireInstance();
    this.provider = await this.providerFactory(instance, this.pendingPermissions);

    this.running = true;
    this.updateInstance({
      status: 'running',
      startedAt: new Date().toISOString(),
      lastError: undefined,
    });

    this.loopPromise = this.runLoop().catch((error) => {
      this.updateInstanceIfPresent({
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loopPromise;
    this.provider = null;
    this.updateInstanceIfPresent({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const instance = this.requireInstance();
      const taskSession = this.requireTaskSession(instance.taskSessionId);

      const queuedMessages = this.store.drainTaskQueue(taskSession.messageQueueKey);
      for (const queueMessage of queuedMessages) {
        const assistantTurn = await this.processPrompt(queueMessage.content, queueMessage);
        if (assistantTurn && this.onAgentTurnComplete) {
          await this.onAgentTurnComplete(instance.taskSessionId, instance.role, instance.id);
        }
      }

      await delay(750);
    }
  }

  private async processPrompt(prompt: string, queueMessage: TaskQueueMessage): Promise<boolean> {
    const instance = this.requireInstance();
    const taskSession = this.requireTaskSession(instance.taskSessionId);
    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);

    const historyBeforeUser = [...taskSession.conversationHistory];

    const userLineSource: TaskConversationEntry['source'] =
      queueMessage.type === 'human_followup'
        ? 'human'
        : queueMessage.type === 'directive' || queueMessage.type === 'system_check'
          ? 'workflow'
          : instance.role;

    this.store.appendConversationEntry(taskSession.id, {
      role: 'user',
      source: userLineSource,
      content: prompt,
    });

    const currentTaskSession = this.requireTaskSession(instance.taskSessionId);
    const systemPrompt = [
      buildRolePrompt({
        role: instance.role,
        project,
        sprint,
        taskSession: currentTaskSession,
      }),
      currentTaskSession.systemPrompt,
    ].filter(Boolean).join('\n\n');

    const conversationHistory = currentTaskSession.conversationHistory
      .filter(
        (entry): entry is TaskConversationEntry & { role: 'user' | 'assistant' } =>
          entry.role === 'user' || entry.role === 'assistant',
      )
      .map((entry) => ({ role: entry.role, content: entry.content }));

    const targetAgentPrompt = formatKanbanAgentFullPrompt({
      systemPrompt,
      conversationHistory,
      userPrompt: prompt,
    });
    const { sourceAgent, sourceAgentResponse, targetAgent } = buildKanbanMonitorTurnRecord({
      queueMessage,
      taskSession,
      instanceRole: instance.role,
      runtime: instance.runtime,
      historyBeforeUser,
    });
    const turnId = crypto.randomUUID();
    const turnCreatedAt = new Date().toISOString();

    this.store.insertKanbanAgentTurn({
      id: turnId,
      projectId: taskSession.projectId,
      taskSessionId: taskSession.id,
      taskId: taskSession.issueId,
      createdAt: turnCreatedAt,
      sourceAgent,
      targetAgent,
      sourceAgentResponse,
      targetAgentPrompt,
    });

    const timeoutMs = kanbanStreamTimeoutMs();
    const maxAttempts = 1 + kanbanStreamTimeoutRetries();
    let result!: StreamConsumeResult;

    this.updateInstance({ generating: true });
    try {
      let attempt = 0;
      while (true) {
        attempt += 1;
        const stream = this.provider!.streamChat({
          prompt,
          sessionId: currentTaskSession.sessionId,
          sdkSessionId: currentTaskSession.providerSessionId,
          systemPrompt,
          workingDirectory: instance.workingDirectory,
          conversationHistory,
        });

        try {
          result = await consumeAgentStream(stream, {
            ...(timeoutMs > 0 ? { timeoutMs } : {}),
            onPermissionRequest: async (permission) => {
              this.store.savePendingApproval({
                id: permission.permissionRequestId,
                instanceId: instance.id,
                taskId: currentTaskSession.taskId,
                taskSessionId: currentTaskSession.id,
                toolName: permission.toolName,
                toolInput: permission.toolInput,
                queueKey: currentTaskSession.approvalQueueKey,
                status: 'pending',
                createdAt: new Date().toISOString(),
              });

              notifyKanbanSideChannel(
                currentTaskSession.issueId,
                [
                  `Approval required for ${permission.toolName}.`,
                  `Approval ID: ${permission.permissionRequestId}`,
                  `Tool input: ${permission.toolInput}`,
                  `Approve via POST ${this.getApprovalUrl(permission.permissionRequestId)}`,
                ].join('\n'),
              );
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.store.updateKanbanAgentTurnStreamError(turnId, msg);
          throw e;
        }

        if (!result.timedOut) {
          break;
        }

        this.store.updateKanbanAgentTurnStreamError(
          turnId,
          `Stream timed out (attempt ${attempt}/${maxAttempts}, limit ${timeoutMs}ms): ${result.errorMessage}`,
        );

        if (attempt < maxAttempts) {
          notifyKanbanSideChannel(
            currentTaskSession.issueId,
            [
              `Agent stream timed out (${attempt}/${maxAttempts}, ${Math.round(timeoutMs / 1000)}s per attempt).`,
              `Queue message: ${queueMessage.type}. Retrying…`,
            ].join(' '),
          );
          continue;
        }

        const manualMsg = [
          `Agent stream timed out after ${maxAttempts} attempt(s) (${Math.round(timeoutMs / 1000)}s each).`,
          `Role: ${instance.role}; queue: ${queueMessage.type}.`,
          'Please handle manually: check the runner, approvals, or network; use the board to enqueue a follow-up or restart the instance.',
        ].join(' ');
        notifyKanbanSideChannel(currentTaskSession.issueId, manualMsg);
        this.store.appendConversationEntry(currentTaskSession.id, {
          role: 'system',
          source: 'workflow',
          content: manualMsg,
        });
        const taskAfterTimeout = this.requireTaskSession(currentTaskSession.id);
        this.store.upsertTaskSession({
          ...taskAfterTimeout,
          lastError: manualMsg,
          updatedAt: new Date().toISOString(),
        });
        this.store.updateKanbanAgentTurnStreamError(turnId, result.errorMessage);
        return false;
      }
    } finally {
      this.updateInstance({ generating: false });
    }

    const nextTaskSession = this.requireTaskSession(instance.taskSessionId);
    this.store.upsertTaskSession({
      ...nextTaskSession,
      providerSessionId: result.providerSessionId ?? nextTaskSession.providerSessionId,
      lastError: result.hasError ? result.errorMessage : undefined,
    });

    this.store.updateKanbanAgentTurnStreamError(
      turnId,
      result.hasError ? (result.errorMessage.trim() ? result.errorMessage : 'Unknown runtime error') : null,
    );

    if (result.hasError) {
      notifyKanbanSideChannel(currentTaskSession.issueId, `Runtime error: ${result.errorMessage}`);
      return false;
    }

    if (!result.responseText) return false;

    this.store.appendConversationEntry(nextTaskSession.id, {
      role: 'assistant',
      source: instance.role,
      content: result.responseText,
    });
    return true;
  }

  private getApprovalUrl(permissionRequestId: string): string {
    return `/api/approvals/${permissionRequestId}`;
  }

  private requireInstance(): AgentInstanceRecord {
    const instance = this.store.getAgentInstance(this.instanceId);
    if (!instance) {
      throw new Error(`Agent instance not found: ${this.instanceId}`);
    }
    return instance;
  }

  private requireTaskSession(taskSessionId: string) {
    const taskSession = this.store.getTaskSession(taskSessionId);
    if (!taskSession) {
      throw new Error(`Task session not found: ${taskSessionId}`);
    }
    return taskSession;
  }

  private requireProject(projectId: string) {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private requireSprint(sprintId: string) {
    const sprint = this.store.getSprint(sprintId);
    if (!sprint) {
      throw new Error(`Sprint not found: ${sprintId}`);
    }
    return sprint;
  }

  private updateInstance(partial: Partial<AgentInstanceRecord>): void {
    const existing = this.requireInstance();
    this.store.upsertAgentInstance({
      ...existing,
      ...partial,
    });
  }

  private updateInstanceIfPresent(partial: Partial<AgentInstanceRecord>): void {
    const existing = this.store.getAgentInstance(this.instanceId);
    if (!existing) return;
    this.store.upsertAgentInstance({
      ...existing,
      ...partial,
    });
  }
}

export class InstanceManager {
  private static singleton: InstanceManager | null = null;
  private readonly runners = new Map<string, ManagedRunner>();
  private readonly providerFactory: ProviderFactory;

  private constructor(private readonly deps: InstanceManagerDeps) {
    this.providerFactory =
      deps.providerFactory ??
      ((instance, pendingPermissions) => {
        const config = loadConfig();
        const eff = resolveRuntimeForPlatformInstance(config, instance);
        const runner = instance.runtimeProfileId
          ? normalizeRunners(config).find((r) => r.id === instance.runtimeProfileId)
          : undefined;
        return resolveProvider({
          config,
          pendingPermissions,
          autoApproveOverride: false,
          runtimeOverride: eff,
          runner,
        });
      });
  }

  static getInstance(deps?: InstanceManagerDeps): InstanceManager {
    if (!InstanceManager.singleton) {
      if (!deps) throw new Error('InstanceManager must be initialized with dependencies');
      InstanceManager.singleton = new InstanceManager(deps);
    }
    return InstanceManager.singleton;
  }

  static resetForTests(): void {
    InstanceManager.singleton = null;
  }

  listRunningInstanceIds(): string[] {
    return Array.from(this.runners.keys());
  }

  async reconcile(): Promise<void> {
    const storedIds = new Set(this.deps.store.listAgentInstances().map((instance) => instance.id));

    for (const instance of this.deps.store.listAgentInstances()) {
      if (instance.status === 'running' || instance.status === 'starting') {
        await this.startInstance(instance.id);
      }
    }

    for (const runnerId of this.runners.keys()) {
      if (storedIds.has(runnerId)) continue;
      await this.stopInstance(runnerId);
    }
  }

  async upsertAndStart(instance: AgentInstanceRecord): Promise<AgentInstanceRecord> {
    const nextInstance = this.deps.store.upsertAgentInstance({
      ...instance,
      status: 'starting',
    });
    await this.startInstance(nextInstance.id);
    return this.deps.store.getAgentInstance(nextInstance.id)!;
  }

  async startInstance(instanceId: string): Promise<void> {
    const existing = this.runners.get(instanceId);
    if (existing?.isRunning()) return;

    const runner =
      existing ??
      new TaskAgentRunner(
        this.deps.store,
        instanceId,
        this.providerFactory,
        this.deps.onAgentTurnComplete,
      );
    this.runners.set(instanceId, runner);
    await runner.start();
  }

  async stopInstance(instanceId: string): Promise<void> {
    const runner = this.runners.get(instanceId);
    if (!runner) return;
    await runner.stop();
    this.runners.delete(instanceId);
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.stopInstance(instanceId);
    this.deps.store.removeAgentInstance(instanceId);
  }

  resolveApproval(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const approval = this.deps.store.getPendingApproval(permissionRequestId);
    if (!approval) return false;

    const runner = this.runners.get(approval.instanceId);
    if (!runner) return false;

    const resolved = runner.resolveApproval(permissionRequestId, resolution);
    if (!resolved) return false;

    this.deps.store.resolvePendingApproval(
      permissionRequestId,
      resolution.behavior === 'allow' ? 'approved' : 'denied',
      resolution.message,
    );
    return true;
  }
}
