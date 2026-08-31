/**
 * Runs once when the Next.js server starts. Ensures bridge child processes are torn down
 * when the server process exits (SIGTERM/SIGINT + exit sync kill).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') {
    return;
  }
  const { registerBridgeShutdownHooks } = await import('./lib/bridge-app-child');
  registerBridgeShutdownHooks();
}
