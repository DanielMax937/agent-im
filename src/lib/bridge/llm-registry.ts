/**
 * IM bridge: one LLM provider per runtime profile, resolved per ChannelBinding.
 * Jira/platform agents use a separate stack in `src/platform/` — see docs/IM_BRIDGE_MODEL.md.
 */

import type { Config } from '../../config';
import { normalizeRuntimeProfiles } from '../../config';
import type { PendingPermissions } from '../../permission-gateway';
import { resolveProvider } from '../../runtime-provider';
import type { ChannelBinding } from './types';
import type { LLMProvider } from './host';

export interface ImBridgeLlmStack {
  defaultLlm: LLMProvider;
  resolveLlmForBinding(binding: ChannelBinding): LLMProvider;
}

/**
 * Build one {@link LLMProvider} per configured runtime profile (shared PendingPermissions).
 * Bindings use `runnerProfileId` to pick a profile; unset uses default profile id.
 */
export async function buildImBridgeLlmStack(
  config: Config,
  pendingPermissions: PendingPermissions,
): Promise<ImBridgeLlmStack> {
  const profiles = normalizeRuntimeProfiles(config);
  const idToLlm = new Map<string, LLMProvider>();

  for (const p of profiles) {
    const llm = await resolveProvider({
      config,
      pendingPermissions,
      runtimeOverride: p.runtime,
    });
    idToLlm.set(p.id, llm);
  }

  const defaultProfileId =
    config.defaultRuntimeProfileId ?? profiles[0]?.id ?? 'default';
  const defaultLlm =
    idToLlm.get(defaultProfileId) ?? [...idToLlm.values()][0] ?? (await resolveProvider({ config, pendingPermissions }));

  return {
    defaultLlm,
    resolveLlmForBinding: (binding: ChannelBinding): LLMProvider => {
      const pid =
        binding.runnerProfileId ??
        config.defaultRuntimeProfileId ??
        profiles[0]?.id;
      if (pid && idToLlm.has(pid)) {
        return idToLlm.get(pid)!;
      }
      return defaultLlm;
    },
  };
}
