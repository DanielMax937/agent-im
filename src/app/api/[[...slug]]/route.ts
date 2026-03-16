import { getPlatformContainer, getPlatformLogger } from '../../../platform/container.js';

async function handle(request: Request): Promise<Response> {
  const logger = getPlatformLogger().child({
    method: request.method,
    pathname: new URL(request.url).pathname,
  });
  logger.info('Handling Next.js API request');
  const { app } = await getPlatformContainer();
  return app.handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
