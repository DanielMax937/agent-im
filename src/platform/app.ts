import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

import * as bridgeManager from '../lib/bridge/bridge-manager';
import {
  resolveLatestBridgeLogBasename,
  BRIDGE_LOG_LINES_DEFAULT,
  BRIDGE_LOG_LINES_MAX,
  readBridgeLogTail,
} from '../lib/bridge/bridge-log-file';
import {
  getBridgeStatusForApi,
  startBridgeDaemonChild,
  stopBridgeDaemonChild,
} from '../lib/bridge-app-child';
import { readBridgeDaemonDiskStatus } from '../lib/bridge-daemon-status';
import {
  getCtiHomeForBridgeSlug,
  getSlaveEnvPath,
  listBridgeSlugs,
  loadConfig,
  loadKanbanPlatformConfig,
  normalizeRunners,
  normalizeRunnersWithProcessEnvOverride,
  type RunnerConfig,
} from '../config';
import { readMonitorMessages, readRunnerStatusForMonitor } from '../lib/monitor-messages';
import { getLogger } from '../logger';
import { hasBridgeContext } from '../lib/bridge/context';
import type { FileAttachment, LLMProvider } from '../lib/bridge/host';
import { PendingPermissions } from '../permission-gateway';
import { resolveProvider } from '../runtime-provider';
import type {
  PendingApprovalRecord,
  Project,
  Sprint,
  TaskSession,
  AgentInstanceRecord,
  AgentRole,
  AsyncJobArtifactRecord,
  AsyncJobRecord,
  KanbanAgentKind,
  KanbanRoleMember,
  KanbanAgentTurnRecord,
  CloseTaskOptions,
} from './types';
import { defaultSkillLinesForLane } from './kanban-agents';
import { listSkillCatalogEntries } from './skill-catalog';
import { parseBoardBrainstormChatInput } from './board-brainstorm';
import { ensureVercelGitConnection, ensureVercelProjectLinked } from './vercel-cli';
import {
  answerKanbanTelegramCallbackQuery,
  parseKanbanPermCallbackData,
} from './kanban-notify';
import { ensureActiveSprintNameUniqueForProject, roleForActiveWorkflowState } from './workflow-service';
import {
  makeImageGenerationId,
  parseImagesGenerationsRequest,
  resolveImageGenerationProvider,
  type ImageGenerationProvider,
  type ImagesGenerationsRequest,
  type ParsedImagesGenerationsRequest,
} from '../imagegen-provider';

const KANBAN_ROLE_KINDS: KanbanAgentKind[] = [
  'agent-dev',
  'pre-tester',
  'codex-senior',
  'claude-review',
  'copilot-test',
];

/** Runner list JSON for Kanban / platform: never emit the literal `unknown` (legacy placeholder). */
function runnerRuntimeForJson(runtime: string | undefined): string {
  const t = (runtime ?? '').trim().toLowerCase();
  if (t === 'unknown') return '';
  return (runtime ?? '').trim();
}

/** Runner ids referenced by saved kanban mapping/members but missing from the effective runner list (e.g. after config shrink). */
function collectKanbanReferencedRunnerIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const mapping = project.kanbanRoleRunners;
  if (mapping) {
    for (const k of KANBAN_ROLE_KINDS) {
      const v = mapping[k]?.trim();
      if (v) ids.add(v);
    }
  }
  const members = project.kanbanRoleMembers;
  if (members) {
    for (const k of KANBAN_ROLE_KINDS) {
      const list = members[k];
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        const pid = m.runnerProfileId?.trim();
        if (pid) ids.add(pid);
      }
    }
  }
  return ids;
}

function mergeRunnersWithProjectReferences(
  cfgRunners: { id: string; label: string; runtime: string }[],
  project: Project,
): { id: string; label: string; runtime: string }[] {
  const byId = new Map(cfgRunners.map((r) => [r.id, r]));
  for (const id of collectKanbanReferencedRunnerIds(project)) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: `${id}（未在当前 runner 配置中）`,
        runtime: '',
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function parseKanbanRoleRunnersInput(raw: unknown): Partial<Record<KanbanAgentKind, string>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Partial<Record<KanbanAgentKind, string>> = {};
  for (const kind of KANBAN_ROLE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) return null;
    out[kind] = v.trim();
  }
  return out;
}

function parseKanbanRoleMembersInput(raw: unknown): Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> = {};
  for (const kind of KANBAN_ROLE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return null;
    const members: KanbanRoleMember[] = [];
    for (const row of v) {
      if (typeof row !== 'object' || row === null) return null;
      const r = row as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      const runnerProfileId = typeof r.runnerProfileId === 'string' ? r.runnerProfileId.trim() : '';
      if (!id || !runnerProfileId) return null;
      members.push({ id, name: name || id, runnerProfileId });
    }
    out[kind] = members;
  }
  return out;
}

function enrichTaskSessionForApi(store: PlatformStoreApi, task: TaskSession): TaskSession {
  const role = roleForActiveWorkflowState(task.workflowState);
  if (!role) {
    return { ...task, agentGenerating: false };
  }
  const inst = store.listAgentInstances(task.id).find((i) => i.role === role);
  return {
    ...task,
    agentGenerating: inst?.generating === true,
  };
}

export interface PlatformStoreApi {
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  upsertProject(project: Project): Project;
  removeProject(projectId: string): { ok: true } | { ok: false; error: string };
  previewNextIssueId(projectId: string): string;
  getTaskSessionByProjectIssueId(projectId: string, issueId: string): TaskSession | null;
  listSprints(projectId?: string): Sprint[];
  getSprint(sprintId: string): Sprint | null;
  upsertSprint(sprint: Sprint): Sprint;
  removeSprint(sprintId: string): { ok: true } | { ok: false; error: string };
  listTaskSessions(projectId?: string): TaskSession[];
  getTaskSession(taskSessionId: string): TaskSession | null;
  listAgentInstances(taskSessionId?: string): AgentInstanceRecord[];
  getAgentInstance(instanceId: string): AgentInstanceRecord | null;
  listPendingApprovals(taskSessionId?: string): PendingApprovalRecord[];
  getPendingApproval(approvalId: string): PendingApprovalRecord | null;
  listKanbanAgentTurns(filters: {
    projectId?: string;
    taskId?: string;
    taskSessionId?: string;
    limit?: number;
    offset?: number;
  }): { rows: KanbanAgentTurnRecord[]; total: number };
  getKanbanAgentTurn(id: string): KanbanAgentTurnRecord | null;
  updateKanbanAgentTurnStreamError(id: string, streamError: string | null): void;
  getProjectCoverage(projectId: string): import('./types').ProjectCoverageRecord;
  updateProjectCoverage(projectId: string, coverage: number, context?: string): { updated: boolean; coverage: number };
  getCoverageHistory(projectId: string, limit?: number): import('./types').ProjectCoverageHistoryEntry[];
  saveAsyncJob(record: AsyncJobRecord): AsyncJobRecord;
  getAsyncJob(jobId: string): AsyncJobRecord | null;
  saveAsyncJobArtifact(record: AsyncJobArtifactRecord): AsyncJobArtifactRecord;
  listAsyncJobArtifacts(jobId: string): AsyncJobArtifactRecord[];
  deleteAsyncJobArtifacts(jobId: string): void;
}

export interface WorkflowServiceApi {
  startSprint(input: unknown): Promise<Sprint>;
  deploySprint(sprintId: string): Promise<unknown>;
  bootstrapProjectFromRequirement(input: unknown): Promise<unknown>;
  createTask(input: unknown): Promise<TaskSession>;
  assignTask(input: unknown): Promise<TaskSession>;
  submitTaskForReview(input: {
    taskSessionId: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
  }): Promise<unknown>;
  startTesting(taskSessionId: string): Promise<TaskSession>;
  startFeatureTesting(taskSessionId: string): Promise<TaskSession>;
  startRegressionTesting(taskSessionId: string): Promise<TaskSession>;
  proceedToPendingRelease(taskSessionId: string): Promise<TaskSession>;
  refreshRegressionIfMasterAdvanced(taskSessionId: string): Promise<TaskSession>;
  rejectReview(taskSessionId: string, comment: string): Promise<TaskSession>;
  handleTestFailure(input: { taskSessionId: string; summary: string; log: string }): Promise<TaskSession>;
  closeTask(taskSessionId: string, deferStopInstanceId?: string, options?: CloseTaskOptions): Promise<TaskSession>;
  initiateCloseAsync(taskSessionId: string): Promise<TaskSession>;
  blockTask(taskSessionId: string, reason: string): Promise<TaskSession>;
  unblockTask(taskSessionId: string): Promise<TaskSession>;
  uatApprove(taskSessionId: string): Promise<TaskSession>;
  uatReject(taskSessionId: string, reason: string): Promise<TaskSession>;
  processCiCallback(
    taskSessionId: string,
    status: 'success' | 'failure',
    reason?: string,
    coverage?: number,
  ): Promise<TaskSession>;
  syncReviewCommentToPrAndTask(taskSessionId: string, body: string): Promise<void>;
  deleteTask(taskSessionId: string): Promise<void>;
  deleteTasks(filters?: { projectId?: string; sprintId?: string }): Promise<{ deletedTaskCount: number }>;
  resolveApproval(approvalId: string, input: unknown): boolean;
  getKanbanStatus(): unknown;
  ensureAgentInstance(
    taskSessionId: string,
    role: AgentRole,
    runtimeProfileId?: string,
  ): Promise<AgentInstanceRecord>;
  enqueueManualQueueMessage(taskSessionId: string, content: string): Promise<void>;
  addTaskHistoryComment(
    taskSessionId: string,
    input: { content: string; role?: AgentRole | null },
  ): Promise<TaskSession>;
  previewBatchTasksFromSpec(input: unknown): Promise<unknown>;
  createTasksFromBatchPlan(input: unknown): Promise<unknown>;
  streamBoardBrainstormChat(input: unknown): Promise<ReadableStream<string>>;
}

export interface InstanceManagerApi {
  listRunningInstanceIds(): string[];
  reconcile(): Promise<void>;
  startInstance(instanceId: string): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
  deleteInstance(instanceId: string): Promise<void>;
}

export interface CreatePlatformAppOptions {
  store: PlatformStoreApi;
  workflowService: WorkflowServiceApi;
  instanceManager: InstanceManagerApi;
  imageGenerationProvider?: ImageGenerationProvider;
}

export interface PlatformApp {
  handle(request: Request): Promise<Response>;
  listen(port: number, callback?: () => void): Server;
}

const DIRECTORY_STRUCTURE_PLAN = {
  src: {
    'main.ts': 'standalone bridge daemon entrypoint',
    'app': 'Next.js app router entrypoint for the web platform',
    platform: {
      'app.ts': 'native HTTP platform router shared by Next.js and tests',
      'json-platform-store.ts': 'SQLite persistence for projects, sprints, tasks, instances, approvals, and queues',
      'instance-manager.ts': 'singleton runtime registry and task runners (local queue)',
      'workflow-service.ts': 'state machine plus Git and PR automation',
      'compensation-service.ts': 'test failure feedback loop back to the developer agent',
      'prompts.ts': 'role-specific system prompts',
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

type ImageGenerationOutput = Awaited<ReturnType<ImageGenerationProvider['generate']>>;
const IMAGE_GENERATION_JOB_TYPE = 'image.generation';

function imageGenerationJobId(): string {
  return `imgjob-${crypto.randomUUID()}`;
}

function imageGenerationJobTimestamp(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function imageGenerationRequestPayload(input: ParsedImagesGenerationsRequest): Record<string, unknown> {
  return {
    model: input.model,
    prompt: input.prompt,
    n: input.n,
    size: input.size,
    response_format: input.responseFormat,
    input_image_count: input.inputImages.length,
    ...(input.user ? { user: input.user } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function createImageGenerationJob(store: PlatformStoreApi, input: ParsedImagesGenerationsRequest): AsyncJobRecord {
  const timestamp = new Date().toISOString();
  return store.saveAsyncJob({
    id: imageGenerationJobId(),
    type: IMAGE_GENERATION_JOB_TYPE,
    status: 'queued',
    request: imageGenerationRequestPayload(input),
    metadata: {
      model: input.model,
      response_format: input.responseFormat,
      input_image_count: input.inputImages.length,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function imageGenerationJobModel(job: AsyncJobRecord): string | undefined {
  const model = job.metadata?.model;
  return typeof model === 'string' ? model : undefined;
}

function imageGenerationJobResponse(job: AsyncJobRecord, artifacts: AsyncJobArtifactRecord[] = []): Record<string, unknown> {
  return {
    id: job.id,
    job_id: job.id,
    jobid: job.id,
    object: 'image.generation.job',
    type: job.type,
    status: job.status,
    created: imageGenerationJobTimestamp(job.createdAt),
    updated: imageGenerationJobTimestamp(job.updatedAt),
    model: imageGenerationJobModel(job),
    ...(job.startedAt ? { started: imageGenerationJobTimestamp(job.startedAt) } : {}),
    ...(job.completedAt ? { completed: imageGenerationJobTimestamp(job.completedAt) } : {}),
    ...(artifacts.length > 0
      ? {
          artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            type: artifact.type,
            name: artifact.name,
            mime_type: artifact.mimeType,
            storage_kind: artifact.storageKind,
            uri: artifact.uri,
            size_bytes: artifact.sizeBytes,
            metadata: artifact.metadata,
            created: imageGenerationJobTimestamp(artifact.createdAt),
          })),
        }
      : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function saveImageGenerationArtifacts(
  store: PlatformStoreApi,
  jobId: string,
  input: ParsedImagesGenerationsRequest,
  result: ImageGenerationOutput,
): void {
  store.deleteAsyncJobArtifacts(jobId);
  const artifactBaseTimeMs = Date.now();
  result.images.forEach((image, index) => {
    store.saveAsyncJobArtifact({
      id: `artifact-${crypto.randomUUID()}`,
      jobId,
      type: 'image',
      name: `image-${index + 1}`,
      mimeType: image.mime,
      storageKind: 'inline',
      sizeBytes: Buffer.byteLength(image.b64Json, 'base64'),
      payload: {
        b64_json: image.b64Json,
        revised_prompt: image.revisedPrompt ?? input.prompt,
        index,
      },
      metadata: {
        response_format: input.responseFormat,
      },
      createdAt: new Date(artifactBaseTimeMs + index).toISOString(),
    });
  });
}

function startImageGenerationJob(
  store: PlatformStoreApi,
  jobId: string,
  generate: () => Promise<{ response: Record<string, unknown>; output: ImageGenerationOutput; input: ParsedImagesGenerationsRequest }>,
): void {
  queueMicrotask(() => {
    const job = store.getAsyncJob(jobId);
    if (!job) return;
    const startedAt = new Date().toISOString();
    store.saveAsyncJob({
      ...job,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
    });

    void Promise.resolve()
      .then(generate)
      .then(({ response, output, input }) => {
        saveImageGenerationArtifacts(store, jobId, input, output);
        const latest = store.getAsyncJob(jobId);
        if (!latest) return;
        const completedAt = new Date().toISOString();
        store.saveAsyncJob({
          ...latest,
          status: 'succeeded',
          result: response,
          error: undefined,
          completedAt,
          updatedAt: completedAt,
        });
      })
      .catch((err) => {
        const latest = store.getAsyncJob(jobId);
        if (!latest) return;
        const completedAt = new Date().toISOString();
        store.saveAsyncJob({
          ...latest,
          status: 'failed',
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'upstream_error',
          },
          completedAt,
          updatedAt: completedAt,
        });
      });
  });
}

function buildImagesGenerationResponse(
  requestId: string,
  input: ParsedImagesGenerationsRequest,
  result: ImageGenerationOutput,
): Record<string, unknown> {
  return {
    id: requestId,
    object: 'image.generation',
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    data: result.images.map((image, index) => {
      const dataUrl = `data:${image.mime};base64,${image.b64Json}`;
      return {
        index,
        mime_type: image.mime,
        revised_prompt: image.revisedPrompt ?? input.prompt,
        ...(input.responseFormat === 'url'
          ? { url: dataUrl }
          : { b64_json: image.b64Json }),
      };
    }),
  };
}

function notFoundResponse(resource: string, id: string): Response {
  return jsonResponse({ error: `${resource} not found: ${id}` }, 404);
}

interface OpenAIContentTextPart {
  type: 'text';
  text: string;
}

interface OpenAIContentImagePart {
  type: 'image_url';
  image_url: { url: string };
}

type OpenAIContentPart = OpenAIContentTextPart | OpenAIContentImagePart;

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[];
}

interface OpenAIChatCompletionsRequest {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
  session_id?: string;
  working_directory?: string;
}

interface ParsedOpenAIPrompt {
  prompt: string;
  files: FileAttachment[];
}

interface ParsedOpenAIModel {
  provider: string;
  runtimeModel: string;
  key: string;
}

interface ApiSessionEnvelope {
  v: 1;
  provider: string;
  model: string;
  providerSessionId: string;
}

const API_SESSION_PREFIX = 'cti_';
const DEFAULT_OPENAI_COMPAT_MODEL = 'codex-login/gpt-5.5';
const apiProviderCache = new Map<string, Promise<LLMProvider>>();
const apiProviderPermissions = new PendingPermissions();
const apiSessionModelKeys = new Map<string, string>();

export function parseBase64DataUrl(url: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  const mime = match[1]?.toLowerCase() || 'image/png';
  const base64 = match[2]?.trim();
  if (!base64) return null;
  return { mime, base64 };
}

export function parseOpenAIMessagesAsPrompt(messages: OpenAIChatMessage[]): ParsedOpenAIPrompt {
  const files: FileAttachment[] = [];
  const lines: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      lines.push(`${msg.role.toUpperCase()}: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) {
      lines.push(`${msg.role.toUpperCase()}:`);
      continue;
    }

    const contentLines: string[] = [];
    for (const part of msg.content) {
      if (part.type === 'text') {
        contentLines.push(part.text);
        continue;
      }
      if (part.type === 'image_url') {
        const imageUrl = part.image_url?.url || '';
        const parsed = parseBase64DataUrl(imageUrl);
        if (parsed) {
          files.push({
            id: `img-${crypto.randomUUID()}`,
            name: `openai-image-${files.length + 1}`,
            type: parsed.mime,
            size: 0,
            data: parsed.base64,
          });
          contentLines.push(`[image_${files.length}: data-url attached]`);
        } else if (imageUrl) {
          contentLines.push(`[image_url: ${imageUrl}]`);
        }
      }
    }
    lines.push(`${msg.role.toUpperCase()}: ${contentLines.join('\n').trim()}`);
  }

  return { prompt: lines.join('\n\n').trim(), files };
}

export function parseOpenAIProviderModel(model: string | undefined): ParsedOpenAIModel | null {
  const raw = model?.trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const provider = raw.slice(0, slash).trim().toLowerCase();
  const runtimeModel = raw.slice(slash + 1).trim();
  if (!provider || !runtimeModel || runtimeModel.includes('\0')) return null;
  return {
    provider,
    runtimeModel,
    key: `${provider}/${runtimeModel}`,
  };
}

export function normalizeOpenAICompatModel(model: string | undefined): ParsedOpenAIModel | null {
  return parseOpenAIProviderModel(model?.trim() || DEFAULT_OPENAI_COMPAT_MODEL);
}

function encodeApiSessionId(session: ApiSessionEnvelope): string {
  return `${API_SESSION_PREFIX}${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
}

function decodeApiSessionId(sessionId: string | undefined): ApiSessionEnvelope | null {
  const raw = sessionId?.trim();
  if (!raw?.startsWith(API_SESSION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw.slice(API_SESSION_PREFIX.length), 'base64url').toString('utf8')) as
      Partial<ApiSessionEnvelope>;
    if (
      parsed.v !== 1 ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.providerSessionId !== 'string' ||
      !parsed.provider ||
      !parsed.model ||
      !parsed.providerSessionId
    ) {
      return null;
    }
    return {
      v: 1,
      provider: parsed.provider,
      model: parsed.model,
      providerSessionId: parsed.providerSessionId,
    };
  } catch {
    return null;
  }
}

function runnerForOpenAIProvider(provider: string, runners: RunnerConfig[]): RunnerConfig | null {
  const configured = runners.find((runner) => runner.id.toLowerCase() === provider);
  if (configured) return configured;

  if (provider === 'claude-login') return { id: provider, runtime: 'claude', claudeUseLogin: true };
  if (provider === 'claude') return { id: provider, runtime: 'claude', claudeUseLogin: false };
  if (provider === 'codex-login') return { id: provider, runtime: 'codex', codexUseLogin: true };
  if (provider === 'codex') return { id: provider, runtime: 'codex', codexUseLogin: false };
  if (provider === 'cursor') return { id: provider, runtime: 'cursor' };
  if (provider === 'copilot') return { id: provider, runtime: 'copilot' };
  if (provider === 'opencode') return { id: provider, runtime: 'opencode' };
  return null;
}

async function resolveOpenAIProvider(parsed: ParsedOpenAIModel): Promise<LLMProvider> {
  const cfg = loadKanbanPlatformConfig();
  const runners = normalizeRunners(cfg);
  const runner = runnerForOpenAIProvider(parsed.provider, runners);
  if (!runner) {
    throw new Error(`unknown provider: ${parsed.provider}`);
  }
  const cacheKey = JSON.stringify({
    provider: parsed.provider,
    runtime: runner.runtime,
    claudeUseLogin: runner.claudeUseLogin === true,
    codexUseLogin: runner.codexUseLogin === true,
    runnerId: runner.id,
  });
  let cached = apiProviderCache.get(cacheKey);
  if (!cached) {
    cached = resolveProvider({
      config: cfg,
      pendingPermissions: apiProviderPermissions,
      runtimeOverride: runner.runtime,
      runner: {
        ...runner,
        defaultModel: undefined,
        cursorDefaultModel: undefined,
      },
    });
    apiProviderCache.set(cacheKey, cached);
  }
  return cached;
}

function resolveProviderSessionIdForModel(inputSessionId: string | undefined, parsed: ParsedOpenAIModel): string | undefined {
  const raw = inputSessionId?.trim();
  if (!raw) return undefined;
  const envelope = decodeApiSessionId(raw);
  if (envelope) {
    if (`${envelope.provider}/${envelope.model}` !== parsed.key) return undefined;
    return envelope.providerSessionId;
  }
  const knownKey = apiSessionModelKeys.get(raw);
  if (knownKey && knownKey !== parsed.key) return undefined;
  return raw;
}

function parseSingleOpenAIMessageAsPrompt(message: OpenAIChatMessage): ParsedOpenAIPrompt {
  return parseOpenAIMessagesAsPrompt([message]);
}

function findLatestUserMessage(messages: OpenAIChatMessage[]): OpenAIChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string' && msg.content.trim()) return msg;
    if (Array.isArray(msg.content) && msg.content.length > 0) return msg;
  }
  return null;
}

function parseSSEPayload(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function sseTextPayload(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export async function collectProviderResponse(stream: ReadableStream<string>): Promise<{
  text: string;
  usage: { input: number; output: number };
  sessionId?: string;
  errors: string[];
}> {
  const reader = stream.getReader();
  let buffer = '';
  let text = '';
  let sessionId: string | undefined;
  const usage = { input: 0, output: 0 };
  const errors: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice('data:'.length).trim();
      let event: { type?: string; data?: unknown } | null = null;
      try {
        event = JSON.parse(raw) as { type?: string; data?: unknown };
      } catch {
        continue;
      }
      if (!event?.type) continue;
      if (event.type === 'text') {
        text += sseTextPayload(event.data);
        continue;
      }
      const payload = parseSSEPayload(event.data);
      if (event.type === 'result' && payload && typeof payload === 'object') {
        const result = payload as {
          session_id?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          is_error?: boolean;
        };
        if (result.session_id) sessionId = result.session_id;
        usage.input = Number(result.usage?.input_tokens ?? usage.input);
        usage.output = Number(result.usage?.output_tokens ?? usage.output);
        if (result.is_error) errors.push('upstream reported error');
        continue;
      }
      if (event.type === 'error') {
        errors.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
    }
  }

  return { text, usage, sessionId, errors };
}

interface OpenAIChatCompletionStreamOptions {
  requestId: string;
  modelKey: string;
  provider: string;
  runtimeModel: string;
  includeUsage?: boolean;
  created?: number;
  onSession?: (session: { providerSessionId: string; apiSessionId: string; modelKey: string }) => void;
}

function openAIStreamChunk(options: {
  requestId: string;
  created: number;
  modelKey: string;
  delta: { role?: 'assistant'; content?: string };
  finishReason: string | null;
  usage?: { input: number; output: number };
  apiSessionId?: string;
}): Record<string, unknown> {
  return {
    id: options.requestId,
    object: 'chat.completion.chunk',
    created: options.created,
    model: options.modelKey,
    choices: [
      {
        index: 0,
        delta: options.delta,
        finish_reason: options.finishReason,
      },
    ],
    ...(options.usage
      ? {
          usage: {
            prompt_tokens: options.usage.input,
            completion_tokens: options.usage.output,
            total_tokens: options.usage.input + options.usage.output,
          },
        }
      : {}),
    ...(options.apiSessionId
      ? { _session_id: options.apiSessionId, session_id: options.apiSessionId }
      : {}),
  };
}

export function createOpenAIChatCompletionStream(
  providerStream: ReadableStream<string>,
  options: OpenAIChatCompletionStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const created = options.created ?? Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = providerStream.getReader();
      let buffer = '';
      let apiSessionId: string | undefined;
      let providerSessionId: string | undefined;
      const usage = { input: 0, output: 0 };
      const errors: string[] = [];

      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const sendDone = () => {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      };
      const rememberSession = (nextProviderSessionId: string | undefined) => {
        if (!nextProviderSessionId || nextProviderSessionId === providerSessionId) return;
        providerSessionId = nextProviderSessionId;
        apiSessionId = encodeApiSessionId({
          v: 1,
          provider: options.provider,
          model: options.runtimeModel,
          providerSessionId,
        });
        options.onSession?.({
          providerSessionId,
          apiSessionId,
          modelKey: options.modelKey,
        });
      };
      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) return;
        const raw = trimmed.slice('data:'.length).trim();
        let event: { type?: string; data?: unknown } | null = null;
        try {
          event = JSON.parse(raw) as { type?: string; data?: unknown };
        } catch {
          return;
        }
        if (!event?.type) return;

        if (event.type === 'text') {
          const content = sseTextPayload(event.data);
          if (!content) return;
          send(openAIStreamChunk({
            requestId: options.requestId,
            created,
            modelKey: options.modelKey,
            delta: { content },
            finishReason: null,
          }));
          return;
        }

        const payload = parseSSEPayload(event.data);
        if ((event.type === 'result' || event.type === 'status') && payload && typeof payload === 'object') {
          const result = payload as {
            session_id?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
            is_error?: boolean;
          };
          rememberSession(result.session_id);
          usage.input = Number(result.usage?.input_tokens ?? usage.input);
          usage.output = Number(result.usage?.output_tokens ?? usage.output);
          if (result.is_error) errors.push('upstream reported error');
          return;
        }

        if (event.type === 'error') {
          const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
          errors.push(message);
          send({ error: { message, type: 'upstream_error' } });
        }
      };

      send(openAIStreamChunk({
        requestId: options.requestId,
        created,
        modelKey: options.modelKey,
        delta: { role: 'assistant' },
        finishReason: null,
      }));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) processLine(line);
        }
        if (buffer.trim()) processLine(buffer);

        send(openAIStreamChunk({
          requestId: options.requestId,
          created,
          modelKey: options.modelKey,
          delta: {},
          finishReason: errors.length > 0 ? 'length' : 'stop',
          usage: options.includeUsage ? usage : undefined,
          apiSessionId,
        }));
        sendDone();
      } catch (err) {
        send({
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'upstream_error',
          },
        });
        sendDone();
      } finally {
        controller.close();
      }
    },
  });
}

async function readRequestBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathnameParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathnameParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathnamePart = pathnameParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathnamePart);
      continue;
    }
    if (patternPart !== pathnamePart) {
      return null;
    }
  }
  return params;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host || '127.0.0.1';
  const url = new URL(request.url || '/', `http://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
      continue;
    }
    headers.set(key, value);
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.concat(
          await new Promise<Buffer[]>((resolve, reject) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            request.on('end', () => resolve(chunks));
            request.on('error', reject);
          }),
        );

  return new Request(url, {
    method: request.method,
    headers,
    body,
  });
}

async function writeNodeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  if (!result.body) {
    response.end();
    return;
  }
  const reader = result.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        response.write(Buffer.from(value));
      }
    }
  } finally {
    response.end();
  }
}

export function createPlatformApp(options: CreatePlatformAppOptions): PlatformApp {
  const logger = getLogger().child({ scope: 'platform-app' });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const requestLogger = logger.child({
      method: request.method,
      pathname,
    });

    try {
      if (request.method === 'GET' && pathname === '/health') {
        const mem = process.memoryUsage();
        return jsonResponse({
          ok: true,
          bridge: getBridgeStatusForApi(),
          runningInstances: options.instanceManager.listRunningInstanceIds(),
          rssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
        });
      }

      if (request.method === 'POST' && pathname === '/v1/images/generations/jobs') {
        const body = await readRequestBody<ImagesGenerationsRequest>(request);
        const parsed = parseImagesGenerationsRequest(body);
        if (!parsed.ok) {
          return jsonResponse(
            { error: { message: parsed.message, type: 'invalid_request_error' } },
            parsed.status,
          );
        }

        const job = createImageGenerationJob(options.store, parsed.value);
        const provider = options.imageGenerationProvider ?? resolveImageGenerationProvider();
        startImageGenerationJob(options.store, job.id, async () => {
          const requestId = makeImageGenerationId();
          const result = await provider.generate(parsed.value);
          return {
            response: buildImagesGenerationResponse(requestId, parsed.value, result),
            output: result,
            input: parsed.value,
          };
        });

        return jsonResponse(imageGenerationJobResponse(job), 202);
      }

      const imageGenerationJobParams = matchPath('/v1/images/generations/jobs/:jobId', pathname);
      if (request.method === 'GET' && imageGenerationJobParams) {
        const job = options.store.getAsyncJob(imageGenerationJobParams.jobId);
        if (!job) {
          return jsonResponse(
            {
              error: {
                message: `image generation job not found: ${imageGenerationJobParams.jobId}`,
                type: 'not_found_error',
              },
            },
            404,
          );
        }

        return jsonResponse(imageGenerationJobResponse(job, options.store.listAsyncJobArtifacts(job.id)));
      }

      if (request.method === 'POST' && pathname === '/v1/images/generations') {
        const body = await readRequestBody<ImagesGenerationsRequest>(request);
        const parsed = parseImagesGenerationsRequest(body);
        if (!parsed.ok) {
          return jsonResponse(
            { error: { message: parsed.message, type: 'invalid_request_error' } },
            parsed.status,
          );
        }

        const requestId = makeImageGenerationId();
        let result: ImageGenerationOutput;
        try {
          const provider = options.imageGenerationProvider ?? resolveImageGenerationProvider();
          result = await provider.generate(parsed.value);
        } catch (err) {
          return jsonResponse(
            {
              error: {
                message: err instanceof Error ? err.message : String(err),
                type: 'upstream_error',
              },
            },
            502,
          );
        }

        return jsonResponse(buildImagesGenerationResponse(requestId, parsed.value, result));
      }

      if (request.method === 'POST' && pathname === '/v1/chat/completions') {
        if (!hasBridgeContext()) {
          return jsonResponse(
            { error: { message: 'bridge context not initialized', type: 'server_error' } },
            503,
          );
        }
        const body = await readRequestBody<OpenAIChatCompletionsRequest>(request);
        if (!body?.messages?.length) {
          return jsonResponse(
            { error: { message: 'messages is required', type: 'invalid_request_error' } },
            400,
          );
        }
        const shouldStream = body.stream === true;
        const parsedModel = normalizeOpenAICompatModel(body.model);
        if (!parsedModel) {
          return jsonResponse(
            {
              error: {
                message: 'model must use runner/model format',
                type: 'invalid_request_error',
              },
            },
            400,
          );
        }
        let llm: LLMProvider;
        try {
          llm = await resolveOpenAIProvider(parsedModel);
        } catch (err) {
          return jsonResponse(
            {
              error: {
                message: err instanceof Error ? err.message : 'failed to resolve provider',
                type: 'invalid_request_error',
              },
            },
            400,
          );
        }

        const sdkSessionId = resolveProviderSessionIdForModel(body.session_id, parsedModel);
        const parsed = sdkSessionId
          ? (() => {
              const latestUserMessage = findLatestUserMessage(body.messages);
              if (!latestUserMessage) {
                return {
                  prompt: '',
                  files: [],
                } satisfies ParsedOpenAIPrompt;
              }
              return parseSingleOpenAIMessageAsPrompt(latestUserMessage);
            })()
          : parseOpenAIMessagesAsPrompt(body.messages);
        const { prompt, files } = parsed;
        if (!prompt) {
          return jsonResponse(
            {
              error: {
                message: sdkSessionId
                  ? 'latest user message content is empty'
                  : 'messages content is empty',
                type: 'invalid_request_error',
              },
            },
            400,
          );
        }

        const requestId = `chatcmpl-${crypto.randomUUID()}`;
        const model = parsedModel.runtimeModel;
        const workingDirectory = body.working_directory?.trim() || process.cwd();
        const stream = llm.streamChat({
          prompt,
          files,
          sessionId: requestId,
          sdkSessionId,
          model,
          workingDirectory,
          disableLlmStreaming: !shouldStream,
        });
        if (shouldStream) {
          return new Response(
            createOpenAIChatCompletionStream(stream, {
              requestId,
              modelKey: parsedModel.key,
              provider: parsedModel.provider,
              runtimeModel: parsedModel.runtimeModel,
              includeUsage: body.stream_options?.include_usage === true,
              onSession: ({ providerSessionId, apiSessionId, modelKey }) => {
                apiSessionModelKeys.set(providerSessionId, modelKey);
                apiSessionModelKeys.set(apiSessionId, modelKey);
              },
            }),
            {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
              },
            },
          );
        }
        const completion = await collectProviderResponse(stream);
        const apiSessionId = completion.sessionId
          ? encodeApiSessionId({
              v: 1,
              provider: parsedModel.provider,
              model: parsedModel.runtimeModel,
              providerSessionId: completion.sessionId,
            })
          : undefined;
        if (completion.sessionId) {
          apiSessionModelKeys.set(completion.sessionId, parsedModel.key);
          if (apiSessionId) apiSessionModelKeys.set(apiSessionId, parsedModel.key);
        }
        if (completion.errors.length > 0 && !completion.text.trim()) {
          return jsonResponse(
            {
              error: {
                message: completion.errors[0],
                type: 'upstream_error',
              },
            },
            502,
          );
        }

        return jsonResponse({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsedModel.key,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: completion.text,
              },
              finish_reason: completion.errors.length > 0 ? 'length' : 'stop',
            },
          ],
          usage: {
            prompt_tokens: completion.usage.input,
            completion_tokens: completion.usage.output,
            total_tokens: completion.usage.input + completion.usage.output,
          },
          ...(apiSessionId
            ? { _session_id: apiSessionId, session_id: apiSessionId }
            : {}),
        });
      }

      if (request.method === 'GET' && pathname === '/api/bridge/logs') {
        const raw = parseInt(searchParams.get('lines') || '', 10);
        const lines =
          Number.isFinite(raw) && raw > 0
            ? Math.min(raw, BRIDGE_LOG_LINES_MAX)
            : BRIDGE_LOG_LINES_DEFAULT;
        const source = searchParams.get('source')?.trim() ?? 'daemon';
        const fileBasename = await resolveLatestBridgeLogBasename(
          source === 'app' ? 'app' : 'daemon',
        );
        const { text, logPath, missing } = await readBridgeLogTail(lines, fileBasename);
        return jsonResponse({
          ok: true,
          text,
          logPath,
          missing,
          lines,
          source: source === 'app' ? 'app' : 'daemon',
        });
      }

      if (request.method === 'GET' && pathname === '/api/structure') {
        return jsonResponse(DIRECTORY_STRUCTURE_PLAN);
      }

      /**
       * Telegram Bot API webhook for Kanban notify bot inline buttons (`kperm:*` callbacks).
       * Set with: `curl -F "url=https://YOUR_HOST/api/telegram/kanban-webhook" … setWebhook`
       * Optional: `CTI_KANBAN_TELEGRAM_WEBHOOK_SECRET` → Telegram sends `X-Telegram-Bot-Api-Secret-Token`.
       */
      if (request.method === 'POST' && pathname === '/api/telegram/kanban-webhook') {
        const secret = process.env.CTI_KANBAN_TELEGRAM_WEBHOOK_SECRET?.trim();
        if (secret) {
          const hdr = request.headers.get('x-telegram-bot-api-secret-token');
          if (hdr !== secret) {
            return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
          }
        }
        const body = await readRequestBody<{
          callback_query?: {
            id: string;
            data?: string;
            message?: { chat?: { id?: number } };
          };
        }>(request);
        const cq = body.callback_query;
        if (!cq?.id || typeof cq.data !== 'string') {
          return jsonResponse({ ok: true });
        }
        const parsed = parseKanbanPermCallbackData(cq.data);
        if (!parsed) {
          return jsonResponse({ ok: true });
        }
        const expectedChat = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
        if (expectedChat) {
          const chatId = cq.message?.chat?.id;
          if (chatId !== undefined && String(chatId) !== expectedChat) {
            void answerKanbanTelegramCallbackQuery(cq.id, {
              text: '无权在此对话操作',
              showAlert: true,
            });
            return jsonResponse({ ok: true });
          }
        }
        const resolved = options.workflowService.resolveApproval(parsed.approvalId, {
          behavior: parsed.behavior,
          message:
            parsed.behavior === 'allow'
              ? 'approved from Telegram'
              : 'denied from Telegram',
        });
        void answerKanbanTelegramCallbackQuery(cq.id, {
          text: resolved
            ? parsed.behavior === 'allow'
              ? '已同意'
              : '已拒绝'
            : '处理失败（可能已过期或已处理）',
          showAlert: !resolved,
        });
        return jsonResponse({ ok: true });
      }

      if (request.method === 'GET' && pathname === '/api/platform/runners') {
        const cfg = loadKanbanPlatformConfig();
        const runners = normalizeRunnersWithProcessEnvOverride(cfg).map((r) => ({
          id: r.id,
          label: r.label ?? r.id,
          runtime: runnerRuntimeForJson(r.runtime),
        }));
        return jsonResponse({ runners });
      }

      if (request.method === 'GET' && pathname === '/api/skills/catalog') {
        return jsonResponse({ skills: listSkillCatalogEntries() });
      }

      if (request.method === 'GET' && pathname === '/api/projects') {
        return jsonResponse(options.store.listProjects());
      }

      const projectNextIssueParams = matchPath('/api/projects/:projectId/next-issue-id', pathname);
      if (request.method === 'GET' && projectNextIssueParams) {
        try {
          const issueId = options.store.previewNextIssueId(projectNextIssueParams.projectId);
          return jsonResponse({ issueId });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 404);
        }
      }

      const kanbanRolesParams = matchPath('/api/projects/:projectId/kanban-roles', pathname);
      if (request.method === 'GET' && kanbanRolesParams) {
        const project = options.store.getProject(kanbanRolesParams.projectId);
        if (!project) return notFoundResponse('Project', kanbanRolesParams.projectId);
        const cfg = loadKanbanPlatformConfig();
        const cfgRunners = normalizeRunnersWithProcessEnvOverride(cfg).map((r) => ({
          id: r.id,
          label: r.label ?? r.id,
          runtime: runnerRuntimeForJson(r.runtime),
        }));
        const runners = mergeRunnersWithProjectReferences(cfgRunners, project).map((r) => ({
          ...r,
          runtime: runnerRuntimeForJson(r.runtime),
        }));
        return jsonResponse({
          projectId: project.id,
          kinds: KANBAN_ROLE_KINDS,
          roleLabels: {
            'agent-dev': '开发（agent-dev）',
            'pre-tester': '前置测试（pre-tester）',
            'codex-senior': '高级开发（codex-senior）',
            'claude-review': '评审（claude-review）',
            'copilot-test': '测试（copilot-test）',
          },
          runners,
          mapping: project.kanbanRoleRunners ?? {},
          members: project.kanbanRoleMembers ?? {},
          defaultLaneSkills: Object.fromEntries(
            KANBAN_ROLE_KINDS.map((k) => [k, defaultSkillLinesForLane(k, 0)]),
          ) as Record<KanbanAgentKind, string[]>,
          kanbanLaneSkills: project.kanbanLaneSkills ?? {},
        });
      }

      if (request.method === 'PUT' && kanbanRolesParams) {
        const project = options.store.getProject(kanbanRolesParams.projectId);
        if (!project) return notFoundResponse('Project', kanbanRolesParams.projectId);
        const body = await readRequestBody<{
          kanbanRoleRunners?: unknown;
          kanbanRoleMembers?: unknown;
          kanbanLaneSkills?: unknown;
        }>(request);
        if (
          body.kanbanRoleRunners === undefined &&
          body.kanbanRoleMembers === undefined &&
          body.kanbanLaneSkills === undefined
        ) {
          return jsonResponse(
            { error: 'kanbanRoleRunners, kanbanRoleMembers, and/or kanbanLaneSkills is required' },
            400,
          );
        }
        const cfg = loadKanbanPlatformConfig();
        const validIds = new Set(normalizeRunnersWithProcessEnvOverride(cfg).map((r) => r.id));
        const next: Project = { ...project };

        if (body.kanbanRoleMembers !== undefined) {
          const rawMembers = body.kanbanRoleMembers as Record<string, unknown>;
          const parsedMembers = parseKanbanRoleMembersInput(body.kanbanRoleMembers);
          if (parsedMembers === null) {
            return jsonResponse({ error: 'kanbanRoleMembers must be lane → { id, name, runnerProfileId }[]' }, 400);
          }
          const mergedMembers: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> = {
            ...(project.kanbanRoleMembers ?? {}),
          };
          for (const k of KANBAN_ROLE_KINDS) {
            if (Object.prototype.hasOwnProperty.call(rawMembers, k)) {
              const list = parsedMembers[k] ?? [];
              mergedMembers[k] = list;
              for (const m of list) {
                if (!validIds.has(m.runnerProfileId)) {
                  return jsonResponse({ error: `Unknown runner id: ${m.runnerProfileId}` }, 400);
                }
              }
            }
          }
          if (Object.keys(mergedMembers).length === 0) {
            delete next.kanbanRoleMembers;
          } else {
            next.kanbanRoleMembers = mergedMembers;
          }
        }

        if (body.kanbanRoleRunners !== undefined) {
          const parsed = parseKanbanRoleRunnersInput(body.kanbanRoleRunners);
          if (parsed === null) {
            return jsonResponse({ error: 'kanbanRoleRunners must be an object with string runner ids' }, 400);
          }
          for (const v of Object.values(parsed)) {
            if (!validIds.has(v)) {
              return jsonResponse({ error: `Unknown runner id: ${v}` }, 400);
            }
          }
          if (Object.keys(parsed).length === 0) {
            delete next.kanbanRoleRunners;
          } else {
            next.kanbanRoleRunners = parsed;
          }
        }

        if (body.kanbanLaneSkills !== undefined) {
          const rawLaneSkills = body.kanbanLaneSkills;
          if (typeof rawLaneSkills !== 'object' || rawLaneSkills === null || Array.isArray(rawLaneSkills)) {
            return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
          }
          const nextLaneSkills: Partial<Record<KanbanAgentKind, string[]>> = {
            ...(project.kanbanLaneSkills ?? {}),
          };
          for (const k of KANBAN_ROLE_KINDS) {
            if (!Object.prototype.hasOwnProperty.call(rawLaneSkills, k)) continue;
            const v = (rawLaneSkills as Record<string, unknown>)[k];
            if (!Array.isArray(v)) {
              return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
            }
            const ids: string[] = [];
            for (const x of v) {
              if (typeof x !== 'string' || !x.trim()) {
                return jsonResponse({ error: 'kanbanLaneSkills must be lane → string[] of skill ids' }, 400);
              }
              ids.push(x.trim());
            }
            if (ids.length > 0) nextLaneSkills[k] = ids;
            else delete nextLaneSkills[k];
          }
          if (Object.keys(nextLaneSkills).length === 0) {
            delete next.kanbanLaneSkills;
          } else {
            next.kanbanLaneSkills = nextLaneSkills;
          }
        }

        options.store.upsertProject(next);
        return jsonResponse({ ok: true, project: options.store.getProject(project.id) });
      }

      const projectParams = matchPath('/api/projects/:projectId', pathname);
      if (request.method === 'GET' && projectParams) {
        const project = options.store.getProject(projectParams.projectId);
        return project
          ? jsonResponse(project)
          : notFoundResponse('Project', projectParams.projectId);
      }

      // ─── Coverage endpoints ────────────────────────────────────────────────
      const coverageParams = matchPath('/api/projects/:projectId/coverage', pathname);
      if (request.method === 'GET' && coverageParams) {
        return jsonResponse(options.store.getProjectCoverage(coverageParams.projectId));
      }
      if (request.method === 'POST' && coverageParams) {
        const body = await readRequestBody<{ coverage?: unknown; context?: unknown }>(request);
        const coverage = Number(body?.coverage);
        if (!isFinite(coverage) || coverage < 0 || coverage > 100) {
          return jsonResponse({ error: 'coverage must be a number between 0 and 100' }, 400);
        }
        const context = typeof body?.context === 'string' ? body.context : undefined;
        const result = options.store.updateProjectCoverage(coverageParams.projectId, coverage, context);
        return jsonResponse(result);
      }

      const coverageHistoryParams = matchPath('/api/projects/:projectId/coverage/history', pathname);
      if (request.method === 'GET' && coverageHistoryParams) {
        const limit = Math.min(Number(searchParams.get('limit') ?? '20'), 100) || 20;
        return jsonResponse(options.store.getCoverageHistory(coverageHistoryParams.projectId, limit));
      }

      if (request.method === 'GET' && pathname === '/api/sprints') {
        return jsonResponse(options.store.listSprints(searchParams.get('projectId') ?? undefined));
      }

      if (request.method === 'POST' && pathname === '/api/sprints') {
        const body = await readRequestBody<{
          projectId: string;
          name: string;
          branchName?: string;
          baseBranch?: string;
        }>(request);
        if (!body.projectId || !body.name?.trim()) {
          return jsonResponse({ error: 'projectId and name are required' }, 400);
        }
        const project = options.store.getProject(body.projectId);
        if (!project) return notFoundResponse('Project', body.projectId);
        try {
          ensureActiveSprintNameUniqueForProject(options.store, body.projectId, body.name);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const safeName = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const sprint: Sprint = {
          id: crypto.randomUUID(),
          projectId: body.projectId,
          name: body.name,
          branchName: body.branchName ?? `${project.repository.sprintBranchPrefix ?? 'feature/'}${safeName}`,
          baseBranch: body.baseBranch ?? project.repository.baseBranch ?? 'main',
          status: 'active',
          taskIds: [],
          startedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return jsonResponse(options.store.upsertSprint(sprint));
      }

      const sprintParams = matchPath('/api/sprints/:sprintId', pathname);
      if (request.method === 'GET' && sprintParams) {
        const sprint = options.store.getSprint(sprintParams.sprintId);
        return sprint
          ? jsonResponse(sprint)
          : notFoundResponse('Sprint', sprintParams.sprintId);
      }

      if (request.method === 'DELETE' && sprintParams) {
        const result = options.store.removeSprint(sprintParams.sprintId);
        if (!result.ok) {
          return jsonResponse({ error: result.error }, 400);
        }
        return jsonResponse({ ok: true, id: sprintParams.sprintId });
      }

      if (request.method === 'GET' && pathname === '/api/tasks') {
        const filterProjectId = searchParams.get('projectId')?.trim();
        const tasks = options.store.listTaskSessions(filterProjectId || undefined);
        return jsonResponse(tasks.map((t) => enrichTaskSessionForApi(options.store, t)));
      }

      const taskParams = matchPath('/api/tasks/:taskSessionId', pathname);
      if (request.method === 'GET' && taskParams) {
        const taskSession = options.store.getTaskSession(taskParams.taskSessionId);
        return taskSession
          ? jsonResponse(enrichTaskSessionForApi(options.store, taskSession))
          : notFoundResponse('Task session', taskParams.taskSessionId);
      }

      if (request.method === 'GET' && pathname === '/api/instances') {
        return jsonResponse(options.store.listAgentInstances());
      }

      if (request.method === 'POST' && pathname === '/api/instances') {
        const body = await readRequestBody<{
          taskSessionId?: string;
          role?: AgentRole;
          runtimeProfileId?: string;
        }>(request);
        if (!body.taskSessionId || !body.role) {
          return jsonResponse({ error: 'taskSessionId and role are required' }, 400);
        }
        const record = await options.workflowService.ensureAgentInstance(
          body.taskSessionId,
          body.role,
          body.runtimeProfileId,
        );
        return jsonResponse(record, 201);
      }

      const instanceParams = matchPath('/api/instances/:instanceId', pathname);
      if (request.method === 'GET' && instanceParams) {
        const instance = options.store.getAgentInstance(instanceParams.instanceId);
        return instance
          ? jsonResponse(instance)
          : notFoundResponse('Agent instance', instanceParams.instanceId);
      }

      if (request.method === 'GET' && pathname === '/api/approvals') {
        return jsonResponse(
          options.store.listPendingApprovals(searchParams.get('taskSessionId') ?? undefined),
        );
      }

      const approvalParams = matchPath('/api/approvals/:approvalId', pathname);
      if (request.method === 'GET' && approvalParams) {
        const approval = options.store.getPendingApproval(approvalParams.approvalId);
        return approval
          ? jsonResponse(approval)
          : notFoundResponse('Approval', approvalParams.approvalId);
      }

      if (request.method === 'POST' && pathname === '/api/projects') {
        const incoming = await readRequestBody<Project>(request);
        const deployment = incoming.deployment ? await ensureVercelProjectLinked(incoming) : undefined;
        const project = {
          ...incoming,
          ...(deployment ? { deployment } : {}),
        };
        if (incoming.deployment && project.deployment?.enabled !== false) {
          await ensureVercelGitConnection(project);
        }
        return jsonResponse(options.store.upsertProject(project), 201);
      }

      if (request.method === 'DELETE' && projectParams) {
        const result = options.store.removeProject(projectParams.projectId);
        if (!result.ok) {
          return jsonResponse({ error: result.error }, 400);
        }
        return jsonResponse({ ok: true, id: projectParams.projectId });
      }

      if (request.method === 'POST' && pathname === '/api/workflows/sprints/start') {
        return jsonResponse(
          await options.workflowService.startSprint(await readRequestBody<unknown>(request)),
          201,
        );
      }
      const sprintDeployParams = matchPath('/api/workflows/sprints/:sprintId/deploy', pathname);
      if (request.method === 'POST' && sprintDeployParams) {
        return jsonResponse(await options.workflowService.deploySprint(sprintDeployParams.sprintId), 200);
      }

      if (request.method === 'POST' && pathname === '/api/workflows/projects/bootstrap') {
        try {
          return jsonResponse(
            await options.workflowService.bootstrapProjectFromRequirement(await readRequestBody<unknown>(request)),
            201,
          );
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/create') {
        return jsonResponse(
          await options.workflowService.createTask(await readRequestBody<unknown>(request)),
          201,
        );
      }

      if (request.method === 'DELETE' && pathname === '/api/workflows/tasks') {
        try {
          const projectId = searchParams.get('projectId')?.trim() || undefined;
          const sprintId = searchParams.get('sprintId')?.trim() || undefined;
          return jsonResponse(await options.workflowService.deleteTasks({ projectId, sprintId }));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/batch-spec/preview') {
        try {
          return jsonResponse(
            await options.workflowService.previewBatchTasksFromSpec(await readRequestBody<unknown>(request)),
            200,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          requestLogger.warn(
            { err: e, stack: e instanceof Error ? e.stack : undefined },
            `batch-spec/preview failed: ${msg}`,
          );
          return jsonResponse({ error: msg }, 400);
        }
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/batch-spec/create') {
        try {
          return jsonResponse(
            await options.workflowService.createTasksFromBatchPlan(await readRequestBody<unknown>(request)),
            201,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          requestLogger.warn(
            { err: e, stack: e instanceof Error ? e.stack : undefined },
            `batch-spec/create failed: ${msg}`,
          );
          return jsonResponse({ error: msg }, 400);
        }
      }

      if (request.method === 'POST' && pathname === '/api/workflows/board-brainstorm/chat') {
        try {
          const body = await readRequestBody<unknown>(request);
          const parsed = parseBoardBrainstormChatInput(body);
          const stream = await options.workflowService.streamBoardBrainstormChat(parsed);
          const encoder = new TextEncoder();
          const byteStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const reader = stream.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  controller.enqueue(encoder.encode(value));
                }
              } finally {
                controller.close();
              }
            },
          });
          return new Response(byteStream, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (request.method === 'GET' && pathname === '/api/kanban/monitor') {
        const projectId = searchParams.get('projectId')?.trim() || undefined;
        const taskId = searchParams.get('taskId')?.trim() || undefined;
        const taskSessionId = searchParams.get('taskSessionId')?.trim() || undefined;
        const limitRaw = parseInt(searchParams.get('limit') || '', 10);
        const offsetRaw = parseInt(searchParams.get('offset') || '', 10);
        const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
        const offset = Number.isFinite(offsetRaw) ? offsetRaw : undefined;
        return jsonResponse(
          options.store.listKanbanAgentTurns({ projectId, taskId, taskSessionId, limit, offset }),
        );
      }

      const kanbanMonitorTurnParams = matchPath('/api/kanban/monitor/:turnId', pathname);
      if (request.method === 'GET' && kanbanMonitorTurnParams) {
        const row = options.store.getKanbanAgentTurn(kanbanMonitorTurnParams.turnId);
        return row ? jsonResponse(row) : notFoundResponse('Kanban agent turn', kanbanMonitorTurnParams.turnId);
      }

      if (request.method === 'GET' && pathname === '/api/kanban/status') {
        return jsonResponse(options.workflowService.getKanbanStatus());
      }

      if (request.method === 'POST' && pathname === '/api/workflows/tasks/assign') {
        return jsonResponse(
          await options.workflowService.assignTask(await readRequestBody<unknown>(request)),
          201,
        );
      }

      const queueManualParams = matchPath('/api/workflows/tasks/:taskSessionId/queue-message', pathname);
      if (request.method === 'POST' && queueManualParams) {
        const body = await readRequestBody<{ content?: string }>(request);
        const content = typeof body.content === 'string' ? body.content : '';
        try {
          await options.workflowService.enqueueManualQueueMessage(queueManualParams.taskSessionId, content);
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const taskCommentsParams = matchPath('/api/workflows/tasks/:taskSessionId/comments', pathname);
      if (request.method === 'POST' && taskCommentsParams) {
        const body = await readRequestBody<{ content?: string; role?: AgentRole | null }>(request);
        const content = typeof body.content === 'string' ? body.content : '';
        try {
          const task = await options.workflowService.addTaskHistoryComment(taskCommentsParams.taskSessionId, {
            content,
            ...(body.role !== undefined ? { role: body.role } : {}),
          });
          return jsonResponse(task, 201);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const submitReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/submit-review', pathname);
      if (request.method === 'POST' && submitReviewParams) {
        const payload = await readRequestBody<{
          commitMessage: string;
          prTitle: string;
          prBody: string;
        }>(request);
        return jsonResponse(
          await options.workflowService.submitTaskForReview({
            taskSessionId: submitReviewParams.taskSessionId,
            commitMessage: payload.commitMessage,
            prTitle: payload.prTitle,
            prBody: payload.prBody,
          }),
        );
      }

      const testingStartParams = matchPath('/api/workflows/tasks/:taskSessionId/start-testing', pathname);
      if (request.method === 'POST' && testingStartParams) {
        return jsonResponse(
          await options.workflowService.startTesting(testingStartParams.taskSessionId),
        );
      }

      const featureTestingStartParams = matchPath('/api/workflows/tasks/:taskSessionId/start-feature-testing', pathname);
      if (request.method === 'POST' && featureTestingStartParams) {
        return jsonResponse(
          await options.workflowService.startFeatureTesting(featureTestingStartParams.taskSessionId),
        );
      }

      const regressionStartParams = matchPath('/api/workflows/tasks/:taskSessionId/start-regression', pathname);
      if (request.method === 'POST' && regressionStartParams) {
        return jsonResponse(
          await options.workflowService.startRegressionTesting(regressionStartParams.taskSessionId),
        );
      }

      const regressionRefreshParams = matchPath('/api/workflows/tasks/:taskSessionId/regression/refresh', pathname);
      if (request.method === 'POST' && regressionRefreshParams) {
        return jsonResponse(
          await options.workflowService.refreshRegressionIfMasterAdvanced(regressionRefreshParams.taskSessionId),
        );
      }

      const proceedReleaseParams = matchPath('/api/workflows/tasks/:taskSessionId/proceed-to-release', pathname);
      if (request.method === 'POST' && proceedReleaseParams) {
        return jsonResponse(
          await options.workflowService.proceedToPendingRelease(proceedReleaseParams.taskSessionId),
        );
      }

      const rejectReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/reject-review', pathname);
      if (request.method === 'POST' && rejectReviewParams) {
        const payload = await readRequestBody<{ comment: string }>(request);
        if (!payload.comment?.trim()) {
          return jsonResponse({ error: 'comment is required' }, 400);
        }
        return jsonResponse(
          await options.workflowService.rejectReview(rejectReviewParams.taskSessionId, payload.comment.trim()),
        );
      }

      const testingFailParams = matchPath('/api/workflows/tasks/:taskSessionId/testing/fail', pathname);
      if (request.method === 'POST' && testingFailParams) {
        const payload = await readRequestBody<{ summary: string; log: string }>(request);
        return jsonResponse(
          await options.workflowService.handleTestFailure({
            taskSessionId: testingFailParams.taskSessionId,
            summary: payload.summary,
            log: payload.log,
          }),
        );
      }

      const syncReviewParams = matchPath('/api/workflows/tasks/:taskSessionId/sync-review-comment', pathname);
      if (request.method === 'POST' && syncReviewParams) {
        const payload = await readRequestBody<{ body?: string }>(request);
        const body = typeof payload.body === 'string' ? payload.body : '';
        try {
          await options.workflowService.syncReviewCommentToPrAndTask(syncReviewParams.taskSessionId, body);
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const closeTaskParams = matchPath('/api/workflows/tasks/:taskSessionId/close', pathname);
      if (request.method === 'POST' && closeTaskParams) {
        try {
          const body = await readRequestBody<{ skipVercelRestoreAfterClose?: unknown }>(request);
          const closeOpts: CloseTaskOptions | undefined =
            body.skipVercelRestoreAfterClose === true ? { skipVercelRestoreAfterClose: true } : undefined;
          return jsonResponse(
            await options.workflowService.closeTask(closeTaskParams.taskSessionId, undefined, closeOpts),
          );
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const closeAsyncParams = matchPath('/api/workflows/tasks/:taskSessionId/close-async', pathname);
      if (request.method === 'POST' && closeAsyncParams) {
        try {
          return jsonResponse(
            await options.workflowService.initiateCloseAsync(closeAsyncParams.taskSessionId),
          );
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const blockTaskParams = matchPath('/api/workflows/tasks/:taskSessionId/block', pathname);
      if (request.method === 'POST' && blockTaskParams) {
        const body = await readRequestBody<{ reason?: unknown }>(request);
        const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Blocked by human.';
        try {
          return jsonResponse(await options.workflowService.blockTask(blockTaskParams.taskSessionId, reason));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const unblockTaskParams = matchPath('/api/workflows/tasks/:taskSessionId/unblock', pathname);
      if (request.method === 'POST' && unblockTaskParams) {
        try {
          return jsonResponse(await options.workflowService.unblockTask(unblockTaskParams.taskSessionId));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const uatApproveParams = matchPath('/api/workflows/tasks/:taskSessionId/uat-approve', pathname);
      if (request.method === 'POST' && uatApproveParams) {
        try {
          return jsonResponse(await options.workflowService.uatApprove(uatApproveParams.taskSessionId));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const uatRejectParams = matchPath('/api/workflows/tasks/:taskSessionId/uat-reject', pathname);
      if (request.method === 'POST' && uatRejectParams) {
        const body = await readRequestBody<{ reason?: unknown }>(request);
        const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'UAT rejected.';
        try {
          return jsonResponse(await options.workflowService.uatReject(uatRejectParams.taskSessionId, reason));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const ciResultParams = matchPath('/api/workflows/tasks/:taskSessionId/ci-result', pathname);
      if (request.method === 'POST' && ciResultParams) {
        const body = await readRequestBody<{ status?: unknown; reason?: unknown; coverage?: unknown }>(request);
        const status = body?.status;
        if (status !== 'success' && status !== 'failure') {
          return jsonResponse({ error: 'status must be "success" or "failure"' }, 400);
        }
        const reason = typeof body?.reason === 'string' ? body.reason : undefined;
        const coverage = body?.coverage != null ? Number(body.coverage) : undefined;
        if (coverage !== undefined && (!isFinite(coverage) || coverage < 0 || coverage > 100)) {
          return jsonResponse({ error: 'coverage must be a number between 0 and 100' }, 400);
        }
        try {
          return jsonResponse(
            await options.workflowService.processCiCallback(ciResultParams.taskSessionId, status, reason, coverage),
          );
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      const deleteTaskParams = matchPath('/api/workflows/tasks/:taskSessionId', pathname);
      if (request.method === 'DELETE' && deleteTaskParams) {
        await options.workflowService.deleteTask(deleteTaskParams.taskSessionId);
        return jsonResponse({ ok: true });
      }

      if (request.method === 'POST' && approvalParams) {
        return jsonResponse({
          ok: options.workflowService.resolveApproval(
            approvalParams.approvalId,
            await readRequestBody<unknown>(request),
          ),
        });
      }

      if (request.method === 'POST' && pathname === '/api/instances/reconcile') {
        await options.instanceManager.reconcile();
        return jsonResponse({
          ok: true,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      const instanceStartParams = matchPath('/api/instances/:instanceId/start', pathname);
      if (request.method === 'POST' && instanceStartParams) {
        await options.instanceManager.startInstance(instanceStartParams.instanceId);
        return jsonResponse({
          ok: true,
          instanceId: instanceStartParams.instanceId,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      const instanceStopParams = matchPath('/api/instances/:instanceId/stop', pathname);
      if (request.method === 'POST' && instanceStopParams) {
        await options.instanceManager.stopInstance(instanceStopParams.instanceId);
        return jsonResponse({
          ok: true,
          instanceId: instanceStopParams.instanceId,
          runningInstances: options.instanceManager.listRunningInstanceIds(),
        });
      }

      if (request.method === 'DELETE' && instanceParams) {
        await options.instanceManager.deleteInstance(instanceParams.instanceId);
        return jsonResponse({ ok: true, instanceId: instanceParams.instanceId });
      }

      if (request.method === 'GET' && pathname === '/api/bridge/status') {
        const slug = searchParams.get('slug')?.trim();
        const home = slug ? getCtiHomeForBridgeSlug(slug) : undefined;
        return jsonResponse(getBridgeStatusForApi(home));
      }

      const bridgeActionParams = matchPath('/api/bridge/:action', pathname);
      if (request.method === 'POST' && bridgeActionParams) {
        const bridgeBody = (await readRequestBody<{ slug?: string }>(request)) as {
          slug?: string;
        };
        const bridgeHome = bridgeBody.slug?.trim()
          ? getCtiHomeForBridgeSlug(bridgeBody.slug.trim())
          : undefined;

        if (bridgeActionParams.action === 'start') {
          // Preflight: if auto mode is enabled, config.slave.env must exist
          try {
            const cfg = loadConfig(bridgeHome);
            if (cfg.imBot?.autoMode) {
              const slaveEnvPath = getSlaveEnvPath(bridgeHome);
              if (!fs.existsSync(slaveEnvPath)) {
                return jsonResponse(
                  {
                    error:
                      '已启用 Auto 模式，但未找到 config.slave.env。请先在管理页面配置 Slave Runner 并点击「保存 config.slave.env」。',
                  },
                  400,
                );
              }
            }
          } catch {
            /* config load failure will surface during daemon start */
          }
          await startBridgeDaemonChild(bridgeHome);
          return jsonResponse(getBridgeStatusForApi(bridgeHome));
        }
        if (bridgeActionParams.action === 'stop') {
          const stopped = await stopBridgeDaemonChild(bridgeHome);
          if (!stopped.ok) {
            // Not managed by app — try to kill via PID from status.json
            const disk = readBridgeDaemonDiskStatus(bridgeHome);
            if (disk.effectiveRunning && disk.pid) {
              try {
                process.kill(disk.pid, 'SIGTERM');
                // Wait briefly for process to exit
                for (let i = 0; i < 20; i++) {
                  await new Promise((r) => setTimeout(r, 500));
                  try { process.kill(disk.pid!, 0); } catch { break; }
                }
              } catch {
                /* already dead */
              }
            } else {
              return jsonResponse(
                { error: '桥接未在运行或无法找到 PID。' },
                409,
              );
            }
          }
          return jsonResponse(getBridgeStatusForApi(bridgeHome));
        }
        if (bridgeActionParams.action === 'auto-start') {
          bridgeManager.tryAutoStart();
          return jsonResponse(getBridgeStatusForApi());
        }
        return jsonResponse({ error: `Unknown bridge action: ${bridgeActionParams.action}` }, 404);
      }

      // ── Monitor API ──
      if (request.method === 'GET' && pathname === '/api/monitor/responses') {
        try {
          const slug = searchParams.get('bridge') ?? undefined;
          if (slug) {
            const home = getCtiHomeForBridgeSlug(slug);
            const data = readMonitorMessages(home);
            const status = readRunnerStatusForMonitor(home);
            // Tag entries with source bridge
            const tag = (e: { text: string; ts: number; bridgeSlug?: string }) => ({ ...e, homeBridge: slug });
            return jsonResponse({ masterOut: data.master.map(tag), slaveOut: data.slave.map(tag), runnerStatus: { [slug]: status } });
          }
          // No slug — merge from all bridges, tag with source
          const allSlugs = listBridgeSlugs();
          let masterOut: { text: string; ts: number; bridgeSlug?: string; homeBridge?: string }[] = [];
          let slaveOut: { text: string; ts: number; bridgeSlug?: string; homeBridge?: string }[] = [];
          const runnerStatus: Record<string, { masterBusy: boolean; slaveBusy: boolean; masterSince?: number; slaveSince?: number; updatedAt: number }> = {};
          for (const s of allSlugs) {
            try {
              const home = getCtiHomeForBridgeSlug(s);
              const data = readMonitorMessages(home);
              const tag = (e: { text: string; ts: number; bridgeSlug?: string }) => ({ ...e, homeBridge: s });
              masterOut = masterOut.concat(data.master.map(tag));
              slaveOut = slaveOut.concat(data.slave.map(tag));
              runnerStatus[s] = readRunnerStatusForMonitor(home);
            } catch { /* skip */ }
          }
          if (allSlugs.length === 0) {
            const data = readMonitorMessages();
            masterOut = data.master;
            slaveOut = data.slave;
            runnerStatus['default'] = readRunnerStatusForMonitor();
          }
          masterOut.sort((a, b) => a.ts - b.ts);
          slaveOut.sort((a, b) => a.ts - b.ts);
          return jsonResponse({ masterOut, slaveOut, runnerStatus });
        } catch (err) {
          return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      return jsonResponse({ error: `Route not found: ${request.method} ${pathname}` }, 404);
    } catch (error) {
      requestLogger.error({ error }, 'Platform request failed');
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    } finally {
      requestLogger.info('Platform request completed');
    }
  }

  let server: Server | null = null;

  return {
    handle,
    listen(port: number, callback?: () => void): Server {
      if (!server) {
        server = createServer(async (request, response) => {
          const webRequest = await toWebRequest(request);
          const result = await handle(webRequest);
          await writeNodeResponse(response, result);
        });
      }
      return server.listen(port, callback);
    },
  };
}
