import { handlePlatformRequest } from '../../../api/platform-request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}
