import { getPlatformContainer, getPlatformLogger } from '../../platform/container';

/** Shared entry for Next.js route handlers → platform `Request` router. */
export async function handlePlatformRequest(request: Request): Promise<Response> {
  const logger = getPlatformLogger().child({
    method: request.method,
    pathname: new URL(request.url).pathname,
  });
  logger.info('Handling Next.js API request');
  const { app } = await getPlatformContainer();
  return app.handle(request);
}
