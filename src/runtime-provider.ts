import type { Config } from './config.js';
import type { LLMProvider } from './lib/bridge/host.js';
import { SDKLLMProvider, preflightCheck, resolveClaudeCliPath } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';

export interface ResolveProviderOptions {
  config: Pick<Config, 'runtime' | 'autoApprove'>;
  pendingPermissions: PendingPermissions;
  runtimeOverride?: Config['runtime'];
  autoApproveOverride?: boolean;
}

export async function resolveProvider({
  config,
  pendingPermissions,
  runtimeOverride,
  autoApproveOverride,
}: ResolveProviderOptions): Promise<LLMProvider> {
  const runtime = runtimeOverride ?? config.runtime;
  const autoApprove = autoApproveOverride ?? config.autoApprove;

  if (runtime === 'codex') {
    const { CodexProvider, DEFAULT_CODEX_CONFIG } = await import('./codex-provider.js');
    const wrapperPath = process.env.CTI_CODEX_EXECUTABLE || DEFAULT_CODEX_CONFIG.wrapperPath;
    return new CodexProvider(pendingPermissions, { ...DEFAULT_CODEX_CONFIG, wrapperPath });
  }

  if (runtime === 'cursor') {
    const { CursorProvider } = await import('./cursor-provider.js');
    return new CursorProvider();
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPermissions, cliPath, autoApprove);
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
          '  Falling back to Codex.',
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }

    const { CodexProvider, DEFAULT_CODEX_CONFIG } = await import('./codex-provider.js');
    const wrapperPath = process.env.CTI_CODEX_EXECUTABLE || DEFAULT_CODEX_CONFIG.wrapperPath;
    return new CodexProvider(pendingPermissions, { ...DEFAULT_CODEX_CONFIG, wrapperPath });
  }

  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    throw new Error(
      'Cannot find the `claude` CLI executable. ' +
        'Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE.',
    );
  }

  const check = preflightCheck(cliPath);
  if (!check.ok) {
    throw new Error(
      `Claude CLI preflight check failed for ${cliPath}: ${check.error}. ` +
        'Install Claude Code CLI >= 2.x, set CTI_CLAUDE_CODE_EXECUTABLE, or use CTI_RUNTIME=auto.',
    );
  }

  console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  return new SDKLLMProvider(pendingPermissions, cliPath, autoApprove);
}
