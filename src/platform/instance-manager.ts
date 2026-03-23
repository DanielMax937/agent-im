import type { LLMProvider, PermissionResolution } from '../lib/bridge/host';
import { PendingPermissions } from '../permission-gateway';
import { resolveProvider } from '../runtime-provider';
import { JsonPlatformStore } from './json-platform-store';
import { JiraAdapter, type JiraApiClient } from './jira-adapter';
import { buildRolePrompt } from './prompts';
import { consumeAgentStream } from './stream-consumer';
import type { AgentInstanceRecord, AgentRuntime, TaskConversationEntry } from './types';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProviderFactory {
  (runtime: AgentRuntime, pendingPermissions: PendingPermissions): Promise<LLMProvider>;
}

export interface JiraClientFactory {
  (instance: AgentInstanceRecord): JiraApiClient | undefined;
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
  jiraClientFactory?: JiraClientFactory;
  approvalBaseUrl?: string;
}

class TaskAgentRunner implements ManagedRunner {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pendingPermissions = new PendingPermissions();
  private adapter: JiraAdapter | null = null;
  private provider: LLMProvider | null = null;

  constructor(
    private readonly store: JsonPlatformStore,
    private readonly instanceId: string,
    private readonly providerFactory: ProviderFactory,
    private readonly jiraClientFactory?: JiraClientFactory,
    private readonly approvalBaseUrl?: string,
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
    this.provider = await this.providerFactory(instance.runtime, this.pendingPermissions);
    this.adapter = new JiraAdapter(
      {
        instanceId: instance.id,
        issueId: instance.jira.issueId,
        baseUrl: instance.jira.baseUrl,
        email: instance.jira.email,
        apiToken: instance.jira.apiToken,
        pollIntervalMs: instance.jira.pollIntervalMs,
        botAccountId: instance.jira.botAccountId,
      },
      this.jiraClientFactory?.(instance),
    );

    this.running = true;
    this.updateInstance({
      status: 'running',
      startedAt: new Date().toISOString(),
      lastError: undefined,
    });

    await this.adapter.start();
    this.loopPromise = this.runLoop().catch((error) => {
      this.updateInstance({
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.adapter?.stop();
    await this.loopPromise;
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
        await this.processPrompt(queueMessage.content, queueMessage.type === 'directive' ? 'workflow' : instance.role);
      }

      const inbound = await Promise.race([
        this.adapter?.consumeOne() ?? Promise.resolve(null),
        delay(750).then(() => null),
      ]);

      if (!inbound) continue;
      await this.processPrompt(inbound.text, 'jira');
    }
  }

  private async processPrompt(
    prompt: string,
    source: 'jira' | 'workflow' | AgentInstanceRecord['role'],
  ): Promise<void> {
    const instance = this.requireInstance();
    const taskSession = this.requireTaskSession(instance.taskSessionId);
    const project = this.requireProject(taskSession.projectId);
    const sprint = this.requireSprint(taskSession.sprintId);

    this.store.appendConversationEntry(taskSession.id, {
      role: 'user',
      source,
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

    const stream = this.provider!.streamChat({
      prompt,
      sessionId: currentTaskSession.sessionId,
      sdkSessionId: currentTaskSession.providerSessionId,
      systemPrompt,
      workingDirectory: instance.workingDirectory,
      conversationHistory,
    });

    const result = await consumeAgentStream(stream, {
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

        await this.adapter!.send({
          address: {
            channelType: this.adapter!.channelType,
            chatId: instance.jira.issueId,
          },
          text: [
            `Approval required for ${permission.toolName}.`,
            `Approval ID: ${permission.permissionRequestId}`,
            `Tool input: ${permission.toolInput}`,
            `Approve via POST ${this.getApprovalUrl(permission.permissionRequestId)}`,
          ].join('\n'),
          parseMode: 'plain',
        });
      },
    });

    const nextTaskSession = this.requireTaskSession(instance.taskSessionId);
    this.store.upsertTaskSession({
      ...nextTaskSession,
      providerSessionId: result.providerSessionId ?? nextTaskSession.providerSessionId,
      lastError: result.hasError ? result.errorMessage : undefined,
    });

    if (result.hasError) {
      await this.adapter!.send({
        address: {
          channelType: this.adapter!.channelType,
          chatId: instance.jira.issueId,
        },
        text: `Runtime error: ${result.errorMessage}`,
        parseMode: 'plain',
      });
      return;
    }

    if (!result.responseText) return;

    this.store.appendConversationEntry(nextTaskSession.id, {
      role: 'assistant',
      source: instance.role,
      content: result.responseText,
    });

    await this.adapter!.send({
      address: {
        channelType: this.adapter!.channelType,
        chatId: instance.jira.issueId,
      },
      text: result.responseText,
      parseMode: 'plain',
    });
  }

  private getApprovalUrl(permissionRequestId: string): string {
    const baseUrl = this.approvalBaseUrl?.replace(/\/$/, '') || '';
    return `${baseUrl}/api/approvals/${permissionRequestId}`;
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
      ((runtime, pendingPermissions) =>
        resolveProvider({
          config: {
            runtime,
            autoApprove: false,
          },
          pendingPermissions,
          runtimeOverride: runtime,
        }));
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

    const runner = existing ?? new TaskAgentRunner(
      this.deps.store,
      instanceId,
      this.providerFactory,
      this.deps.jiraClientFactory,
      this.deps.approvalBaseUrl,
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
