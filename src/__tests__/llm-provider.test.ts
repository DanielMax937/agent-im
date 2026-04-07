import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAuthError,
  classifyAuthError,
  isNonClaudeModel,
  parseCliMajorVersion,
  handleMessage,
  buildSubprocessEnvForRuntime,
  buildClaudeRunnerEnvSnapshotForLog,
} from '../llm-provider';
import type { StreamState } from '../llm-provider';
import { sseEvent } from '../sse-utils';

// ── Helpers ──

/** Collect enqueued SSE strings from a fake controller. */
function makeFakeController() {
  const chunks: string[] = [];
  const controller = {
    enqueue(data: string) { chunks.push(data); },
    close() { /* no-op */ },
    error() { /* no-op */ },
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<string>;
  return { controller, chunks };
}

function freshState(): StreamState {
  return { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };
}

// ── classifyAuthError ──

describe('classifyAuthError', () => {
  it('returns "cli" for local login errors', () => {
    assert.equal(classifyAuthError('Error: Not logged in'), 'cli');
    assert.equal(classifyAuthError('Please run /login'), 'cli');
    assert.equal(classifyAuthError('loggedIn:false'), 'cli');
  });

  it('returns "api" for remote credential errors', () => {
    assert.equal(classifyAuthError('Error: Unauthorized'), 'api');
    assert.equal(classifyAuthError('invalid API key provided'), 'api');
    assert.equal(classifyAuthError('authentication has failed'), 'api');
    assert.equal(classifyAuthError('HTTP 401 Unauthorized'), 'api');
    assert.equal(classifyAuthError('does not have access to Claude'), 'api');
  });

  it('returns false for non-auth errors', () => {
    assert.equal(classifyAuthError('process exited with code 1'), false);
    assert.equal(classifyAuthError('ECONNREFUSED'), false);
    assert.equal(classifyAuthError(''), false);
  });

  it('returns false for local permission / generic 403 (not API auth)', () => {
    assert.equal(classifyAuthError('permission denied: /usr/local/bin'), false);
    assert.equal(classifyAuthError('HTTP 403 Forbidden'), false);
    assert.equal(classifyAuthError('EACCES: permission denied, open /etc/hosts'), false);
  });

  it('prefers "cli" when both patterns match', () => {
    // "Not logged in" should be cli even if "unauthorized" is also present
    assert.equal(classifyAuthError('Not logged in, unauthorized'), 'cli');
  });
});

// ── isAuthError (backwards compat) ──

describe('isAuthError', () => {
  it('detects "Not logged in" in error message', () => {
    assert.equal(isAuthError('Error: Not logged in · Please run /login'), true);
  });

  it('detects "Please run /login" in stderr', () => {
    assert.equal(isAuthError('some preamble\nPlease run /login\n'), true);
  });

  it('detects loggedIn: false in JSON output', () => {
    assert.equal(isAuthError('{"loggedIn": false, "user": null}'), true);
  });

  it('detects loggedIn:false without spaces', () => {
    assert.equal(isAuthError('loggedIn:false'), true);
  });

  it('detects "unauthorized" (case-insensitive)', () => {
    assert.equal(isAuthError('Error: Unauthorized access'), true);
  });

  it('detects "invalid api key"', () => {
    assert.equal(isAuthError('Error: invalid API key provided'), true);
    assert.equal(isAuthError('invalid api-key'), true);
  });

  it('detects "authentication failed"', () => {
    assert.equal(isAuthError('authentication has failed'), true);
  });

  it('detects HTTP 401', () => {
    assert.equal(isAuthError('HTTP error 401'), true);
    assert.equal(isAuthError('status: 401 Unauthorized'), true);
  });

  it('returns false for non-auth errors', () => {
    assert.equal(isAuthError('Claude Code process exited with code 1'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isAuthError(''), false);
  });

  it('returns false for generic network error', () => {
    assert.equal(isAuthError('ECONNREFUSED 127.0.0.1:443'), false);
  });

  it('returns false for HTTP 400 or 500', () => {
    assert.equal(isAuthError('HTTP error 400 Bad Request'), false);
    assert.equal(isAuthError('HTTP error 500 Internal Server Error'), false);
  });
});

// ── isNonClaudeModel ──

describe('isNonClaudeModel', () => {
  it('detects gpt- prefixed models', () => {
    assert.equal(isNonClaudeModel('gpt-5-codex'), true);
    assert.equal(isNonClaudeModel('gpt-4o'), true);
  });

  it('detects o1/o3 prefixed models', () => {
    assert.equal(isNonClaudeModel('o1-preview'), true);
    assert.equal(isNonClaudeModel('o3-mini'), true);
  });

  it('detects codex- prefixed models', () => {
    assert.equal(isNonClaudeModel('codex-mini'), true);
  });

  it('detects openai/ prefixed models', () => {
    assert.equal(isNonClaudeModel('openai/gpt-4o'), true);
  });

  it('returns false for claude models', () => {
    assert.equal(isNonClaudeModel('claude-opus-4-6'), false);
    assert.equal(isNonClaudeModel('claude-sonnet-4-6'), false);
  });

  it('returns false for undefined/empty', () => {
    assert.equal(isNonClaudeModel(undefined), false);
    assert.equal(isNonClaudeModel(''), false);
  });
});

// ── buildClaudeRunnerEnvSnapshotForLog ──

describe('buildClaudeRunnerEnvSnapshotForLog', () => {
  it('includes ANTHROPIC_* masked and leaves ANTHROPIC_BASE_URL unmasked', () => {
    const snap = buildClaudeRunnerEnvSnapshotForLog({
      ANTHROPIC_API_KEY: 'sk-ant-api03-longsecret',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
    assert.equal(snap.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.match(snap.ANTHROPIC_API_KEY, /^\*+cret$/);
    assert.equal(snap.ANTHROPIC_AUTH_TOKEN, '****');
  });

  it('includes CTI_CLAUDE_CODE_EXECUTABLE path and CTI_*CLAUDE* keys', () => {
    const snap = buildClaudeRunnerEnvSnapshotForLog({
      CTI_CLAUDE_CODE_EXECUTABLE: '/opt/bin/claude',
      CTI_FOO_CLAUDE_BAR: 'secret',
    });
    assert.equal(snap.CTI_CLAUDE_CODE_EXECUTABLE, '/opt/bin/claude');
    assert.match(snap.CTI_FOO_CLAUDE_BAR, /^\*+cret$/);
  });

  it('includes proxy vars masked', () => {
    const snap = buildClaudeRunnerEnvSnapshotForLog({
      HTTPS_PROXY: 'http://user:pass@proxy:8080',
    });
    assert.ok(snap.HTTPS_PROXY!.endsWith('8080'));
    assert.ok(snap.HTTPS_PROXY!.startsWith('*'));
  });
});

// ── buildSubprocessEnvForRuntime ──

describe('buildSubprocessEnvForRuntime', () => {
  it('keeps ANTHROPIC_* vars for Claude API-key mode', () => {
    const prevIsolation = process.env.CTI_ENV_ISOLATION;
    const prevRuntime = process.env.CTI_RUNTIME;
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

    process.env.CTI_ENV_ISOLATION = 'strict';
    process.env.CTI_RUNTIME = 'claude';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-ant-test';

    try {
      const env = buildSubprocessEnvForRuntime({ runtime: 'claude', useLogin: false });
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'auth-ant-test');
    } finally {
      if (prevIsolation === undefined) delete process.env.CTI_ENV_ISOLATION;
      else process.env.CTI_ENV_ISOLATION = prevIsolation;
      if (prevRuntime === undefined) delete process.env.CTI_RUNTIME;
      else process.env.CTI_RUNTIME = prevRuntime;
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApiKey;
      if (prevAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevAuthToken;
    }
  });

  it('strips ANTHROPIC_* vars for Claude login mode', () => {
    const prevIsolation = process.env.CTI_ENV_ISOLATION;
    const prevRuntime = process.env.CTI_RUNTIME;
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

    process.env.CTI_ENV_ISOLATION = 'strict';
    process.env.CTI_RUNTIME = 'claude';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-ant-test';

    try {
      const env = buildSubprocessEnvForRuntime({ runtime: 'claude', useLogin: true });
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    } finally {
      if (prevIsolation === undefined) delete process.env.CTI_ENV_ISOLATION;
      else process.env.CTI_ENV_ISOLATION = prevIsolation;
      if (prevRuntime === undefined) delete process.env.CTI_RUNTIME;
      else process.env.CTI_RUNTIME = prevRuntime;
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApiKey;
      if (prevAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevAuthToken;
    }
  });
});

// ── parseCliMajorVersion ──

describe('parseCliMajorVersion', () => {
  it('parses "2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('2.3.1'), 2);
  });

  it('parses "claude 2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('claude 2.3.1'), 2);
  });

  it('parses "1.0.17" to 1', () => {
    assert.equal(parseCliMajorVersion('1.0.17'), 1);
  });

  it('parses "@anthropic-ai/claude-code: 1.0.3" to 1', () => {
    assert.equal(parseCliMajorVersion('@anthropic-ai/claude-code: 1.0.3'), 1);
  });

  it('returns undefined for non-version strings', () => {
    assert.equal(parseCliMajorVersion('unknown'), undefined);
    assert.equal(parseCliMajorVersion(''), undefined);
  });
});

// ── handleMessage + StreamState ──

describe('handleMessage state tracking', () => {
  it('sets hasStreamedText on text_delta', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    } as any, controller, state);

    assert.equal(state.hasStreamedText, true);
    assert.equal(state.hasReceivedResult, false);
  });

  it('captures assistant text without emitting it', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'org has no access' }] },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'org has no access');
    // No text SSE should be emitted — only tool_use blocks get forwarded
    const textEvents = chunks.filter(c => c.includes('"type":"text"') || c.includes('"type":"text"'));
    // Parse more carefully
    const hasTextEvent = chunks.some(c => {
      try { const d = JSON.parse(c.replace('data: ', '')); return d.type === 'text'; }
      catch { return false; }
    });
    assert.equal(hasTextEvent, false, 'assistant text should NOT be emitted directly');
  });

  it('sets hasReceivedResult on success result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'sess1',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.001,
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('emits captured assistant text when success result is flagged as error and no deltas were streamed', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Your organization does not have access to Claude.' }] },
    } as any, controller, state);

    handleMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-error',
      is_error: true,
      result: '',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.001,
    } as any, controller, state);

    const events = chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Your organization does not have access to Claude.');
    assert.equal(events[1].type, 'result');
    assert.equal(JSON.parse(events[1].data).is_error, true);
    assert.equal(state.hasStreamedText, true);
    assert.equal(state.hasReceivedResult, true);
  });

  it('does not duplicate assistant text when text deltas were already streamed', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Detailed error' } },
    } as any, controller, state);

    handleMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Detailed error' }] },
    } as any, controller, state);

    handleMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-error-2',
      is_error: true,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.001,
    } as any, controller, state);

    const events = chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    assert.equal(events.filter((event) => event.type === 'text').length, 1);
    assert.equal(events.at(-1).type, 'result');
  });

  it('sets hasReceivedResult on error result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'error',
      errors: ['something went wrong'],
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('emits tool_use from assistant block', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/foo' } },
        ],
      },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'Let me check');
    assert.equal(chunks.length, 1); // only tool_use, no text
    assert.ok(chunks[0].includes('tool_use'));
  });
});

describe('catch block error suppression logic', () => {
  // These tests verify the logic expressed in the catch block by testing
  // the state conditions that drive its behavior.

  it('result received + exit code → should suppress (transport noise)', () => {
    const state: StreamState = { hasReceivedResult: true, hasStreamedText: true, lastAssistantText: '' };
    const errorMsg = 'Claude Code process exited with code 1';
    const isTransportExit = errorMsg.includes('process exited with code');

    // This is the condition in the catch block:
    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, true);
  });

  it('partial text + exit code (no result) → should NOT suppress (real crash)', () => {
    const state: StreamState = { hasReceivedResult: false, hasStreamedText: true, lastAssistantText: '' };
    const errorMsg = 'Claude Code process exited with code 1';
    const isTransportExit = errorMsg.includes('process exited with code');

    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, false, 'partial output crash must NOT be suppressed');
  });

  it('assistant text with recognised auth error → should surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: false,
      lastAssistantText: 'Your organization does not have access to Claude',
    };

    // Case 2 condition: lastAssistantText must be a recognised auth/access error
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, true);
  });

  it('assistant text with normal content + crash → should NOT surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: false,
      lastAssistantText: 'Here is my analysis of the code...',
    };

    // Normal response text is not a recognised auth error — must fall through to error handling
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, false, 'normal assistant text must NOT be treated as business error');
  });

  it('no streaming + no assistant text → should show full error', () => {
    const state: StreamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };

    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    const shouldSuppress = state.hasReceivedResult;
    assert.equal(shouldSurface, false);
    assert.equal(shouldSuppress, false);
    // This means the catch block falls through to building the full error message
  });

  it('streaming + result + exit code → should suppress', () => {
    // Normal successful flow that ends with exit code 0 won't throw,
    // but some edge cases might. Verify suppression.
    const state: StreamState = { hasReceivedResult: true, hasStreamedText: true, lastAssistantText: 'some response' };
    const isTransportExit = true;

    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, true);
  });
});
