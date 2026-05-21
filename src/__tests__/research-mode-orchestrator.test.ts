import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../lib/bridge/context';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  LLMProvider,
  StreamChatParams,
} from '../lib/bridge/host';
import type { ChannelBinding, ChannelType } from '../lib/bridge/types';
import { startResearchSession } from '../lib/bridge/research-mode/orchestrator';
import {
  RESEARCH_A_STATUS_PREFIX,
  RESEARCH_B_VERDICT_PREFIX,
} from '../lib/bridge/research-mode/protocol';

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;
  setSetting(key: string, value: string): void { this.settings.set(key, value); }
  getSetting(key: string): string | null { return this.settings.get(key) ?? null; }
  getChannelBinding(): ChannelBinding | null { return null; }
  upsertChannelBinding(): ChannelBinding { throw new Error('not used'); }
  updateChannelBinding(): void {}
  listChannelBindings(_t?: ChannelType): ChannelBinding[] { return []; }
  getSession(id: string): BridgeSession | null { return this.sessions.get(id) ?? null; }
  createSession(_name: string, model: string, _systemPrompt?: string, cwd?: string): BridgeSession {
    const session = { id: `session-${this.nextId++}`, working_directory: cwd || '/tmp', model };
    this.sessions.set(session.id, session);
    return session;
  }
  updateSessionProviderId(): void {}
  addMessage(sessionId: string, role: string, content: string): void {
    const messages = this.messages.get(sessionId) ?? [];
    messages.push({ role, content });
    this.messages.set(sessionId, messages);
  }
  getMessages(sessionId: string): { messages: BridgeMessage[] } {
    return { messages: this.messages.get(sessionId) ?? [] };
  }
  acquireSessionLock(): boolean { return true; }
  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(): void {}
  updateSdkSessionId(): void {}
  updateSessionModel(): void {}
  syncSdkTasks(): void {}
  getProvider() { return undefined; }
  getDefaultProviderId(): string | null { return null; }
  insertAuditLog(): void {}
  checkDedup(): boolean { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved(): boolean { return false; }
  listPendingPermissionLinksByChat(): [] { return []; }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

interface ScriptedReplyChooser {
  (params: StreamChatParams): string;
}

/**
 * Stub LLM that emits a single text-then-result SSE pair using a scripted reply.
 * The reply is chosen by inspecting the system prompt (so we can tell which agent
 * is being asked) and the message history length (so we can step through turns).
 */
class ScriptedLLM implements LLMProvider {
  constructor(private readonly chooser: ScriptedReplyChooser) {}
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const reply = this.chooser(params);
    const sse: string[] = [];
    sse.push(`data: ${JSON.stringify({ type: 'text', data: reply })}\n\n`);
    sse.push(
      `data: ${JSON.stringify({
        type: 'result',
        data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }),
      })}\n\n`,
    );
    return new ReadableStream({
      start(controller) {
        for (const chunk of sse) controller.enqueue(chunk);
        controller.close();
      },
    });
  }
}

function tempGoalFolder(goal: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'research-orch-'));
  fs.writeFileSync(path.join(folder, 'goal.md'), goal);
  return folder;
}

function withTaggedJson(prefix: string, body: string, payload: object): string {
  return `${body}\n\n${prefix} ${JSON.stringify(payload)}`;
}

describe('startResearchSession orchestrator loop', () => {
  it('runs A→B→A→B and finalises on confirm-complete', async () => {
    const folder = tempGoalFolder('Refactor authReducer; add 3 tests.');
    let aCalls = 0;
    let bCalls = 0;

    const llm = new ScriptedLLM((params) => {
      // The reviewer prompt also references Agent A; discriminate by checking who is
      // being addressed in the FIRST line of the system prompt.
      const sp = params.systemPrompt ?? '';
      const isResearcher = sp.startsWith('You are **Agent A');
      const isReviewer = sp.startsWith('You are **Agent B');
      if (isResearcher) {
        aCalls += 1;
        if (aCalls === 1) {
          return withTaggedJson(
            RESEARCH_A_STATUS_PREFIX,
            'My plan: refactor authReducer; add 3 tests.',
            { phase: 'plan', summary: 'refactor + 3 tests', next: 'awaiting reviewer' },
          );
        }
        if (aCalls === 2) {
          return withTaggedJson(
            RESEARCH_A_STATUS_PREFIX,
            'Executed plan. Tests pass.',
            { phase: 'complete', summary: 'tests passing', next: 'awaiting sign-off' },
          );
        }
        // Final acknowledgement turn after confirm-complete (loop ends before reading this).
        return withTaggedJson(
          RESEARCH_A_STATUS_PREFIX,
          'Acknowledged sign-off.',
          { phase: 'complete', summary: 'acknowledged', next: 'done' },
        );
      }
      if (isReviewer) {
        bCalls += 1;
        if (bCalls === 1) {
          return withTaggedJson(
            RESEARCH_B_VERDICT_PREFIX,
            'Plan looks reasonable.',
            { verdict: 'approve-plan', advice: 'go for it' },
          );
        }
        return withTaggedJson(
          RESEARCH_B_VERDICT_PREFIX,
          'Verified outcome.',
          { verdict: 'confirm-complete', advice: 'tests verified green' },
        );
      }
      throw new Error('unexpected system prompt: neither A nor B');
    });

    initBridgeContext({
      store: new InMemoryStore(),
      llm,
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const handle = startResearchSession({ folder, maxTurns: 10 });
    const finalState = await handle.done;

    assert.equal(finalState.phase, 'completed');
    assert.equal(finalState.lastVerdict?.verdict, 'confirm-complete');
    assert.equal(finalState.lastStatus?.phase, 'complete');
    assert.ok(aCalls >= 2, `expected >= 2 researcher calls, got ${aCalls}`);
    assert.ok(bCalls >= 2, `expected >= 2 reviewer calls, got ${bCalls}`);

    const resultPath = path.join(folder, '.research', `result-${finalState.sessionId}.md`);
    assert.ok(fs.existsSync(resultPath), `expected result file at ${resultPath}`);
    const body = fs.readFileSync(resultPath, 'utf8');
    assert.match(body, /completed/);
    assert.match(body, /confirm-complete/);
  });

  it('terminates with timeout when reviewer never confirms', async () => {
    const folder = tempGoalFolder('Goal that will never be confirmed.');
    const llm = new ScriptedLLM((params) => {
      const sp = params.systemPrompt ?? '';
      const isResearcher = sp.startsWith('You are **Agent A');
      if (isResearcher) {
        return withTaggedJson(
          RESEARCH_A_STATUS_PREFIX,
          'Plan/attempt.',
          { phase: 'plan', summary: 'try again', next: 'awaiting B' },
        );
      }
      return withTaggedJson(
        RESEARCH_B_VERDICT_PREFIX,
        'Needs more.',
        { verdict: 'request-changes', advice: 'add more details' },
      );
    });
    initBridgeContext({
      store: new InMemoryStore(),
      llm,
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });
    const handle = startResearchSession({ folder, maxTurns: 3 });
    const finalState = await handle.done;
    assert.equal(finalState.phase, 'timeout');
    assert.equal(finalState.turn, 3);
    const resultPath = path.join(folder, '.research', `result-${finalState.sessionId}.md`);
    assert.ok(fs.existsSync(resultPath));
  });

  it('rejects when goal.md is missing', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'research-orch-no-goal-'));
    initBridgeContext({
      store: new InMemoryStore(),
      llm: new ScriptedLLM(() => ''),
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });
    assert.throws(() => startResearchSession({ folder }), /goal file not found/);
  });
});
