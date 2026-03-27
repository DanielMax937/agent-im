import type { Config, RunnerConfig } from './config';
import type { LLMProvider } from './lib/bridge/host';
import { SDKLLMProvider, preflightCheck, resolveClaudeCliPathFromRunner } from './llm-provider';
import { PendingPermissions } from './permission-gateway';

export interface ResolveProviderOptions {
  config: Pick<Config, 'runtime' | 'autoApprove'>;
  pendingPermissions: PendingPermissions;
  runtimeOverride?: Config['runtime'];
  autoApproveOverride?: boolean;
  runner?: RunnerConfig;
}

function resolveAutoApprove(
  config: Pick<Config, 'autoApprove'>,
  autoApproveOverride: boolean | undefined,
  runner: RunnerConfig | undefined,
): boolean {
  if (runner?.autoApprove !== undefined) return runner.autoApprove;
  if (autoApproveOverride !== undefined) return autoApproveOverride;
  return config.autoApprove ?? false;
}

export async function resolveProvider({
  config,
  pendingPermissions,
  runtimeOverride,
  autoApproveOverride,
  runner,
}: ResolveProviderOptions): Promise<LLMProvider> {
  const runtime = runtimeOverride ?? config.runtime;
  const autoApprove = resolveAutoApprove(config, autoApproveOverride, runner);

  if (runtime === 'codex') {
    const { CodexProvider, DEFAULT_CODEX_CONFIG } = await import('./codex-provider');
    const wrapperPath =
      runner?.codexExecutable?.trim() ||
      process.env.CTI_CODEX_EXECUTABLE ||
      DEFAULT_CODEX_CONFIG.wrapperPath;
    return new CodexProvider(pendingPermissions, {
      ...DEFAULT_CODEX_CONFIG,
      wrapperPath,
      useLogin: runner?.codexUseLogin,
    });
  }

  if (runtime === 'cursor') {
    const { CursorProvider } = await import('./cursor-provider');
    return new CursorProvider(undefined, {
      agentPath: runner?.cursorExecutable,
      defaultModel: runner?.cursorDefaultModel ?? runner?.defaultModel,
    });
  }

  if (runtime === 'copilot') {
    const { CopilotProvider } = await import('./copilot-provider');
    return new CopilotProvider(undefined, {
      copilotExecutable: runner?.copilotExecutable,
      defaultModel: runner?.defaultModel,
    });
  }

  const cliPath = resolveClaudeCliPathFromRunner(runner);
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
        'Install Claude Code CLI >= 2.x, or set CTI_CLAUDE_CODE_EXECUTABLE.',
    );
  }

  console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  return new SDKLLMProvider(
    pendingPermissions,
    cliPath,
    autoApprove,
    runner?.claudeUseLogin === true,
  );
}
