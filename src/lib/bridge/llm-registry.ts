/**
 * IM bridge: one LLM provider per (IM bot × runner id), resolved per ChannelBinding.
 * Platform Kanban agents use a separate stack in `src/platform/` — see docs/IM_BRIDGE_MODEL.md.
 */

import type { Config } from '../../config';
import {
  collectImLlmBuildEntries,
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

  for (const { keyPrefix, runner } of entries) {
    const key = `${keyPrefix}\0${runner.id}`;
    const llm = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: runner.runtime,
      runner,
    });
    idToLlm.set(key, llm);
  }

  const defaultKey = defaultImLlmCompositeKey(config);
  const defaultLlm =
    idToLlm.get(defaultKey) ?? [...idToLlm.values()][0] ?? (await resolveProvider({ config, pendingPermissions }));

  return {
    defaultLlm,
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
