/**
 * When `daemon.sh` is run from an interactive shell, HTTP_PROXY / OPENAI_* may
 * already be in the environment. Platform-started bridges only get what is in
 * `config.env` — often `CTI_PROXY` without the conventional proxy env vars.
 * Many CLIs (Cursor agent, Copilot, curl, etc.) read `HTTP_PROXY` / `HTTPS_PROXY`.
 *
 * If `CTI_PROXY` is set and the standard vars are empty, mirror it so master and
 * slave runner subprocesses behave like daemon-started processes.
 */
const STANDARD_PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

export function applyStandardProxyEnvFromCtiProxy(env: Record<string, string | undefined>): void {
  const proxy = env.CTI_PROXY?.trim();
  if (!proxy) return;
  for (const k of STANDARD_PROXY_KEYS) {
    const cur = env[k];
    if (cur === undefined || cur === '') env[k] = proxy;
  }
}
