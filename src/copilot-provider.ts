/**
 * Copilot Provider — LLMProvider using the GitHub Copilot CLI (`copilot`).
 *
 * The Copilot JSON stream is not wire-compatible with Cursor's stream-json.
 * This provider maps Copilot event types like `assistant.message_delta`,
 * `assistant.message`, `tool.execution_start`, `tool.execution_complete`, and
 * final `result` into the bridge SSE format.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { LLMProvider, StreamChatParams } from './lib/bridge/host';
import { sseEvent } from './sse-utils';
import { buildSubprocessEnv, mergeRunnerSubprocessEnv } from './llm-provider';

export type CopilotSpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

function resolveCopilotPath(explicit?: string): string {
  return explicit?.trim() || process.env.CTI_COPILOT_EXECUTABLE || 'copilot';
}

function copilotStartTimeoutMs(): number {
  const raw = Number(process.env.CTI_COPILOT_START_TIMEOUT_MS || '300000');
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function copilotKillGraceMs(): number {
  const raw = Number(process.env.CTI_COPILOT_KILL_GRACE_MS || '2000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

export interface CopilotProviderOptions {
  copilotExecutable?: string;
  defaultModel?: string;
  subprocessEnv?: Record<string, string>;
  /**
   * When true, pass `--yolo` (aligned with `resolveProvider` `autoApprove` for Claude).
   * When false, omit `--yolo` so Copilot may prompt for tool approval.
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

export class CopilotProvider implements LLMProvider {
  private spawnFn: CopilotSpawnFn;
  private copilotExecutable?: string;
  private defaultModel?: string;
  private subprocessEnv?: Record<string, string>;
  private readonly autoApprove: boolean;

  constructor(spawnFn?: CopilotSpawnFn, opts?: CopilotProviderOptions) {
    this.spawnFn = spawnFn ?? spawn;
    this.copilotExecutable = opts?.copilotExecutable;
    this.defaultModel = opts?.defaultModel;
    this.subprocessEnv = opts?.subprocessEnv;
    this.autoApprove = opts?.autoApprove ?? false;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            const bin = resolveCopilotPath(self.copilotExecutable);
            const args: string[] = [
              '--output-format', 'json',
              '--stream', params.disableLlmStreaming ? 'off' : 'on',
              ...(self.autoApprove ? ['--yolo'] : []),
            ];

            if (params.workingDirectory) {
              args.push('--add-dir', params.workingDirectory);
            }

            const model =
              self.defaultModel || process.env.CTI_COPILOT_MODEL || params.model;
            if (model && !model.startsWith('claude')) {
              args.push('--model', model);
            }

            if (params.sdkSessionId) {
              args.push(`--resume=${params.sdkSessionId}`);
            }

            args.push('-p', params.prompt);

            const child = self.spawnFn(bin, args, {
              env: mergeRunnerSubprocessEnv(buildSubprocessEnv(), {
                subprocessEnv: self.subprocessEnv,
              }),
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
            }, copilotStartTimeoutMs());
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
              if (!line.trim()) return;
              noteActivity();

              let event: Record<string, unknown>;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }

              const type = event.type as string | undefined;
              const data = (event.data as Record<string, unknown> | undefined) ?? {};

              switch (type) {
                case 'session.tools_updated': {
                  const eventModel = data.model as string | undefined;
                  controller.enqueue(sseEvent('status', {
                    ...(sessionId ? { session_id: sessionId } : {}),
                    ...(eventModel ? { model: eventModel } : {}),
                  }));
                  break;
                }

                case 'assistant.turn_start': {
                  const interactionId = data.interactionId as string | undefined;
                  if (interactionId) {
                    controller.enqueue(sseEvent('status', {
                      ...(sessionId ? { session_id: sessionId } : {}),
                      interaction_id: interactionId,
                    }));
                  }
                  break;
                }

                case 'assistant.message_delta': {
                  const delta = data.deltaContent as string | undefined;
                  if (delta) {
                    controller.enqueue(sseEvent('text', delta));
                  }
                  break;
                }

                case 'assistant.message': {
                  const content = data.content as string | undefined;
                  if (content) {
                    controller.enqueue(sseEvent('text', content));
                  }
                  break;
                }

                case 'tool.execution_start': {
                  const toolCallId = data.toolCallId as string | undefined;
                  const toolName = data.toolName as string | undefined;
                  controller.enqueue(sseEvent('tool_use', {
                    id: toolCallId || `tool-${Date.now()}`,
                    name: toolName || 'tool',
                    input: (data.arguments as Record<string, unknown> | undefined) ?? {},
                  }));
                  break;
                }

                case 'tool.execution_complete': {
                  const result = data.result as Record<string, unknown> | undefined;
                  const ok = data.success === true;
                  controller.enqueue(sseEvent('tool_result', {
                    tool_use_id: (data.toolCallId as string) || `tool-${Date.now()}`,
                    content:
                      stringifyContent(result?.detailedContent)
                      || stringifyContent(result?.content)
                      || (ok ? 'Done' : 'Tool error'),
                    is_error: !ok,
                  }));
                  break;
                }

                case 'result': {
                  sawResult = true;
                  clearTimers();
                  sessionId =
                    (event.sessionId as string | undefined)
                    || (data.sessionId as string | undefined)
                    || sessionId;
                  const exitCode =
                    typeof event.exitCode === 'number'
                      ? event.exitCode
                      : (typeof data.exitCode === 'number' ? data.exitCode : 0);
                  const usage = (event.usage as Record<string, unknown> | undefined)
                    ?? (data.usage as Record<string, unknown> | undefined);
                  controller.enqueue(sseEvent('result', {
                    ...(sessionId ? { session_id: sessionId } : {}),
                    usage: usage ? {
                      input_tokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
                      output_tokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
                      cache_read_input_tokens: Number(usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0),
                    } : undefined,
                    is_error: exitCode !== 0,
                    exit_code: exitCode,
                  }));
                  if (exitCode !== 0) {
                    controller.enqueue(sseEvent('error', `Copilot exited with code ${exitCode}`));
                  }
                  break;
                }
              }
            });

            await new Promise<void>((resolve, reject) => {
              child.on('close', (code, signal) => {
                if (startupTimedOut && !sawActivity && !sawResult) {
                  forceKillTimer = setTimeout(() => {
                    child.kill('SIGKILL');
                  }, copilotKillGraceMs());
                }
                clearTimers();

                const hasFatalExit = (code != null && code !== 0) || signal != null;
                const hasStderrOnlyFailure = !sawResult && stderr.trim().length > 0;
                const hasStartupTimeout = startupTimedOut && !sawResult;
                if ((hasFatalExit || hasStderrOnlyFailure || hasStartupTimeout) && !sawResult) {
                  const exitLabel = signal != null
                    ? `signal ${signal}`
                    : `code ${code ?? 0}`;
                  reject(new Error(
                    (hasStartupTimeout
                      ? `[copilot-provider] copilot timed out waiting for startup/output after ${copilotStartTimeoutMs()}ms`
                      : `[copilot-provider] copilot exited with ${exitLabel}`) +
                    (stderr ? `\n${stderr.slice(0, 1000)}` : '')
                  ));
                } else {
                  resolve();
                }
              });
              child.on('error', reject);
            });

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[copilot-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
    });
  }
}
