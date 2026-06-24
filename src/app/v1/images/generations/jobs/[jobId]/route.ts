import { handlePlatformRequest } from '../../../../../api/platform-request';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}
