import { handlePlatformRequest } from '../platform-request';

/** Admin polls `/api/bridge/status?slug=` per bridge; must not be statically cached. */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}
