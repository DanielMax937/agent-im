import type { Config, RunnerConfig } from './config';
import type { LLMProvider } from './lib/bridge/host';
import { SDKLLMProvider, resolveClaudeCliPathFromRunner } from './llm-provider';
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
      subprocessEnv: runner?.subprocessEnv,
    });
  }

  if (runtime === 'cursor') {
    const { CursorProvider } = await import('./cursor-provider');
    return new CursorProvider(undefined, {
      agentPath: runner?.cursorExecutable,
      defaultModel: runner?.cursorDefaultModel ?? runner?.defaultModel,
      subprocessEnv: runner?.subprocessEnv,
    });
  }

  if (runtime === 'copilot') {
    const { CopilotProvider } = await import('./copilot-provider');
    return new CopilotProvider(undefined, {
      copilotExecutable: runner?.copilotExecutable,
      defaultModel: runner?.defaultModel,
      subprocessEnv: runner?.subprocessEnv,
    });
  }

  const cliPath = resolveClaudeCliPathFromRunner(runner);
  if (!cliPath) {
    throw new Error(
      'Cannot find the `claude` CLI executable. ' +
        'Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE.',
    );
  }

  return new SDKLLMProvider(
    pendingPermissions,
    cliPath,
    autoApprove,
    runner?.claudeUseLogin === true,
    runner?.subprocessEnv,
  );
}
