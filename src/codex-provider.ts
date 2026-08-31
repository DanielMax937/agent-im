/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Also serves as the base class for CursorProvider, which uses the
 * same SDK protocol with a different CLI executable.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LLMProvider, StreamChatParams } from './lib/bridge/host';
import type { PendingPermissions } from './permission-gateway';
import { sseEvent } from './sse-utils';
import {
  buildSubprocessEnvForRuntime,
  coerceProcessEnvToStringRecord,
  mergeRunnerSubprocessEnv,
  CODEX_PROVIDER_LOG_ENV_KEYS,
  formatProviderEnvKeysForLog,
  maskEnvValueForProviderLog,
} from './llm-provider';
import { reportProviderError, runProviderAsync, safeClose, safeEnqueue } from './provider-stream-safety';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_WRAPPER = path.join(SKILL_DIR, 'scripts', 'codex-wrapper.sh');

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Configuration for CodexProvider and its subclasses (e.g. CursorProvider).
 * Allows reusing the same SDK plumbing with a different CLI executable.
 */
export interface CodexProviderConfig {
  /** Path to the wrapper script that launches the CLI. */
  wrapperPath: string;
  /** Ordered list of env var names to check for API key. */
  apiKeyEnvVars: string[];
  /** Env var name for base URL override. */
  baseUrlEnvVar: string;
  /** Prefix for log messages (e.g. 'codex-provider'). */
  logPrefix: string;
  /** When set, overrides `CTI_CODEX_USE_LOGIN` for this provider instance. */
  useLogin?: boolean;
  /** Merged into Codex CLI subprocess env (and API key lookup). */
  subprocessEnv?: Record<string, string>;
  /**
   * When true, maps to permissive `approvalPolicy` (`on-failure`), same role as Claude
   * `SDKLLMProvider` auto-approve / `resolveProvider` `autoApprove`.
   */
  autoApprove?: boolean;
}

export const DEFAULT_CODEX_CONFIG: CodexProviderConfig = {
  wrapperPath: CODEX_WRAPPER,
  apiKeyEnvVars: ['CTI_CODEX_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  baseUrlEnvVar: 'CTI_CODEX_BASE_URL',
  logPrefix: 'codex-provider',
};

/**
 * Map bridge `permissionMode` + `autoApprove` to Codex `approvalPolicy`.
 * When `autoApprove` is true (same semantics as Claude `SDKLLMProvider`), use `on-failure`
 * so the agent does not block on approvals (aligned with permissive tool runs).
 */
export function resolveCodexApprovalPolicy(autoApprove: boolean, permissionMode?: string): string {
  if (autoApprove) return 'on-failure';
  switch (permissionMode) {
    case 'acceptEdits':
      return 'on-failure';
    case 'plan':
      return 'on-request';
    case 'default':
      return 'on-request';
    default:
      return 'on-request';
  }
}

function looksLikeClaudeModel(model?: string): boolean {
  return !!model && /^claude[-_]/i.test(model);
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function stringifyCodexText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(part => stringifyCodexText(part)).join('');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'output_text', 'message', 'value']) {
      const extracted = stringifyCodexText(record[key]);
      if (extracted) return extracted;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function codexItemText(item: Record<string, unknown>): string {
  return stringifyCodexText(item.text)
    || stringifyCodexText(item.content)
    || stringifyCodexText(item.message);
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;
  private cfg: CodexProviderConfig;
  private readonly autoApprove: boolean;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions, config?: CodexProviderConfig) {
    this.cfg = config ?? DEFAULT_CODEX_CONFIG;
    this.autoApprove = this.cfg.autoApprove ?? false;
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        `[${this.cfg.logPrefix}] @openai/codex-sdk is not installed. ` +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    const useLogin =
      this.cfg.useLogin !== undefined
        ? this.cfg.useLogin
        : process.env.CTI_CODEX_USE_LOGIN === 'true';

    const mergedEnv = mergeRunnerSubprocessEnv(
      buildSubprocessEnvForRuntime({ runtime: 'codex', useLogin }),
      this.cfg.subprocessEnv ? { subprocessEnv: this.cfg.subprocessEnv } : undefined,
    );

    let apiKey: string | undefined;
    if (!useLogin) {
      for (const envVar of this.cfg.apiKeyEnvVars) {
        if (mergedEnv[envVar]) { apiKey = mergedEnv[envVar]; break; }
      }
    }
    const baseUrl = useLogin ? undefined : (mergedEnv[this.cfg.baseUrlEnvVar] || undefined);

    if (useLogin) {
      console.log(`[${this.cfg.logPrefix}] Using CLI login token (CTI_CODEX_USE_LOGIN=true)`);
    }

    console.log(
      `[${this.cfg.logPrefix}] SDK init (env passed to Codex SDK): ${formatProviderEnvKeysForLog(mergedEnv, CODEX_PROVIDER_LOG_ENV_KEYS)} ` +
      `useLogin=${useLogin} ` +
      `resolvedApiKey=${apiKey ? maskEnvValueForProviderLog('CTI_CODEX_API_KEY', apiKey) : '(unset)'} ` +
      `resolvedBaseUrl=${baseUrl ?? '(unset)'}`,
    );

    const CodexClass = this.sdk.Codex;
    const codexOptions: Record<string, unknown> = {
      codexPathOverride: this.cfg.wrapperPath,
      env: coerceProcessEnvToStringRecord(mergedEnv),
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
    this.codex = new CodexClass(codexOptions);

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        runProviderAsync(controller, self.cfg.logPrefix, async () => {
          const emit = (chunk: string) => safeEnqueue(controller, chunk, self.cfg.logPrefix);
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            let savedThreadId = params.sdkSessionId
              ? self.threadIds.get(params.sessionId) || params.sdkSessionId
              : undefined;

            // Cross-runtime migration safety:
            // when a persisted Claude-model session leaks into a non-Claude runtime,
            // resuming it can fail immediately with model/session mismatch.
            if (savedThreadId && looksLikeClaudeModel(params.model)) {
              console.warn(`[${self.cfg.logPrefix}] Ignoring stale Claude-like sdkSessionId; starting fresh thread`);
              savedThreadId = undefined;
            }

            const approvalPolicy = resolveCodexApprovalPolicy(self.autoApprove, params.permissionMode);
            // Always pass resolved model to the SDK; omit Claude-shaped names (migration / stale sessions).
            const threadModel =
              params.model && !looksLikeClaudeModel(params.model) ? params.model : undefined;

            console.log(
              `[${self.cfg.logPrefix}] streamChat: params.model=${params.model ?? '-'} threadModel=${threadModel ?? '-'} ` +
              `cwd=${params.workingDirectory ?? '-'} sessionId=${params.sessionId ?? '-'} ` +
              `sdkSessionId=${params.sdkSessionId ?? '-'}`,
            );

            const threadOptions: Record<string, unknown> = {
              ...(threadModel ? { model: threadModel } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              skipGitRepoCheck: true,
              approvalPolicy,
              ...(params.sandboxMode ? { sandboxMode: params.sandboxMode } : {}),
              ...(params.networkAccessEnabled !== undefined
                ? { networkAccessEnabled: params.networkAccessEnabled }
                : {}),
              ...(params.webSearchMode ? { webSearchMode: params.webSearchMode } : {}),
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              /** Last JSON `error` / `turn.failed` message from Codex stdout (real cause). */
              let lastCodexStreamError: string | undefined;
              try {
                const { events } = await thread.runStreamed(input);

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      emit(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      emit(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      if (error) lastCodexStreamError = error;
                      emit(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      if (error) lastCodexStreamError = error;
                      emit(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn(`[${self.cfg.logPrefix}] Resume failed, retrying with a fresh thread:`, message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                // SDK throws on non-zero exit using stderr only; stderr often shows
                // "Reading prompt from stdin..." while real failures are JSON on stdout.
                if (message.includes('Codex Exec exited') && lastCodexStreamError) {
                  throw new Error(`${message}\n\nCodex reported: ${lastCodexStreamError}`);
                }
                throw err;
              }
            }

            safeClose(controller, self.cfg.logPrefix);
          } catch (err) {
            reportProviderError(controller, err, self.cfg.logPrefix);
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        });
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const emit = (chunk: string) => safeEnqueue(controller, chunk, this.cfg.logPrefix);
    try {
      this.handleCompletedItemInner(emit, item);
    } catch (err) {
      reportProviderError(controller, err, this.cfg.logPrefix);
    }
  }

  private handleCompletedItemInner(
    emit: (chunk: string) => void,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = codexItemText(item);
        if (text) {
          emit(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        emit(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        emit(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        emit(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        emit(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        emit(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        emit(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = codexItemText(item);
        if (text) {
          emit(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
