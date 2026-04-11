/**
 * Safe enqueue/close for ReadableStream controllers used by LLM providers.
 * Prevents synchronous throws (e.g. "Invalid state: Controller is already closed")
 * from readline/SDK callbacks from becoming uncaught exceptions and crashing the process.
 */

import { sseEvent } from './sse-utils';

export function safeEnqueue(
  controller: ReadableStreamDefaultController<string>,
  chunk: string,
  logPrefix: string,
): void {
  try {
    controller.enqueue(chunk);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${logPrefix}] enqueue failed (stream state): ${msg}`);
  }
}

export function safeClose(
  controller: ReadableStreamDefaultController<string>,
  logPrefix: string,
): void {
  try {
    controller.close();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${logPrefix}] close failed: ${msg}`);
  }
}

export function reportProviderError(
  controller: ReadableStreamDefaultController<string>,
  err: unknown,
  logPrefix: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${logPrefix}] Error:`, err instanceof Error ? err.stack || err.message : err);
  safeEnqueue(controller, sseEvent('error', message), logPrefix);
  safeClose(controller, logPrefix);
}

/**
 * Run provider async body with a final catch so rejections never become unhandled
 * if inner try/catch misses a path.
 */
export function runProviderAsync(
  controller: ReadableStreamDefaultController<string>,
  logPrefix: string,
  fn: () => Promise<void>,
): void {
  fn().catch((err: unknown) => {
    reportProviderError(controller, err, logPrefix);
  });
}
