import { getPlatformContainer } from '../../platform/container.js';

export async function GET(request: Request): Promise<Response> {
  const { app } = await getPlatformContainer();
  return app.handle(
    new Request(new URL('/health', request.url), {
      method: 'GET',
      headers: request.headers,
    }),
  );
}
