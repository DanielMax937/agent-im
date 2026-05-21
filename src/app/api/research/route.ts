/**
 * Research-mode HTTP API.
 *
 * POST /api/research        → start a session, returns the initial state.
 * GET  /api/research?folder=…  → list sessions known in that folder.
 *
 * The orchestrator runs in the background; clients poll the on-disk state via
 * `/api/research/:id?folder=…` to follow progress.
 */

import path from 'node:path';

import {
  startResearchSession,
  listSessions,
  type StartResearchSessionInput,
} from '../../../lib/bridge/research-mode/orchestrator';
import { getPlatformContainer, getPlatformLogger } from '../../../platform/container';
import { ResearchSessionStoreError } from '../../../lib/bridge/research-mode/session-store';

export const dynamic = 'force-dynamic';

interface StartRequestBody {
  folder?: string;
  maxTurns?: number;
  runnerA?: string;
  runnerB?: string;
  /** Optional override; omit entirely to auto-resolve Auto-mode Telegram credentials. */
  notifyTelegram?: { chatId?: string; instanceId?: string; bridgeSlug?: string };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function validateStartBody(raw: unknown): { ok: true; input: StartResearchSessionInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = raw as StartRequestBody;
  if (typeof b.folder !== 'string' || !b.folder.trim()) {
    return { ok: false, error: 'folder is required (absolute or relative path containing goal.md)' };
  }
  const absFolder = path.resolve(b.folder);
  let maxTurns: number | undefined;
  if (b.maxTurns !== undefined) {
    if (typeof b.maxTurns !== 'number' || !Number.isFinite(b.maxTurns) || b.maxTurns <= 0) {
      return { ok: false, error: 'maxTurns must be a positive number' };
    }
    maxTurns = Math.floor(b.maxTurns);
  }
  let notifyTelegram: StartResearchSessionInput['notifyTelegram'];
  if (b.notifyTelegram !== undefined && b.notifyTelegram !== null) {
    if (typeof b.notifyTelegram !== 'object' || Array.isArray(b.notifyTelegram)) {
      return { ok: false, error: 'notifyTelegram must be an object { chatId?, instanceId?, bridgeSlug? }' };
    }
    const chatId =
      typeof b.notifyTelegram.chatId === 'string' && b.notifyTelegram.chatId.trim()
        ? b.notifyTelegram.chatId.trim()
        : undefined;
    const instanceId =
      typeof b.notifyTelegram.instanceId === 'string' && b.notifyTelegram.instanceId.trim()
        ? b.notifyTelegram.instanceId.trim()
        : undefined;
    const bridgeSlug =
      typeof b.notifyTelegram.bridgeSlug === 'string' && b.notifyTelegram.bridgeSlug.trim()
        ? b.notifyTelegram.bridgeSlug.trim()
        : undefined;
    notifyTelegram = { chatId, instanceId, bridgeSlug };
  }
  return {
    ok: true,
    input: {
      folder: absFolder,
      maxTurns,
      runnerA: typeof b.runnerA === 'string' ? b.runnerA : undefined,
      runnerB: typeof b.runnerB === 'string' ? b.runnerB : undefined,
      notifyTelegram,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  const log = getPlatformLogger().child({ scope: 'api/research', method: 'POST' });
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid JSON body' });
  }
  const validated = validateStartBody(parsed);
  if (!validated.ok) {
    return jsonResponse(400, { error: validated.error });
  }
  // Make sure bridge context is initialized before the orchestrator calls processMessage.
  await getPlatformContainer();

  try {
    const result = startResearchSession(validated.input);
    // Loop runs in background; record an unhandled-rejection guard so node doesn't crash.
    result.done.catch((err) => {
      log.warn(
        { event: 'research_session_loop_unhandled', err: err instanceof Error ? err.message : err },
        'research session loop rejected',
      );
    });
    log.info(
      {
        event: 'research_session_started',
        sessionId: result.state.sessionId,
        folder: result.state.folder,
        maxTurns: result.state.maxTurns,
      },
      'research session started',
    );
    return jsonResponse(202, {
      sessionId: result.state.sessionId,
      folder: result.state.folder,
      maxTurns: result.state.maxTurns,
      phase: result.state.phase,
      createdAt: result.state.createdAt,
    });
  } catch (err) {
    if (err instanceof ResearchSessionStoreError) {
      return jsonResponse(400, { error: err.message });
    }
    log.warn(
      { event: 'research_session_start_failed', err: err instanceof Error ? err.message : err },
      'research session start failed',
    );
    return jsonResponse(500, {
      error: err instanceof Error ? err.message : 'failed to start research session',
    });
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const folderRaw = url.searchParams.get('folder');
  if (!folderRaw || !folderRaw.trim()) {
    return jsonResponse(400, { error: 'query param `folder` is required' });
  }
  try {
    const folder = path.resolve(folderRaw);
    const states = listSessions(folder);
    return jsonResponse(200, {
      folder,
      count: states.length,
      sessions: states.map((s) => ({
        sessionId: s.sessionId,
        phase: s.phase,
        turn: s.turn,
        maxTurns: s.maxTurns,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        finishedAt: s.finishedAt,
        finishedReason: s.finishedReason,
        lastStatus: s.lastStatus,
        lastVerdict: s.lastVerdict,
      })),
    });
  } catch (err) {
    return jsonResponse(500, {
      error: err instanceof Error ? err.message : 'failed to list research sessions',
    });
  }
}
