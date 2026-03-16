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

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { LLMProvider, StreamChatParams } from './lib/bridge/host';
import { sseEvent } from './sse-utils';
import { buildSubprocessEnv } from './llm-provider';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

function resolveAgentPath(): string {
  return process.env.CTI_CURSOR_EXECUTABLE || 'agent';
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

export class CursorProvider implements LLMProvider {
  private spawnFn: SpawnFn;

  constructor(spawnFn?: SpawnFn) {
    this.spawnFn = spawnFn ?? spawn;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            const agentPath = resolveAgentPath();
            const args = [
              '--print',
              '--output-format', 'stream-json',
              '--stream-partial-output',
              '--yolo',
              '--trust',
            ];

            if (params.workingDirectory) {
              args.push('--workspace', params.workingDirectory);
            }
            
            const model = process.env.CTI_CURSOR_MODEL || params.model;
            if (model && !model.startsWith('claude')) {
              args.push('--model', model);
            }
            
            if (params.sdkSessionId) {
              args.push('--resume', params.sdkSessionId);
            }

            const mode = toAgentMode(params.permissionMode);
            if (mode) {
              args.push('--mode', mode);
            }

            args.push('--', params.prompt);

            const env = buildSubprocessEnv();
            
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

            const child = self.spawnFn(agentPath, args, {
              env,
              cwd: params.workingDirectory || process.cwd(),
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            if (params.abortController) {
              params.abortController.signal.addEventListener('abort', () => {
                child.kill('SIGTERM');
              });
            }

            const rl = createInterface({ input: child.stdout! });
            let sessionId: string | undefined;
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
              child.on('close', (code) => {
                if (code && code !== 0 && !sessionId) {
                  reject(new Error(
                    `[cursor-provider] agent exited with code ${code}` +
                    (stderr ? `\n${stderr.slice(0, 500)}` : '')
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
