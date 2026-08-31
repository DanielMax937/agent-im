/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types';
import type {
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
} from './host';
import { getBridgeContext } from './context';
import { resolveRunnerForChannelBinding } from './im-instance-settings';
import crypto from 'crypto';
import { getLogger, maskSecrets } from '../../logger';
import {
  MASTER_REVIEW_RESULT_JSON_PREFIX,
  MASTER_VERIFICATION_RESULT_JSON_PREFIX,
  MASTER_VERIFICATION_WALKTHROUGH_PREFIX,
} from './master-verification-walkthrough';
import { renderPrompt } from '../../prompts/loader';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

export interface ProcessMessageOptions {
  disableLlmStreaming?: boolean;
  /**
   * `runner` = IM chat; `master` = Redis master coordinator; `slave` = Redis slave (tools);
   * `researcher` = Research mode Agent A (executor with tools);
   * `reviewer`   = Research mode Agent B (senior reviewer, full tools).
   */
  deliverySource?: 'runner' | 'master' | 'slave' | 'researcher' | 'reviewer';
  /**
   * Bypass the binding-driven LLM selection (`resolveLlmForBinding`) and use the
   * provided provider for this single call. Used by Research mode to bind each
   * agent (A/B) to the runner configured in `Config.research.researcherRunner`
   * / `reviewerRunner`. When omitted, normal resolution applies.
   */
  llmOverride?: import('./host').LLMProvider;
}

interface AutoModeToolTelemetry {
  id: string;
  name: string;
  startedAt: number;
}

/** Max milliseconds for master auto-mode LLM turns; 0 = disabled. */
function getAutoModeMasterReplyTimeoutMs(): number {
  const v = Number.parseInt(process.env.CTI_AUTO_MASTER_REPLY_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Slave wall-clock limit for one `streamChat` (entire Copilot/Cursor agent run).
 * Prefer `CTI_AUTO_SLAVE_SESSION_MAX_MS`; if unset, fall back to `CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS`.
 */
export function getAutoModeSlaveWallClockTimeoutMs(): { ms: number; envKey: string } {
  const sessionMax = Number.parseInt(process.env.CTI_AUTO_SLAVE_SESSION_MAX_MS ?? '', 10);
  if (Number.isFinite(sessionMax) && sessionMax > 0) {
    return { ms: sessionMax, envKey: 'CTI_AUTO_SLAVE_SESSION_MAX_MS' };
  }
  const fallback = Number.parseInt(process.env.CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(fallback) && fallback > 0) {
    return { ms: fallback, envKey: 'CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS' };
  }
  return { ms: 0, envKey: 'CTI_AUTO_SLAVE_SESSION_MAX_MS' };
}

/** Max milliseconds for master/slave auto-mode LLM turns; 0 = disabled. Read from env at call time. */
function getAutoModeReplyTimeoutMs(
  deliverySource: ProcessMessageOptions['deliverySource'],
): number {
  if (deliverySource === 'master') return getAutoModeMasterReplyTimeoutMs();
  if (deliverySource === 'slave') return getAutoModeSlaveWallClockTimeoutMs().ms;
  return 0;
}

function getAutoModeReplyTimeoutEnvKey(
  deliverySource: ProcessMessageOptions['deliverySource'],
): string | undefined {
  if (deliverySource === 'master') return 'CTI_AUTO_MASTER_REPLY_TIMEOUT_MS';
  if (deliverySource === 'slave') return getAutoModeSlaveWallClockTimeoutMs().envKey;
  return undefined;
}

/** Log each SSE chunk for auto master/slave unless CTI_AUTO_LOG_STREAM_CHUNKS=0 */
function shouldLogAutoModeStreamChunks(deliverySource: ProcessMessageOptions['deliverySource']): boolean {
  if (deliverySource !== 'master' && deliverySource !== 'slave') return false;
  const off = process.env.CTI_AUTO_LOG_STREAM_CHUNKS?.trim() === '0';
  return !off;
}

function logAutoModeSseChunk(
  deliverySource: 'master' | 'slave',
  index: number,
  sseType: string,
  data: string,
): void {
  const preview = maskSecrets(data.length > 220 ? `${data.slice(0, 220)}…` : data);
  getLogger().info(
    {
      event: 'auto_mode_sse_chunk',
      deliverySource,
      chunkIndex: index,
      sseType,
      dataLen: data.length,
      preview,
    },
    `[conversation-engine] auto-mode SSE chunk #${index} type=${sseType}`,
  );
}

function logAutoModeToolStarted(
  deliverySource: 'master' | 'slave',
  toolId: string,
  toolName: string,
  verificationRound: boolean,
): void {
  getLogger().info(
    {
      event: 'auto_mode_tool_started',
      deliverySource,
      toolId,
      toolName,
      verificationRound,
    },
    `[conversation-engine] auto-mode tool started ${toolName} (${toolId})`,
  );
}

function logAutoModeToolFinished(
  deliverySource: 'master' | 'slave',
  toolId: string,
  toolName: string,
  durationMs: number | null,
  isError: boolean,
  verificationRound: boolean,
): void {
  getLogger().info(
    {
      event: 'auto_mode_tool_finished',
      deliverySource,
      toolId,
      toolName,
      durationMs,
      isError,
      verificationRound,
    },
    `[conversation-engine] auto-mode tool finished ${toolName} (${toolId})`,
  );
}

function logAutoModeTurnSummary(payload: {
  deliverySource: 'master' | 'slave';
  verificationRound: boolean;
  completed: boolean;
  sawStatus: boolean;
  sawResult: boolean;
  sawErrorEvent: boolean;
  textChars: number;
  toolStarted: number;
  toolFinished: number;
  pendingTools: string[];
  errorMessage?: string;
}): void {
  const logFn = payload.completed
    ? getLogger().info.bind(getLogger())
    : getLogger().warn.bind(getLogger());
  logFn(
    {
      event: payload.completed ? 'auto_mode_turn_summary' : 'auto_mode_turn_failed_summary',
      ...payload,
    },
    `[conversation-engine] auto-mode turn ${payload.completed ? 'completed' : 'failed'} (${payload.deliverySource})`,
  );
}

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
  /**
   * Slave-only: wall-clock session limit hit (`CTI_AUTO_SLAVE_SESSION_MAX_MS` or legacy `CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS`).
   * Bridge should push a timeout report to Redis master and clear slave busy.
   */
  slaveSessionTimedOut?: boolean;
  /** Text accumulated before abort (slave session timeout). */
  partialAssistantText?: string;
}

/**
 * Bindings and sessions keep a persisted working directory. After the repo is moved,
 * that path may no longer exist while `bridge_default_work_dir` (from config) is updated.
 * Prefer an existing path so providers receive a valid `--workspace` / cwd.
 */
function resolveEffectiveWorkingDirectory(
  binding: ChannelBinding,
  sessionWorkingDir: string | undefined,
  store: { getSetting: (key: string) => string | null },
): string | undefined {
  const primary = binding.workingDirectory || sessionWorkingDir || '';
  if (primary && fs.existsSync(primary)) {
    return primary;
  }
  const fb = store.getSetting('bridge_default_work_dir')?.trim() || '';
  if (fb && fs.existsSync(fb)) {
    getLogger().info(
      {
        event: 'effective_cwd_fallback',
        bindingId: binding.id,
        channelType: binding.channelType,
        primaryPath: primary || null,
        chosenPath: fb,
      },
      '[conversation-engine] effective cwd: primary missing or not on disk; using bridge_default_work_dir',
    );
    return fb;
  }
  const out = primary || fb || undefined;
  if (primary && !fs.existsSync(primary)) {
    getLogger().info(
      {
        event: 'effective_cwd_stale',
        bindingId: binding.id,
        channelType: binding.channelType,
        primaryPath: primary,
        bridgeDefault: fb || null,
        chosenPath: out ?? null,
      },
      '[conversation-engine] effective cwd: primary path does not exist and no valid bridge_default_work_dir',
    );
  }
  return out;
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  options?: ProcessMessageOptions,
): Promise<ConversationResult> {
    const {
      store,
      llm,
      resolveLlmForBinding,
      getRunnerConfigsForChannelType,
      getDefaultRunnerIdForChannelType,
      imRunnerConfigs: legacyRunnerCfgs,
      defaultRunnerId: ctxDefaultRunner,
    } = getBridgeContext();
  const effectiveLlm = options?.llmOverride ?? resolveLlmForBinding?.(binding) ?? llm;
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);
    const effectiveWorkDir = resolveEffectiveWorkingDirectory(
      binding,
      session?.working_directory,
      store,
    );

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = effectiveWorkDir || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    const imRunnerConfigs =
      getRunnerConfigsForChannelType?.(binding.channelType) ?? legacyRunnerCfgs;
    const allRunnerIds = imRunnerConfigs?.map((r) => r.id) ?? [];
    const defaultForChannel =
      getDefaultRunnerIdForChannelType?.(binding.channelType) ?? ctxDefaultRunner ?? imRunnerConfigs?.[0]?.id;
    const effRunnerId = resolveRunnerForChannelBinding(
      store,
      binding.channelType,
      binding.runnerProfileId,
      defaultForChannel,
      allRunnerIds,
    );
    const runnerCfg = imRunnerConfigs?.find((r) => r.id === effRunnerId);

    // Effective model (per-binding → session → runner default → store)
    const effectiveModel =
      binding.model ||
      session?.model ||
      runnerCfg?.defaultModel ||
      store.getSetting('default_model') ||
      undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const replyTimeoutMs = getAutoModeReplyTimeoutMs(options?.deliverySource);
    const replyTimeoutEnvKey = getAutoModeReplyTimeoutEnvKey(options?.deliverySource);
    const replyTimeoutState = { fired: false, timeoutEnvKey: replyTimeoutEnvKey };
    let replyTimeoutId: ReturnType<typeof setTimeout> | undefined;
    if (replyTimeoutMs > 0) {
      replyTimeoutId = setTimeout(() => {
        replyTimeoutState.fired = true;
        abortController.abort();
      }, replyTimeoutMs);
      getLogger().info(
        {
          event: 'auto_mode_reply_timeout_armed',
          deliverySource: options?.deliverySource,
          timeoutMs: replyTimeoutMs,
          timeoutEnvKey: replyTimeoutEnvKey,
        },
        `[conversation-engine] auto-mode reply timeout armed (${replyTimeoutMs}ms, ${replyTimeoutEnvKey ?? 'n/a'})`,
      );
    }

    let systemPrompt = session?.system_prompt || undefined;
    let allowedTools: string[] | undefined;
    if (options?.deliverySource === 'master') {
      const masterCoord = renderPrompt('system/master-coordinator', {
        reviewResultJsonPrefix: MASTER_REVIEW_RESULT_JSON_PREFIX,
        verificationResultJsonPrefix: MASTER_VERIFICATION_RESULT_JSON_PREFIX,
      });
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${masterCoord}` : masterCoord;
      // Master must NOT have access to any tools — evaluation only
      allowedTools = [];
    }
    if (options?.deliverySource === 'master' || options?.deliverySource === 'slave') {
      const serviceGuardrail = renderPrompt('system/auto-mode-service-guardrail');
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${serviceGuardrail}` : serviceGuardrail;
    }
    if (options?.deliverySource === 'researcher') {
      const researcherPrompt = renderPrompt('system/research-mode-researcher');
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${researcherPrompt}` : researcherPrompt;
    }
    if (options?.deliverySource === 'reviewer') {
      const reviewerPrompt = renderPrompt('system/research-mode-reviewer');
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${reviewerPrompt}` : reviewerPrompt;
    }

    try {
      const stream = effectiveLlm.streamChat({
        prompt: text,
        sessionId,
        sdkSessionId: binding.sdkSessionId || undefined,
        model: effectiveModel,
        systemPrompt,
        workingDirectory: effectiveWorkDir,
        abortController,
        permissionMode,
        provider: resolvedProvider,
        conversationHistory: historyMsgs,
        files,
        onRuntimeStatusChange: (status: string) => {
          try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
        },
        disableLlmStreaming: options?.disableLlmStreaming,
        allowedTools,
      });

      // Consume the stream server-side (replicate collectStreamResponse pattern).
      // Permission requests are forwarded immediately via the callback during streaming
      // because the stream blocks until permission is resolved — we can't wait until after.
      return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, {
        deliverySource: options?.deliverySource,
        logStreamChunks: shouldLogAutoModeStreamChunks(options?.deliverySource),
        replyTimeoutState,
        verificationRound:
          options?.deliverySource === 'master' &&
          text.startsWith(MASTER_VERIFICATION_WALKTHROUGH_PREFIX),
      });
    } finally {
      if (replyTimeoutId) clearTimeout(replyTimeoutId);
    }
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
interface ConsumeStreamOptions {
  deliverySource?: ProcessMessageOptions['deliverySource'];
  logStreamChunks?: boolean;
  replyTimeoutState?: { fired: boolean; timeoutEnvKey?: string };
  verificationRound?: boolean;
}

function extractPartialAssistantTextForTimeout(
  contentBlocks: MessageContentBlock[],
  currentText: string,
  maxChars = 12000,
): string {
  const parts: string[] = [];
  for (const b of contentBlocks) {
    if (b.type === 'text') parts.push(b.text);
  }
  if (currentText.trim()) parts.push(currentText);
  return parts.join('\n\n').trim().slice(0, maxChars);
}

async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  consumeOpts?: ConsumeStreamOptions,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  let sseChunkIndex = 0;
  const ds = consumeOpts?.deliverySource;
  const logChunks = Boolean(consumeOpts?.logStreamChunks && (ds === 'master' || ds === 'slave'));
  const verificationRound = consumeOpts?.verificationRound === true;
  const activeTools = new Map<string, AutoModeToolTelemetry>();
  let sawStatus = false;
  let sawResult = false;
  let sawErrorEvent = false;
  let toolStartedCount = 0;
  let toolFinishedCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (logChunks && (ds === 'master' || ds === 'slave')) {
          sseChunkIndex += 1;
          logAutoModeSseChunk(ds, sseChunkIndex, event.type, event.data);
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              if (ds === 'master' || ds === 'slave') {
                const toolId = String(toolData.id || `tool-${toolStartedCount + 1}`);
                const toolName = String(toolData.name || 'Unknown');
                activeTools.set(toolId, { id: toolId, name: toolName, startedAt: Date.now() });
                toolStartedCount += 1;
                logAutoModeToolStarted(ds, toolId, toolName, verificationRound);
              }
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              if (ds === 'master' || ds === 'slave') {
                const toolId = String(resultData.tool_use_id || `tool-result-${toolFinishedCount + 1}`);
                const telemetry = activeTools.get(toolId);
                const toolName = telemetry?.name || 'Unknown';
                const durationMs = telemetry ? Date.now() - telemetry.startedAt : null;
                activeTools.delete(toolId);
                toolFinishedCount += 1;
                logAutoModeToolFinished(
                  ds,
                  toolId,
                  toolName,
                  durationMs,
                  Boolean(resultData.is_error),
                  verificationRound,
                );
              }
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              sawStatus = true;
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                store.updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                store.updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                store.syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            sawErrorEvent = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              sawResult = true;
              const resultData = JSON.parse(event.data) as {
                usage?: TokenUsage;
                is_error?: boolean;
                session_id?: string;
                result?: string;
                stop_reason?: string | null;
                errors?: string[];
              };
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) {
                hasError = true;
                // `error` SSE may be absent; SDK can still set is_error on subtype success.
                if (!errorMessage) {
                  const fromSdk =
                    (typeof resultData.result === 'string' && resultData.result.trim()) ||
                    (Array.isArray(resultData.errors) && resultData.errors.filter(Boolean).join('; ')) ||
                    '';
                  errorMessage = fromSdk
                    || (resultData.stop_reason
                      ? `Assistant error (stop_reason: ${resultData.stop_reason})`
                      : 'Assistant finished with an error but returned no text.');
                }
              }
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                store.updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (ds === 'master' || ds === 'slave') {
      logAutoModeTurnSummary({
        deliverySource: ds,
        verificationRound,
        completed: true,
        sawStatus,
        sawResult,
        sawErrorEvent,
        textChars: responseText.length,
        toolStarted: toolStartedCount,
        toolFinished: toolFinishedCount,
        pendingTools: Array.from(activeTools.values()).map((tool) => `${tool.name}:${tool.id}`),
      });
    }

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    let abortMsg = 'Task stopped by user';
    if (isAbort && consumeOpts?.replyTimeoutState?.fired) {
      const envKey =
        consumeOpts.replyTimeoutState.timeoutEnvKey
        ?? (consumeOpts.deliverySource === 'master'
          ? 'CTI_AUTO_MASTER_REPLY_TIMEOUT_MS'
          : 'CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS');
      abortMsg = `Auto mode reply timeout (${consumeOpts.deliverySource} runner exceeded ${envKey})`;
      getLogger().warn(
        { event: 'auto_mode_reply_timeout', deliverySource: consumeOpts.deliverySource, timeoutEnvKey: envKey },
        `[conversation-engine] ${abortMsg}`,
      );
    }

    if (ds === 'master' || ds === 'slave') {
      logAutoModeTurnSummary({
        deliverySource: ds,
        verificationRound,
        completed: false,
        sawStatus,
        sawResult,
        sawErrorEvent,
        textChars: currentText.trim().length,
        toolStarted: toolStartedCount,
        toolFinished: toolFinishedCount,
        pendingTools: Array.from(activeTools.values()).map((tool) => `${tool.name}:${tool.id}`),
        errorMessage: isAbort ? abortMsg : (e instanceof Error ? e.message : 'Stream consumption error'),
      });
    }

    const partialAssistantText = extractPartialAssistantTextForTimeout(contentBlocks, currentText);
    const slaveSessionTimedOut =
      Boolean(isAbort && consumeOpts?.replyTimeoutState?.fired && ds === 'slave');

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? abortMsg : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      slaveSessionTimedOut,
      partialAssistantText,
    };
  }
}
