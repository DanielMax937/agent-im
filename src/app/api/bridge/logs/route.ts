import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  BRIDGE_LOG_APP_BASENAME,
  BRIDGE_LOG_DAEMON_BASENAME,
  BRIDGE_LOG_LINES_DEFAULT,
  BRIDGE_LOG_LINES_MAX,
  readBridgeLogTail,
} from '../../../../lib/bridge/bridge-log-file';

/** Never cache log tail; avoid stale 404 from CDN/edge. */
export const dynamic = 'force-dynamic';

/**
 * Dedicated handler: does not go through `platform/app` router, so a mismatched
 * `Request.url` pathname (seen with some Next.js / proxy setups) cannot cause 404.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const raw = parseInt(request.nextUrl.searchParams.get('lines') || '', 10);
  const lines =
    Number.isFinite(raw) && raw > 0
      ? Math.min(raw, BRIDGE_LOG_LINES_MAX)
      : BRIDGE_LOG_LINES_DEFAULT;
  const source = request.nextUrl.searchParams.get('source')?.trim() ?? 'daemon';
  const fileBasename =
    source === 'app' ? BRIDGE_LOG_APP_BASENAME : BRIDGE_LOG_DAEMON_BASENAME;
  try {
    const { text, logPath, missing } = await readBridgeLogTail(lines, fileBasename);
    return NextResponse.json({
      ok: true,
      text,
      logPath,
      missing,
      lines,
      source: source === 'app' ? 'app' : 'daemon',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
