/**
 * When `daemon.sh` is run from an interactive shell, HTTP_PROXY / OPENAI_* may
 * already be in the environment. Platform-started bridges only get what is in
 * `config.env` — often `CTI_PROXY` without the conventional proxy env vars.
 * Many CLIs (Cursor agent, Copilot, curl, etc.) read `HTTP_PROXY` / `HTTPS_PROXY`.
 *
 * If `CTI_PROXY` is set and the standard vars are empty, mirror it so master and
 * slave runner subprocesses behave like daemon-started processes.
 */
export const STANDARD_PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

export type SubprocessRuntimeKind = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'auto';

/**
 * Remove conventional proxy env vars from a child env so CLIs do not pick up a
 * stale shell/daemon HTTP_PROXY (Claude / Codex provider policy).
 */
export function unsetStandardProxyEnv(env: Record<string, string | undefined>): void {
  for (const k of STANDARD_PROXY_KEYS) {
    delete env[k];
  }
}

export function applyStandardProxyEnvFromCtiProxy(
  env: Record<string, string | undefined>,
  options?: { force?: boolean },
): void {
  const proxy = env.CTI_PROXY?.trim();
  if (!proxy) return;
  for (const k of STANDARD_PROXY_KEYS) {
    const cur = env[k];
    if (options?.force || cur === undefined || cur === '') env[k] = proxy;
  }
}

/**
 * Per-provider subprocess proxy policy for LLM CLI children (`buildSubprocessEnvForRuntime`).
 * Does not affect `config`/`slave-process` mirroring of CTI_PROXY into the bridge Node process.
 */
export function applySubprocessProxyPolicyForRuntime(
  env: Record<string, string | undefined>,
  runtime: SubprocessRuntimeKind,
  options?: { useLogin?: boolean },
): void {
  switch (runtime) {
    case 'claude':
    case 'auto':
      unsetStandardProxyEnv(env);
      break;
    case 'codex':
      if (options?.useLogin) {
        applyStandardProxyEnvFromCtiProxy(env, { force: true });
      } else {
        unsetStandardProxyEnv(env);
      }
      break;
    case 'cursor':
      applyStandardProxyEnvFromCtiProxy(env, { force: true });
      break;
    case 'copilot':
    case 'opencode':
      applyStandardProxyEnvFromCtiProxy(env, { force: true });
      break;
  }
}
