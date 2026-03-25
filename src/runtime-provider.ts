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
  const passModelToCli = runner?.passModelToCli ?? false;

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
      passModel: runner?.codexPassModel,
    });
  }

  if (runtime === 'cursor') {
    const { CursorProvider } = await import('./cursor-provider');
    return new CursorProvider(undefined, {
      agentPath: runner?.cursorExecutable,
      defaultModel: runner?.cursorDefaultModel,
    });
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPathFromRunner(runner);
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPermissions, cliPath, autoApprove, passModelToCli);
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
          '  Falling back to Codex.',
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }

    const { CodexProvider, DEFAULT_CODEX_CONFIG } = await import('./codex-provider');
    const wrapperPath =
      runner?.codexExecutable?.trim() ||
      process.env.CTI_CODEX_EXECUTABLE ||
      DEFAULT_CODEX_CONFIG.wrapperPath;
    return new CodexProvider(pendingPermissions, {
      ...DEFAULT_CODEX_CONFIG,
      wrapperPath,
      useLogin: runner?.codexUseLogin,
      passModel: runner?.codexPassModel,
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
        'Install Claude Code CLI >= 2.x, set CTI_CLAUDE_CODE_EXECUTABLE, or use CTI_RUNTIME=auto.',
    );
  }

  console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  return new SDKLLMProvider(pendingPermissions, cliPath, autoApprove, passModelToCli);
}
