/**
 * Detail endpoint for a single research session.
 *
 *   GET /api/research/:id?folder=…[&transcript=1]
 *
 * Returns the latest on-disk state. When `transcript=1` is passed, the entire
 * transcript log is included so a UI can render the full A↔B conversation.
 */

import path from 'node:path';

import {
  readState,
  readTranscript,
  getResultPath,
} from '../../../../lib/bridge/research-mode/orchestrator';

export const dynamic = 'force-dynamic';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id || typeof id !== 'string') {
    return jsonResponse(400, { error: 'invalid session id' });
  }
  const url = new URL(request.url);
  const folderRaw = url.searchParams.get('folder');
  if (!folderRaw || !folderRaw.trim()) {
    return jsonResponse(400, { error: 'query param `folder` is required' });
  }
  const includeTranscript = url.searchParams.get('transcript') === '1';
  const folder = path.resolve(folderRaw);
  const state = readState(folder, id);
  if (!state) {
    return jsonResponse(404, { error: 'session not found', sessionId: id, folder });
  }
  const transcript = includeTranscript ? readTranscript(folder, id) : undefined;
  return jsonResponse(200, {
    state,
    resultPath: getResultPath(state),
    transcript,
  });
}
