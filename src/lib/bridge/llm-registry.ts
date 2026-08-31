/**
 * IM bridge: one LLM provider per (IM bot × runner id), resolved per ChannelBinding.
 * Platform Kanban agents use a separate stack in `src/platform/` — see docs/IM_BRIDGE_MODEL.md.
 */

import type { Config } from '../../config';
import {
  collectImLlmBuildEntries,
  collectResearchRunners,
  defaultImLlmCompositeKey,
  defaultRunnerIdForChannelType,
  imLlmKeyPrefix,
  loadConfig,
  normalizeRunnersForChannelType,
} from '../../config';
import type { PendingPermissions } from '../../permission-gateway';
import { resolveProvider } from '../../runtime-provider';
import type { ChannelBinding } from './types';
import type { LLMProvider } from './host';
import { getBridgeContext } from './context';
import { resolveRunnerForChannelBinding } from './im-instance-settings';

export interface ImBridgeLlmStack {
  defaultLlm: LLMProvider;
  resolveLlmForBinding(binding: ChannelBinding): LLMProvider;
  /**
   * Look up the LLM provider for a given runner id without binding context.
   *
   * Used by features (e.g. Research mode) that pick a runner outside the IM
   * routing path. Returns `undefined` when no provider was built for that id —
   * callers should fall back to `defaultLlm`.
   */
  resolveLlmForRunner(runnerId: string): LLMProvider | undefined;
}

/**
 * Build one {@link LLMProvider} per configured (bot, runner) pair (shared PendingPermissions).
 * Bindings use `runnerProfileId` to pick a runner within **that bot's** list only.
 */
export async function buildImBridgeLlmStack(
  config: Config,
  pendingPermissions: PendingPermissions,
): Promise<ImBridgeLlmStack> {
  const entries = collectImLlmBuildEntries(config);
  const idToLlm = new Map<string, LLMProvider>();
  const runnerIdToLlm = new Map<string, LLMProvider>();

  for (const { keyPrefix, runner } of entries) {
    const key = `${keyPrefix}\0${runner.id}`;
    const llm = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: runner.runtime,
      runner,
    });
    idToLlm.set(key, llm);
    // First wins: per-runner-id lookup is channel-agnostic. The same runner is
    // built once per enabled channel, so picking the first is sufficient and
    // avoids spawning extra duplicate providers downstream.
    if (!runnerIdToLlm.has(runner.id)) {
      runnerIdToLlm.set(runner.id, llm);
    }
  }

  // Research-mode runners live at the top of `Config` and are independent of
  // any IM bot channel. Build providers for them so the orchestrator can pick
  // them up via `resolveLlmForRunner`. Skip ids already built above.
  for (const runner of collectResearchRunners(config)) {
    if (runnerIdToLlm.has(runner.id)) continue;
    const llm = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: runner.runtime,
      runner,
    });
    runnerIdToLlm.set(runner.id, llm);
  }

  const defaultKey = defaultImLlmCompositeKey(config);
  const defaultLlm =
    idToLlm.get(defaultKey) ?? [...idToLlm.values()][0] ?? (await resolveProvider({ config, pendingPermissions }));

  return {
    defaultLlm,
    resolveLlmForRunner: (runnerId: string): LLMProvider | undefined => {
      if (!runnerId) return undefined;
      return runnerIdToLlm.get(runnerId);
    },
    resolveLlmForBinding: (binding: ChannelBinding): LLMProvider => {
      const store = getBridgeContext().store;
      const fresh = loadConfig();
      const runners = normalizeRunnersForChannelType(fresh, binding.channelType);
      const allIds = runners.map((r) => r.id);
      const globalDef = defaultRunnerIdForChannelType(fresh, binding.channelType);
      const pid = resolveRunnerForChannelBinding(
        store,
        binding.channelType,
        binding.runnerProfileId,
        globalDef,
        allIds,
      );
      const prefix = imLlmKeyPrefix(fresh, binding.channelType);
      const key = `${prefix}\0${pid}`;
      if (idToLlm.has(key)) {
        return idToLlm.get(key)!;
      }
      if (!fresh.imBot) {
        const legacy = `__legacy__\0${pid}`;
        if (idToLlm.has(legacy)) return idToLlm.get(legacy)!;
      }
      return defaultLlm;
    },
  };
}
