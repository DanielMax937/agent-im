/**
 * Cursor Provider — LLMProvider implementation using the Cursor `agent` CLI.
 *
 * Spawns `agent --print --output-format stream-json` and maps its
 * line-delimited JSON events to the SSE stream format consumed by
 * the bridge conversation engine.
 *
 * Unlike the Codex provider, this does NOT use @openai/codex-sdk because
 * the `agent` CLI has its own protocol (not wire-compatible with `codex exec`).
 */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { LLMProvider, StreamChatParams } from './lib/bridge/host';
import { sseEvent } from './sse-utils';
import { getCursorAgentLaunchMode, type CursorAgentLaunchMode } from './lib/proxy-env';
import {
  buildSubprocessEnvForRuntime,
  mergeRunnerSubprocessEnv,
  CURSOR_PROVIDER_LOG_ENV_KEYS,
  formatProviderEnvKeysForLog,
} from './llm-provider';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

function resolveAgentPath(explicit?: string): string {
  return explicit?.trim() || process.env.CTI_CURSOR_EXECUTABLE || 'agent';
}

/**
 * How the Cursor `agent` binary is started (no shell — zsh aliases do not apply).
 * - `standard` (default): `spawn(agentPath, argv…)` — same as invoking `~/.local/bin/agent` when it is on PATH.
 * - `proxychains`: `spawn(proxychainsBin, [realpath(agent), …argv])` — matches a typical zsh wrapper
 *   `proxychains4 "$(realpath "$HOME/.local/bin/agent")" …`.
 */
export type { CursorAgentLaunchMode };

function cursorAgentLaunchMode(): CursorAgentLaunchMode {
  const raw = (process.env.CTI_CURSOR_AGENT_LAUNCH || '').trim().toLowerCase();
  if (raw && raw !== 'standard' && raw !== 'proxychains') {
    console.warn(
      `[cursor-provider] CTI_CURSOR_AGENT_LAUNCH=${JSON.stringify(process.env.CTI_CURSOR_AGENT_LAUNCH)} ` +
        'is not standard|proxychains; using standard',
    );
  }
  return getCursorAgentLaunchMode();
}

/**
 * Resolve a PATH-style name (e.g. `agent`) or relative path to a concrete file for realpath.
 */
export function resolveCursorAgentExecutablePath(agentPath: string): string {
  const trimmed = agentPath.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  if (!trimmed.includes(path.sep)) {
    const homeBin = path.join(os.homedir(), '.local', 'bin', trimmed);
    if (fs.existsSync(homeBin)) return homeBin;
    try {
      return execFileSync('which', [trimmed], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(
        `[cursor-provider] Cannot resolve Cursor agent executable "${trimmed}" to a filesystem path ` +
          `(needed for CTI_CURSOR_AGENT_LAUNCH=proxychains). Set CTI_CURSOR_EXECUTABLE to an absolute path, ` +
          `or install ${homeBin}.`,
      );
    }
  }
  return path.resolve(process.cwd(), trimmed);
}

function proxychainsExecutable(): string {
  return (process.env.CTI_PROXYCHAINS_EXECUTABLE || 'proxychains4').trim() || 'proxychains4';
}

/**
 * Returns [executable, argv] for spawn. In proxychains mode, argv[0] is the resolved agent binary.
 */
export function resolveCursorAgentSpawn(
  agentPath: string,
  agentArgs: string[],
): { executable: string; args: string[]; launchMode: CursorAgentLaunchMode } {
  const launchMode = cursorAgentLaunchMode();
  if (launchMode === 'standard') {
    return { executable: agentPath, args: agentArgs, launchMode };
  }
  const resolved = fs.realpathSync(resolveCursorAgentExecutablePath(agentPath));
  const wrap = proxychainsExecutable();
  return { executable: wrap, args: [resolved, ...agentArgs], launchMode };
}

export interface CursorProviderOptions {
  /** Overrides CTI_CURSOR_EXECUTABLE for this runner. */
  agentPath?: string;
  /** Default model when binding omits one (overrides env for this runner). */
  defaultModel?: string;
  /** Merged into `agent` subprocess env after `buildSubprocessEnv`. */
  subprocessEnv?: Record<string, string>;
  /**
   * When true, pass `--yolo`, `--trust`, and `-f` after `--workspace` (non-interactive / auto-approve),
   * aligned with `resolveProvider` `autoApprove`. When false, omit those flags.
   */
  autoApprove?: boolean;
}

/**
 * Map bridge permission modes to agent --mode flags.
 * 'acceptEdits' (code mode) → omit (default, full power)
 * 'plan' → --mode plan
 * 'default' (ask mode) → --mode ask
 */
function toAgentMode(permissionMode?: string): string | undefined {
  switch (permissionMode) {
    case 'plan': return 'plan';
    case 'default': return 'ask';
    default: return undefined;
  }
}

/**
 * Extract the tool name from a tool_call event's tool_call object.
 * The agent CLI nests tool details under keys like shellToolCall,
 * fileEditToolCall, readToolCall, etc.
 */
function extractToolName(toolCall: Record<string, unknown>): string {
  if (toolCall.shellToolCall) return 'Bash';
  if (toolCall.fileEditToolCall) return 'Edit';
  if (toolCall.readToolCall) return 'Read';
  if (toolCall.listToolCall) return 'List';
  if (toolCall.searchToolCall) return 'Search';
  if (toolCall.mcpToolCall) {
    const mcp = toolCall.mcpToolCall as Record<string, unknown>;
    const server = (mcp.serverName as string) || '';
    const tool = (mcp.toolName as string) || '';
    return `mcp__${server}__${tool}`;
  }
  const keys = Object.keys(toolCall).filter(k => k !== 'description');
  return keys[0]?.replace(/ToolCall$/, '') || 'Unknown';
}

/**
 * Extract the input summary from a tool_call event for display.
 */
function extractToolInput(toolCall: Record<string, unknown>): Record<string, unknown> {
  if (toolCall.shellToolCall) {
    const shell = toolCall.shellToolCall as Record<string, unknown>;
    const args = shell.args as Record<string, unknown> | undefined;
    return { command: args?.command || '' };
  }
  if (toolCall.fileEditToolCall) {
    const edit = toolCall.fileEditToolCall as Record<string, unknown>;
    const args = edit.args as Record<string, unknown> | undefined;
    return { file: args?.filePath || args?.path || '' };
  }
  if (toolCall.readToolCall) {
    const read = toolCall.readToolCall as Record<string, unknown>;
    const args = read.args as Record<string, unknown> | undefined;
    return { file: args?.filePath || args?.path || '' };
  }
  if (toolCall.mcpToolCall) {
    const mcp = toolCall.mcpToolCall as Record<string, unknown>;
    return (mcp.arguments as Record<string, unknown>) || {};
  }
  return {};
}

/**
 * Extract the result summary from a completed tool_call event.
 */
function extractToolResult(toolCall: Record<string, unknown>): { content: string; isError: boolean } {
  for (const val of Object.values(toolCall)) {
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (obj.result && typeof obj.result === 'object') {
        const result = obj.result as Record<string, unknown>;

        if (result.success && typeof result.success === 'object') {
          const success = result.success as Record<string, unknown>;
          const stdout = (success.stdout as string) || '';
          const stderr = (success.stderr as string) || '';
          const exitCode = success.exitCode as number | undefined;
          const content = (success.content as string) || '';
          const isError = exitCode != null && exitCode !== 0;
          return {
            content: content || stdout || stderr || (isError ? `Exit code: ${exitCode}` : 'Done'),
            isError,
          };
        }

        if (result.error && typeof result.error === 'object') {
          const error = result.error as Record<string, unknown>;
          return { content: (error.message as string) || 'Tool error', isError: true };
        }

        if (typeof result.content === 'string') {
          return { content: result.content, isError: false };
        }
      }
    }
  }
  return { content: 'Done', isError: false };
}

function createAbortError(): Error {
  const err = new Error('AbortError');
  err.name = 'AbortError';
  return err;
}

function cursorKillGraceMs(): number {
  const raw = Number(process.env.CTI_CURSOR_KILL_GRACE_MS || '2000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

export class CursorProvider implements LLMProvider {
  private spawnFn: SpawnFn;
  private agentPath?: string;
  private defaultModel?: string;
  private subprocessEnv?: Record<string, string>;
  private readonly autoApprove: boolean;

  constructor(spawnFn?: SpawnFn, opts?: CursorProviderOptions) {
    this.spawnFn = spawnFn ?? spawn;
    this.agentPath = opts?.agentPath;
    this.defaultModel = opts?.defaultModel;
    this.subprocessEnv = opts?.subprocessEnv;
    this.autoApprove = opts?.autoApprove ?? false;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          let forceKillTimer: NodeJS.Timeout | null = null;
          const clearForceKillTimer = () => {
            if (!forceKillTimer) return;
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          };
          try {
            const agentPath = resolveAgentPath(self.agentPath);
            const resolvedCwd = params.workingDirectory || process.cwd();
            const cwdExists = fs.existsSync(resolvedCwd);
            const agentArgs = [
              '--print',
              '--output-format', 'stream-json',
              ...(params.disableLlmStreaming ? [] : ['--stream-partial-output']),
            ];

            if (params.workingDirectory) {
              agentArgs.push('--workspace', params.workingDirectory);
            }

            const model = self.defaultModel || process.env.CTI_CURSOR_MODEL || params.model;
            if (model && !model.startsWith('claude')) {
              agentArgs.push('--model', model);
            }

            if (params.sdkSessionId) {
              agentArgs.push('--resume', params.sdkSessionId);
            }

            const mode = toAgentMode(params.permissionMode);
            if (mode) {
              agentArgs.push('--mode', mode);
            }

            // After --workspace so headless trust applies to the same path (see Cursor `agent --help`).
            // `--yolo` is an alias for `-f`/`--force`; include both trust + force for Workspace Trust on e.g. /tmp/wt-*.
            if (self.autoApprove) {
              agentArgs.push('--yolo', '--trust', '-f');
            }

            agentArgs.push('--', params.prompt);

            const { executable, args: spawnArgv, launchMode } = resolveCursorAgentSpawn(agentPath, agentArgs);

            const env = mergeRunnerSubprocessEnv(
              buildSubprocessEnvForRuntime({ runtime: 'cursor' }),
              { subprocessEnv: self.subprocessEnv },
            );
            
            // Only pass API key if explicitly configured for Cursor.
            // Don't fallback to OPENAI_API_KEY as it might be invalid for Cursor.
            const apiKey = process.env.CTI_CURSOR_API_KEY
              || process.env.CURSOR_API_KEY;
            if (apiKey) {
              env.CURSOR_API_KEY = apiKey;
            } else {
              // Explicitly unset these to prevent invalid keys from being inherited
              delete env.CURSOR_API_KEY;
              delete env.OPENAI_API_KEY;
            }

            console.error(
              `[cursor-provider] Launching agent: launchMode=${launchMode} executable=${executable} ` +
              `agentPath=${agentPath} cwd=${resolvedCwd} cwdExists=${cwdExists} ` +
              `autoApprove=${self.autoApprove} sessionId=${params.sessionId ?? '-'} sdkSessionId=${params.sdkSessionId ?? '-'} ` +
              `params.model=${params.model ?? '-'} effectiveModel=${model ?? '-'} permissionMode=${params.permissionMode ?? '-'} ` +
              `child env: ${formatProviderEnvKeysForLog(env, CURSOR_PROVIDER_LOG_ENV_KEYS)}`,
            );

            let child: ChildProcess;
            try {
              child = self.spawnFn(executable, spawnArgv, {
                env,
                cwd: resolvedCwd,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
            } catch (spawnError) {
              const error = spawnError instanceof Error ? spawnError : new Error(String(spawnError));
              console.error(
                `[cursor-provider] Spawn failed before process start: launchMode=${launchMode} executable=${executable} ` +
                `agentPath=${agentPath} cwd=${resolvedCwd} ` +
                `cwdExists=${cwdExists} sessionId=${params.sessionId ?? '-'} sdkSessionId=${params.sdkSessionId ?? '-'} ` +
                `code=${(error as NodeJS.ErrnoException).code ?? '-'} message=${error.message}`
              );
              throw error;
            }

            let aborted = params.abortController?.signal.aborted === true;
            if (params.abortController) {
              params.abortController.signal.addEventListener('abort', () => {
                aborted = true;
                child.kill('SIGTERM');
                if (!forceKillTimer) {
                  forceKillTimer = setTimeout(() => {
                    try {
                      child.kill('SIGKILL');
                    } catch {
                      /* already exited */
                    }
                  }, cursorKillGraceMs());
                }
              });
            }

            const rl = createInterface({ input: child.stdout! });
            let sessionId: string | undefined;
            let sawResult = false;
            // Dedup buffer: tracks text emitted in the current assistant turn.
            // If a new event's text matches the buffer exactly, it's a
            // duplicate final event — skip it and reset for the next turn.
            let turnEmitted = '';

            rl.on('line', (line) => {
              if (!line.trim()) return;
              let event: Record<string, unknown>;
              try { event = JSON.parse(line); } catch { return; }

              const type = event.type as string;
              const subtype = event.subtype as string | undefined;

              switch (type) {
                case 'system': {
                  if (subtype === 'init') {
                    sessionId = event.session_id as string;
                    controller.enqueue(sseEvent('status', {
                      session_id: sessionId,
                      model: event.model,
                    }));
                  }
                  break;
                }

                case 'assistant': {
                  const msg = event.message as Record<string, unknown> | undefined;
                  const content = msg?.content as Array<Record<string, unknown>> | undefined;
                  if (!content) break;

                  for (const block of content) {
                    if (block.type !== 'text' || !block.text) continue;
                    const text = block.text as string;

                    if (turnEmitted && turnEmitted === text) {
                      // Already emitted this exact text via deltas — skip
                      turnEmitted = '';
                    } else {
                      controller.enqueue(sseEvent('text', text));
                      turnEmitted += text;
                    }
                  }
                  break;
                }

                case 'tool_call': {
                  const callId = event.call_id as string || `tool-${Date.now()}`;
                  const toolCall = event.tool_call as Record<string, unknown> || {};

                  if (subtype === 'started') {
                    controller.enqueue(sseEvent('tool_use', {
                      id: callId,
                      name: extractToolName(toolCall),
                      input: extractToolInput(toolCall),
                    }));
                  } else if (subtype === 'completed') {
                    const { content, isError } = extractToolResult(toolCall);
                    controller.enqueue(sseEvent('tool_result', {
                      tool_use_id: callId,
                      content,
                      is_error: isError,
                    }));
                  }
                  break;
                }

                case 'result': {
                  sawResult = true;
                  const usage = event.usage as Record<string, unknown> | undefined;
                  controller.enqueue(sseEvent('result', {
                    usage: usage ? {
                      input_tokens: usage.inputTokens ?? 0,
                      output_tokens: usage.outputTokens ?? 0,
                      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
                    } : undefined,
                    ...(sessionId ? { session_id: sessionId } : {}),
                  }));

                  if (subtype === 'error' || event.is_error) {
                    const errMsg = (event.result as string) || 'Agent error';
                    controller.enqueue(sseEvent('error', errMsg));
                  }
                  break;
                }

                // thinking events — skip (internal reasoning)
              }
            });

            let stderr = '';
            child.stderr!.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });

            await new Promise<void>((resolve, reject) => {
              child.on('close', (code, signal) => {
                clearForceKillTimer();
                if (aborted || params.abortController?.signal.aborted) {
                  reject(createAbortError());
                  return;
                }
                if (signal) {
                  reject(new Error(
                    `[cursor-provider] agent exited with signal ${signal}` +
                    (stderr ? `\n${stderr.slice(0, 500)}` : '')
                  ));
                  return;
                }
                if (code && code !== 0 && !sessionId) {
                  reject(new Error(
                    `[cursor-provider] agent exited with code ${code}` +
                    (stderr ? `\n${stderr.slice(0, 500)}` : '')
                  ));
                } else if (sessionId && !sawResult) {
                  reject(new Error(
                    '[cursor-provider] agent exited before emitting a terminal result event' +
                    (stderr ? `\n${stderr.slice(0, 500)}` : '')
                  ));
                } else {
                  resolve();
                }
              });
              child.on('error', (childError) => {
                const error = childError instanceof Error ? childError : new Error(String(childError));
                const errSpawnArgs = (error as NodeJS.ErrnoException & { spawnargs?: unknown }).spawnargs;
                console.error(
                  `[cursor-provider] Child process error: launchMode=${launchMode} executable=${executable} ` +
                  `agentPath=${agentPath} cwd=${resolvedCwd} ` +
                  `cwdExists=${cwdExists} sessionId=${params.sessionId ?? '-'} sdkSessionId=${params.sdkSessionId ?? '-'} ` +
                  `code=${(error as NodeJS.ErrnoException).code ?? '-'} errno=${(error as NodeJS.ErrnoException).errno ?? '-'} ` +
                  `syscall=${(error as NodeJS.ErrnoException).syscall ?? '-'} path=${(error as NodeJS.ErrnoException).path ?? '-'} ` +
                  `spawnargs=${JSON.stringify(errSpawnArgs ?? spawnArgv)}`
                );
                reject(error);
              });
            });

            controller.close();
          } catch (err) {
            clearForceKillTimer();
            const message = err instanceof Error ? err.message : String(err);
            console.error('[cursor-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch { /* already closed */ }
          }
        })();
      },
    });
  }
}
