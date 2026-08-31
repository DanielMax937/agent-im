/**
 * OpenCode Provider — LLMProvider using the OpenCode CLI (`opencode`).
 *
 * Spawns `opencode run --format json` and maps OpenCode JSONL events to the
 * bridge SSE format. Auto-approve uses OpenCode's
 * `--dangerously-skip-permissions` flag.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { LLMProvider, StreamChatParams } from './lib/bridge/host';
import {
  buildSubprocessEnvForRuntime,
  formatProviderEnvKeysForLog,
  mergeRunnerSubprocessEnv,
  OPENCODE_PROVIDER_LOG_ENV_KEYS,
} from './llm-provider';
import { reportProviderError, runProviderAsync, safeClose, safeEnqueue } from './provider-stream-safety';
import { sseEvent } from './sse-utils';

const OPENCODE_LOG = 'opencode-provider';

export type OpenCodeSpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

function resolveOpenCodePath(explicit?: string): string {
  return explicit?.trim() || process.env.CTI_OPENCODE_EXECUTABLE || 'opencode';
}

function opencodeStartTimeoutMs(): number {
  const raw = Number(process.env.CTI_OPENCODE_START_TIMEOUT_MS || '300000');
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function opencodeKillGraceMs(): number {
  const raw = Number(process.env.CTI_OPENCODE_KILL_GRACE_MS || '2000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

export interface OpenCodeProviderOptions {
  opencodeExecutable?: string;
  defaultModel?: string;
  subprocessEnv?: Record<string, string>;
  /**
   * When true, pass `--dangerously-skip-permissions` so OpenCode auto-approves
   * permissions that are not explicitly denied.
   */
  autoApprove?: boolean;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildPromptWithImageFallback(params: StreamChatParams): string {
  if (!params.files?.length) return params.prompt;
  const imageFiles = params.files.filter((file) => file.type.startsWith('image/'));
  if (!imageFiles.length) return params.prompt;
  const imageHints = imageFiles.map((file, index) => (
    `image_${index + 1}: data:${file.type};base64,${file.data}`
  ));
  return [
    params.prompt,
    '',
    '[Attached images as data URLs]',
    ...imageHints,
  ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractText(event: Record<string, unknown>, part: Record<string, unknown> | undefined): string {
  return stringifyContent(
    part?.text
    ?? part?.content
    ?? event.text
    ?? event.content
    ?? event.message
    ?? event.delta,
  );
}

function looksLikeOpenCodeModel(model: string | undefined): model is string {
  return !!model && /^[^/\s]+\/[^/\s]+$/.test(model);
}

function looksLikeOpenCodeSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId.startsWith('ses_');
}

export class OpenCodeProvider implements LLMProvider {
  private spawnFn: OpenCodeSpawnFn;
  private opencodeExecutable?: string;
  private defaultModel?: string;
  private subprocessEnv?: Record<string, string>;
  private readonly autoApprove: boolean;

  constructor(spawnFn?: OpenCodeSpawnFn, opts?: OpenCodeProviderOptions) {
    this.spawnFn = spawnFn ?? spawn;
    this.opencodeExecutable = opts?.opencodeExecutable;
    this.defaultModel = opts?.defaultModel;
    this.subprocessEnv = opts?.subprocessEnv;
    this.autoApprove = opts?.autoApprove ?? false;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        runProviderAsync(controller, OPENCODE_LOG, async () => {
          const emit = (chunk: string) => safeEnqueue(controller, chunk, OPENCODE_LOG);
          try {
            const bin = resolveOpenCodePath(self.opencodeExecutable);
            const args: string[] = [
              'run',
              '--format',
              'json',
              ...(self.autoApprove ? ['--dangerously-skip-permissions'] : []),
            ];

            const model = self.defaultModel || process.env.CTI_OPENCODE_MODEL || params.model;
            if (looksLikeOpenCodeModel(model)) {
              args.push('--model', model);
            } else if (model) {
              console.warn(`[${OPENCODE_LOG}] ignoring stale/non-opencode model: ${model}`);
            }

            if (params.workingDirectory) {
              args.push('--dir', params.workingDirectory);
            }

            if (looksLikeOpenCodeSessionId(params.sdkSessionId)) {
              args.push('--session', params.sdkSessionId);
            } else if (params.sdkSessionId) {
              console.warn(`[${OPENCODE_LOG}] ignoring stale/non-opencode sdkSessionId: ${params.sdkSessionId}`);
            }

            args.push(buildPromptWithImageFallback(params));

            const childEnv = mergeRunnerSubprocessEnv(
              buildSubprocessEnvForRuntime({ runtime: 'opencode' }),
              { subprocessEnv: self.subprocessEnv },
            );
            console.log(
              `[${OPENCODE_LOG}] spawn opencode CLI: bin=${bin} cwd=${params.workingDirectory || process.cwd()} ` +
                `params.model=${params.model ?? '-'} effectiveModel=${model ?? '-'} ` +
                `autoApprove=${self.autoApprove} sessionId=${params.sessionId ?? '-'} sdkSessionId=${params.sdkSessionId ?? '-'} ` +
                `process.CTI_RUNTIME=${process.env.CTI_RUNTIME ?? '(unset)'} ` +
                `child env: ${formatProviderEnvKeysForLog(childEnv, OPENCODE_PROVIDER_LOG_ENV_KEYS)}`,
            );

            const child = self.spawnFn(bin, args, {
              env: childEnv,
              cwd: params.workingDirectory || process.cwd(),
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stdin?.end();

            if (params.abortController) {
              params.abortController.signal.addEventListener('abort', () => {
                child.kill('SIGTERM');
              });
            }

            const rl = createInterface({ input: child.stdout! });
            let sessionId: string | undefined;
            let sawResult = false;
            let sawActivity = false;
            let startupTimedOut = false;
            let startupTimer: NodeJS.Timeout | null = setTimeout(() => {
              if (!sawActivity && !sawResult) {
                startupTimedOut = true;
                child.kill('SIGTERM');
              }
            }, opencodeStartTimeoutMs());
            let forceKillTimer: NodeJS.Timeout | null = null;

            const clearTimers = () => {
              if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = null;
              }
              if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
              }
            };

            const noteActivity = () => {
              if (sawActivity) return;
              sawActivity = true;
              if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = null;
              }
            };

            let stderr = '';
            child.stderr!.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });

            rl.on('line', (line) => {
              try {
                if (!line.trim()) return;
                noteActivity();

                let event: Record<string, unknown>;
                try {
                  event = JSON.parse(line);
                } catch {
                  return;
                }

                const type = event.type as string | undefined;
                const part = asRecord(event.part);
                sessionId =
                  (event.sessionID as string | undefined)
                  || (event.sessionId as string | undefined)
                  || (part?.sessionID as string | undefined)
                  || sessionId;

                switch (type) {
                  case 'step_start': {
                    emit(sseEvent('status', {
                      ...(sessionId ? { session_id: sessionId } : {}),
                      ...(part?.snapshot ? { snapshot: part.snapshot } : {}),
                    }));
                    break;
                  }

                  case 'reasoning':
                  case 'text': {
                    const text = extractText(event, part);
                    if (text) emit(sseEvent('text', text));
                    break;
                  }

                  case 'tool_use': {
                    const state = asRecord(part?.state) ?? {};
                    const callId =
                      (part?.callID as string | undefined)
                      || (part?.id as string | undefined)
                      || `tool-${Date.now()}`;
                    emit(sseEvent('tool_use', {
                      id: callId,
                      name: (part?.tool as string | undefined) || 'tool',
                      input: asRecord(state.input) ?? {},
                    }));
                    if (state.output !== undefined || state.status === 'completed') {
                      emit(sseEvent('tool_result', {
                        tool_use_id: callId,
                        content: stringifyContent(state.output ?? state.title ?? 'Done'),
                        is_error: state.status === 'error',
                      }));
                    }
                    break;
                  }

                  case 'step_finish': {
                    sawResult = true;
                    clearTimers();
                    const tokens = asRecord(part?.tokens) ?? asRecord(event.tokens);
                    emit(sseEvent('result', {
                      ...(sessionId ? { session_id: sessionId } : {}),
                      usage: tokens ? {
                        input_tokens: Number(tokens.input ?? tokens.inputTokens ?? 0),
                        output_tokens: Number(tokens.output ?? tokens.outputTokens ?? 0),
                        cache_read_input_tokens: Number(tokens.cache_read ?? tokens.cacheReadTokens ?? 0),
                      } : undefined,
                      is_error: false,
                      exit_code: 0,
                    }));
                    break;
                  }

                  case 'error': {
                    emit(sseEvent('error', extractText(event, part) || 'OpenCode error'));
                    break;
                  }
                }
              } catch (lineErr) {
                reportProviderError(controller, lineErr, OPENCODE_LOG);
              }
            });

            await new Promise<void>((resolve, reject) => {
              child.on('close', (code, signal) => {
                if (startupTimedOut && !sawActivity && !sawResult) {
                  forceKillTimer = setTimeout(() => {
                    child.kill('SIGKILL');
                  }, opencodeKillGraceMs());
                }
                clearTimers();

                const hasFatalExit = (code != null && code !== 0) || signal != null;
                const hasStderrOnlyFailure = !sawResult && stderr.trim().length > 0;
                const hasStartupTimeout = startupTimedOut && !sawResult;
                const hasNoResult = !sawResult;
                if ((hasFatalExit || hasStderrOnlyFailure || hasStartupTimeout || hasNoResult) && !sawResult) {
                  const exitLabel = signal != null
                    ? `signal ${signal}`
                    : `code ${code ?? 0}`;
                  reject(new Error(
                    (hasStartupTimeout
                      ? `[${OPENCODE_LOG}] opencode timed out waiting for startup/output after ${opencodeStartTimeoutMs()}ms`
                      : hasNoResult
                        ? `[${OPENCODE_LOG}] opencode exited with ${exitLabel} before emitting a result`
                        : `[${OPENCODE_LOG}] opencode exited with ${exitLabel}`) +
                    (stderr ? `\n${stderr.slice(0, 1000)}` : ''),
                  ));
                } else {
                  resolve();
                }
              });
              child.on('error', reject);
            });

            safeClose(controller, OPENCODE_LOG);
          } catch (err) {
            reportProviderError(controller, err, OPENCODE_LOG);
          }
        });
      },
    });
  }
}
