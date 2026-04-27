/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the claude-to-im bridge conversation engine.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, StreamChatParams, FileAttachment } from './lib/bridge/host';
import type { PendingPermissions } from './permission-gateway';
import { getLogger } from './logger';

import { sseEvent } from './sse-utils';
import { applySubprocessProxyPolicyForRuntime } from './lib/proxy-env';
import { reportProviderError, runProviderAsync, safeClose, safeEnqueue } from './provider-stream-safety';

const llmProviderLog = getLogger().child({ scope: 'llm-provider' });

const CLAUDE_SDK_STREAM_LOG = 'claude-sdk';

// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

// ── Auth/credential-error detection ──

/** Patterns indicating the local CLI is not logged in (fixable via `claude auth login`). */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, org restriction).
 * Must be specific to API/auth context — avoid matching local file permissions, tool denials,
 * or generic HTTP 403s that may have non-auth causes.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = 'cli' | 'api' | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue, or neither.
 * Returns 'cli' for local auth problems, 'api' for remote credential problems, false otherwise.
 */
export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

/** Backwards-compatible: returns true for any auth/credential error. */
export function isAuthError(text: string): boolean {
  return classifyAuthError(text) !== false;
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

// ── Cross-runtime model guard ──

const NON_CLAUDE_MODEL_RE = /^(gpt-|o[1-9][-_]|codex[-_]|davinci|text-|openai\/)/i;

/** Return true if a model name clearly belongs to a non-Claude provider. */
export function isNonClaudeModel(model?: string): boolean {
  return !!model && NON_CLAUDE_MODEL_RE.test(model);
}

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "inherit"):
 *   "inherit" — full parent env minus CLAUDECODE (recommended; daemon
 *               already runs in a clean launchd/setsid environment)
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* from config.env
 */
export function buildSubprocessEnv(): NodeJS.ProcessEnv {
  return buildSubprocessEnvForRuntime();
}

export interface BuildSubprocessEnvOptions {
  runtime?: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'auto';
  useLogin?: boolean;
}

export function buildSubprocessEnvForRuntime(
  options: BuildSubprocessEnvOptions = {},
): NodeJS.ProcessEnv {
  const mode = process.env.CTI_ENV_ISOLATION || 'inherit';
  const out = {} as NodeJS.ProcessEnv;
  const runtime = options.runtime || (process.env.CTI_RUNTIME as 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'auto' | undefined) || 'claude';
  const useLogin = options.useLogin === true;

  if (mode === 'inherit') {
    // Pass everything except always-stripped vars
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    // Strict: whitelist only
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      // Pass through CTI_* so skill config is available
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    // Always pass through ANTHROPIC_* in claude runtime —
    // third-party API providers need these to reach the CLI subprocess.
    if (runtime === 'claude' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }

    // In codex/cursor/copilot/opencode mode, pass through provider-related env vars
    if (runtime === 'codex' || runtime === 'cursor' || runtime === 'copilot' || runtime === 'opencode' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (
          k.startsWith('OPENAI_') ||
          k.startsWith('CODEX_') ||
          k.startsWith('CURSOR_') ||
          k.startsWith('GITHUB_') ||
          k.startsWith('GH_') ||
          k.startsWith('COPILOT_') ||
          k.startsWith('OPENCODE_')
        ) {
          out[k] = v;
        }
      }
    }
  }

  // Runner-level login mode should ignore explicit API credentials so the CLI
  // uses its own authenticated session instead of ANTHROPIC_* env vars.
  if (useLogin && (runtime === 'claude' || runtime === 'auto')) {
    for (const key of Object.keys(out)) {
      if (key.startsWith('ANTHROPIC_')) delete out[key];
    }
  }

  applySubprocessProxyPolicyForRuntime(out, runtime, { useLogin });
  return out;
}

/** Merge runner-specific `subprocessEnv` on top of `buildSubprocessEnv*` output (CLI child env). */
export function mergeRunnerSubprocessEnv(
  base: NodeJS.ProcessEnv,
  runner?: { subprocessEnv?: Record<string, string> },
): NodeJS.ProcessEnv {
  const extra = runner?.subprocessEnv;
  if (!extra || Object.keys(extra).length === 0) return base;
  return { ...base, ...extra };
}

// ── Claude runner env logging (masked) ──

/** Env keys always considered when logging the Claude subprocess env. */
const CLAUDE_RUNNER_LOG_EXACT_KEYS = [
  'CTI_CLAUDE_CODE_EXECUTABLE',
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const;

// ── Shared provider launch logs (all runtimes; secrets masked) ──

/** Proxy-related keys included in provider spawn diagnostics. */
export const PROVIDER_LOG_PROXY_KEYS = [
  'CTI_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
] as const;

const PROVIDER_LOG_PLAIN_KEYS = new Set([
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_CODEX_USE_LOGIN',
  'ANTHROPIC_BASE_URL',
  'CTI_CODEX_BASE_URL',
  'CTI_CURSOR_BASE_URL',
  'NODE_EXTRA_CA_CERTS',
  'CTI_CLAUDE_CODE_EXECUTABLE',
  'CTI_CURSOR_AGENT_LAUNCH',
  'CTI_PROXYCHAINS_EXECUTABLE',
]);

function maskSecretTailOnly(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(Math.min(value.length - 4, 24)) + value.slice(-4);
}

/**
 * Mask or pass through a single env value for provider diagnostics.
 * URLs and non-secret config values may be logged verbatim (see {@link PROVIDER_LOG_PLAIN_KEYS}).
 */
export function maskEnvValueForProviderLog(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '(unset)';
  if (PROVIDER_LOG_PLAIN_KEYS.has(key)) return value;
  return maskSecretTailOnly(value);
}

/**
 * One-line summary of selected env keys (masked) for console diagnostics.
 */
export function formatProviderEnvKeysForLog(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string {
  return keys.map((k) => `${k}=${maskEnvValueForProviderLog(k, env[k])}`).join(' ');
}

/** Env keys logged for Codex SDK / CLI child (first init). */
export const CODEX_PROVIDER_LOG_ENV_KEYS = [
  ...PROVIDER_LOG_PROXY_KEYS,
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_CODEX_USE_LOGIN',
  'CTI_CODEX_BASE_URL',
  'CTI_CODEX_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
] as const;

/** Env keys logged for Cursor `agent` subprocess. */
export const CURSOR_PROVIDER_LOG_ENV_KEYS = [
  ...PROVIDER_LOG_PROXY_KEYS,
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_CURSOR_MODEL',
  'CTI_CURSOR_BASE_URL',
  'CTI_CURSOR_API_KEY',
  'CTI_CURSOR_EXECUTABLE',
  'CURSOR_API_KEY',
  'OPENAI_API_KEY',
] as const;

/** Env keys logged for Copilot CLI subprocess. */
export const COPILOT_PROVIDER_LOG_ENV_KEYS = [
  ...PROVIDER_LOG_PROXY_KEYS,
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_COPILOT_MODEL',
  'CTI_COPILOT_EXECUTABLE',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const;

/** Env keys logged for OpenCode CLI subprocess. */
export const OPENCODE_PROVIDER_LOG_ENV_KEYS = [
  ...PROVIDER_LOG_PROXY_KEYS,
  'CTI_ENV_ISOLATION',
  'CTI_RUNTIME',
  'CTI_OPENCODE_MODEL',
  'CTI_OPENCODE_EXECUTABLE',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_SERVER_PASSWORD',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

function maskEnvScalar(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

function maskEnvValueForClaudeLog(key: string, value: string): string {
  if (
    key === 'CTI_ENV_ISOLATION' ||
    key === 'CTI_RUNTIME' ||
    key === 'CTI_CLAUDE_CODE_EXECUTABLE' ||
    key === 'ANTHROPIC_BASE_URL' ||
    key === 'NODE_EXTRA_CA_CERTS'
  ) {
    return value;
  }
  return maskEnvScalar(value);
}

function shouldIncludeKeyInClaudeRunnerLog(key: string): boolean {
  if ((CLAUDE_RUNNER_LOG_EXACT_KEYS as readonly string[]).includes(key)) return true;
  if (key.startsWith('ANTHROPIC_')) return true;
  if (key.startsWith('CTI_') && /CLAUDE/i.test(key)) return true;
  return false;
}

/**
 * Snapshot of Claude-relevant env entries passed to the SDK subprocess (secrets masked).
 * @internal Exported for tests.
 */
export function buildClaudeRunnerEnvSnapshotForLog(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = new Set<string>();
  for (const k of Object.keys(env)) {
    if (shouldIncludeKeyInClaudeRunnerLog(k)) keys.add(k);
  }
  for (const k of CLAUDE_RUNNER_LOG_EXACT_KEYS) {
    if (env[k] !== undefined) keys.add(k);
  }
  for (const k of Array.from(keys).sort()) {
    const v = env[k];
    if (v === undefined) continue;
    out[k] = maskEnvValueForClaudeLog(k, v);
  }
  return out;
}

/** Codex SDK `env` option is `Record<string, string>` (no undefined values). */
export function coerceProcessEnvToStringRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── Claude CLI path resolution ──

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * Returns undefined if parsing fails.
 */
export function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve all `claude` executables found in PATH (Unix only).
 * Returns an array of absolute paths.
 */
function findAllInPath(): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
  try {
    // `which -a` lists all matches, not just the first
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Resolve the path to the `claude` CLI executable.
 *
 * Priority:
 *   1. `CTI_CLAUDE_CODE_EXECUTABLE` — explicit path (must be executable)
 *   2. Every `claude` on `PATH` (Unix: `which -a claude`)
 *   3. Common install locations — first match wins
 *
 * No version or `--help` flag checks at startup; incompatible CLIs fail when a message runs.
 */
export function resolveClaudeCliPath(): string | undefined {
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const isWindows = process.platform === 'win32';
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
      ];

  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  for (const p of allCandidates) {
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/**
 * Prefer per-runner `claudeExecutable`, then global resolution.
 */
export function resolveClaudeCliPathFromRunner(runner?: { claudeExecutable?: string }): string | undefined {
  const explicit = runner?.claudeExecutable?.trim();
  if (explicit) {
    try {
      if (fs.existsSync(explicit)) return explicit;
    } catch {
      /* noop */
    }
  }
  return resolveClaudeCliPath();
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

/**
 * Mutable state shared between the streaming loop and catch block.
 *
 * Key distinction:
 *   hasReceivedResult — set when the SDK delivers a `result` message
 *     (success OR structured error). This means the CLI completed its
 *     business logic; any subsequent "process exited with code 1" is
 *     just the transport tearing down and should be suppressed.
 *
 *   hasStreamedText — set when at least one text_delta was emitted.
 *     Used to distinguish "partial output + crash" (real failure, must
 *     emit error) from "business error only in assistant block" (use
 *     lastAssistantText instead of generic error).
 */
export interface StreamState {
  /** True once a `result` message (success or error subtype) has been processed. */
  hasReceivedResult: boolean;
  /** True once any text_delta has been emitted via stream_event. */
  hasStreamedText: boolean;
  /**
   * Full text captured from the final `assistant` message.
   * NOT emitted during normal flow (stream_event deltas handle that).
   * Used by the catch block to surface business errors that arrived
   * as assistant text but were followed by a CLI crash.
   */
  lastAssistantText: string;
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;
  private useLogin: boolean;
  private subprocessEnv?: Record<string, string>;

  constructor(
    private pendingPerms: PendingPermissions,
    cliPath?: string,
    autoApprove = false,
    useLogin = false,
    subprocessEnv?: Record<string, string>,
  ) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
    this.useLogin = useLogin;
    this.subprocessEnv = subprocessEnv;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;
    const useLogin = this.useLogin;
    const subprocessEnv = this.subprocessEnv;

    return new ReadableStream({
      start(controller) {
        runProviderAsync(controller, CLAUDE_SDK_STREAM_LOG, async () => {
          const emit = (chunk: string) => safeEnqueue(controller, chunk, CLAUDE_SDK_STREAM_LOG);
          // Ring-buffer for recent stderr output (max 4 KB)
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: StreamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };

          try {
            const cleanEnv = mergeRunnerSubprocessEnv(
              buildSubprocessEnvForRuntime({
                runtime: 'claude',
                useLogin,
              }),
              subprocessEnv ? { subprocessEnv } : undefined,
            );

            // Cross-runtime migration safety: drop non-Claude model names
            // that may linger in session data from a previous Codex runtime.
            let model = params.model;
            if (isNonClaudeModel(model)) {
              llmProviderLog.warn({ model }, 'Ignoring non-Claude model name, using CLI default');
              model = undefined;
            }

            llmProviderLog.info(
              {
                useLogin,
                cliPath: cliPath || undefined,
                cwd: params.workingDirectory,
                paramsModel: params.model,
                resolvedModel: model,
                sessionId: params.sessionId,
                sdkSessionId: params.sdkSessionId,
                proxyEnvLine: formatProviderEnvKeysForLog(cleanEnv, PROVIDER_LOG_PROXY_KEYS),
                claudeSubprocessEnv: buildClaudeRunnerEnvSnapshotForLog(cleanEnv),
              },
              'Claude runner: subprocess env (masked; passed to Claude Code SDK)',
            );
            console.log(
              `[claude-sdk] streamChat: cwd=${params.workingDirectory ?? '-'} paramsModel=${params.model ?? '-'} ` +
              `resolvedModel=${model ?? '-'} sessionId=${params.sessionId ?? '-'} sdkSessionId=${params.sdkSessionId ?? '-'} ` +
              `useLogin=${useLogin} cliPath=${cliPath ?? '-'} ` +
              `proxy=${formatProviderEnvKeysForLog(cleanEnv, PROVIDER_LOG_PROXY_KEYS)}`,
            );

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: !(params.disableLlmStreaming ?? false),
              env: cleanEnv,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<PermissionResult> => {
                  // Auto-approve if configured (useful for channels without
                  // interactive permission UI, e.g. Feishu WebSocket mode)
                  if (autoApprove) {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }

                  // Emit permission_request SSE event for the bridge
                  emit(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  // Block until IM user responds
                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }
            if (params.systemPrompt) {
              queryOptions.systemPrompt = params.systemPrompt;
            }
            if (params.allowedTools) {
              queryOptions.allowedTools = params.allowedTools;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            const handleOpts = { disableLlmStreaming: params.disableLlmStreaming ?? false };
            for await (const msg of q) {
              handleMessage(msg, controller, state, handleOpts);
            }

            safeClose(controller, CLAUDE_SDK_STREAM_LOG);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isTransportExit = message.includes('process exited with code');

            // ── Case 1: Result already received ──
            // The SDK throws when the CLI exits non-zero (see ProcessTransport
            // getProcessExitError in claude-agent-sdk). The child often exits
            // with code 1 after stdin closes even though JSON stream already
            // delivered a `result` — not a failed turn. Avoid level-50 noise.
            if (state.hasReceivedResult && isTransportExit) {
              llmProviderLog.info(
                { stderrTail: stderrBuf.trim().slice(-500) || undefined },
                'Claude CLI exited after successful result (non-zero exit is normal teardown; turn already completed)',
              );
              safeClose(controller, CLAUDE_SDK_STREAM_LOG);
              return;
            }

            llmProviderLog.error(
              { err, stderrFromCli: stderrBuf.trim() || undefined },
              'SDK query error',
            );

            // ── Case 2: Recognised business error in assistant text ──
            // The CLI returned an assistant message with text that matches
            // a known auth/access error pattern (e.g. "Your organization
            // does not have access to Claude"). Forward it as-is — it's
            // more informative than the generic transport error.
            // Only activate when the text is a recognised error; otherwise
            // a normal response that crashed before result would be silently
            // presented as if it succeeded.
            if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
              emit(sseEvent('text', state.lastAssistantText));
              safeClose(controller, CLAUDE_SDK_STREAM_LOG);
              return;
            }

            // ── Case 3: Partial output + crash ──
            // Text was streamed but no result arrived — the response was
            // truncated by a real crash. Always emit an error so the user
            // knows the output is incomplete.

            // ── Build user-facing error message ──
            const authKind = classifyAuthError(message) || classifyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === 'cli') {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === 'api') {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• Claude CLI not authenticated — run: claude auth login',
                '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                '• Missing ANTHROPIC_* env vars in daemon — check config.env',
                '',
                'Run `/claude-to-im doctor` to diagnose.',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            emit(sseEvent('error', userMessage));
            safeClose(controller, CLAUDE_SDK_STREAM_LOG);
          }
        });
      },
    });
  }
}

/** @internal Exported for testing. */
export function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
  opts?: { disableLlmStreaming?: boolean },
): void {
  try {
    handleMessageInner(msg, controller, state, opts);
  } catch (err) {
    reportProviderError(controller, err, CLAUDE_SDK_STREAM_LOG);
  }
}

function handleMessageInner(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
  opts?: { disableLlmStreaming?: boolean },
): void {
  const emit = (chunk: string) => safeEnqueue(controller, chunk, CLAUDE_SDK_STREAM_LOG);
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        if (opts?.disableLlmStreaming) break;
        // Emit delta text — the bridge accumulates on its side
        emit(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        emit(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — capture text but do NOT emit it.
      // Text deltas are already streamed via stream_event above; emitting
      // the full text block here would duplicate the entire response.
      //
      // The captured text is used by the catch block to surface business
      // errors (e.g. "Your organization does not have access") that the
      // CLI returned as assistant text without prior streaming deltas.
      if (msg.message?.content) {
        const blocks = msg.message.content;
        if (opts?.disableLlmStreaming) {
          let pendingText = '';
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              pendingText += (pendingText ? '\n\n' : '') + block.text;
              state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
            } else if (block.type === 'tool_use') {
              if (pendingText && !state.hasStreamedText) {
                emit(sseEvent('text', pendingText));
                state.hasStreamedText = true;
                pendingText = '';
              }
              emit(
                sseEvent('tool_use', {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                }),
              );
            }
          }
          if (pendingText && !state.hasStreamedText) {
            emit(sseEvent('text', pendingText));
            state.hasStreamedText = true;
          }
          break;
        }
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            emit(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            emit(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        // Some Claude SDK error turns arrive as:
        //   assistant(text with the real explanation)
        //   result(subtype=success, is_error=true)
        // without any prior text_delta events. In that case, the bridge would
        // otherwise see hasError with no responseText and only render a generic
        // Error: line. Surface the assistant text once here as the canonical
        // user-facing body for that error turn.
        if (msg.is_error && !state.hasStreamedText && state.lastAssistantText.trim()) {
          emit(sseEvent('text', state.lastAssistantText.trim()));
          state.hasStreamedText = true;
        }
        emit(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            /** Present on SDK success result; often explains turns that end with is_error. */
            result: msg.result,
            stop_reason: msg.stop_reason,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // Error result from SDK (distinct from transport errors in catch)
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        emit(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        emit(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}
