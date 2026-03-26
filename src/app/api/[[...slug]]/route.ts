import { handlePlatformRequest } from '../platform-request';

export async function GET(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlePlatformRequest(request);
}
