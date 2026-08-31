/**
 * Resume a terminal research session (same sessionId, transcript preserved).
 *
 *   POST /api/research/:id/continue
 *   Body: { folder, additionalMaxTurns?, maxTurns?, runnerA?, runnerB?, notifyTelegram? }
 */

import path from 'node:path';

import {
  continueResearchSession,
  type ContinueResearchSessionInput,
} from '../../../../../lib/bridge/research-mode/orchestrator';
import { getPlatformContainer, getPlatformLogger } from '../../../../../platform/container';
import { ResearchSessionStoreError } from '../../../../../lib/bridge/research-mode/session-store';

export const dynamic = 'force-dynamic';

interface ContinueRequestBody {
  folder?: string;
  additionalMaxTurns?: number;
  maxTurns?: number;
  runnerA?: string;
  runnerB?: string;
  notifyTelegram?: { chatId?: string; instanceId?: string; bridgeSlug?: string };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function validateBody(
  sessionId: string,
  raw: unknown,
): { ok: true; input: ContinueResearchSessionInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = raw as ContinueRequestBody;
  if (typeof b.folder !== 'string' || !b.folder.trim()) {
    return { ok: false, error: 'folder is required' };
  }
  return {
    ok: true,
    input: {
      folder: path.resolve(b.folder),
      sessionId,
      additionalMaxTurns: b.additionalMaxTurns,
      maxTurns: b.maxTurns,
      runnerA: typeof b.runnerA === 'string' ? b.runnerA : undefined,
      runnerB: typeof b.runnerB === 'string' ? b.runnerB : undefined,
      notifyTelegram: b.notifyTelegram,
    },
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id?.trim()) {
    return jsonResponse(400, { error: 'invalid session id' });
  }

  const log = getPlatformLogger().child({ scope: 'api/research', method: 'POST', sub: 'continue' });
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid JSON body' });
  }

  const validated = validateBody(id, parsed);
  if (!validated.ok) {
    return jsonResponse(400, { error: validated.error });
  }

  await getPlatformContainer();

  try {
    const result = await continueResearchSession(validated.input);
    result.done.catch((err) => {
      log.warn(
        { event: 'research_session_continue_unhandled', err: err instanceof Error ? err.message : err },
        'research continue loop rejected',
      );
    });
    log.info(
      {
        event: 'research_session_continued',
        sessionId: result.state.sessionId,
        folder: result.state.folder,
        turn: result.state.turn,
        maxTurns: result.state.maxTurns,
        phase: result.state.phase,
      },
      'research session continued',
    );
    return jsonResponse(202, {
      sessionId: result.state.sessionId,
      folder: result.state.folder,
      phase: result.state.phase,
      turn: result.state.turn,
      maxTurns: result.state.maxTurns,
      resumed: true,
    });
  } catch (err) {
    if (err instanceof ResearchSessionStoreError) {
      const msg = err.message;
      if (msg.includes('not found')) {
        return jsonResponse(404, { error: msg, sessionId: id, folder: validated.input.folder });
      }
      return jsonResponse(400, { error: msg });
    }
    log.warn(
      { event: 'research_session_continue_failed', err: err instanceof Error ? err.message : err },
      'research session continue failed',
    );
    return jsonResponse(500, {
      error: err instanceof Error ? err.message : 'failed to continue research session',
    });
  }
}
