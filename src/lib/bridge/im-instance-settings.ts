/**
 * IM bridge: per-instance store keys for multi-bot (same or cross platform).
 * See docs/IM_BRIDGE_MULTI_INSTANCE.md.
 */

import type { BridgeStore } from './host';

export type ImBaseChannel = 'telegram' | 'discord' | 'feishu' | 'qq';

/**
 * Map a default store key to the per-instance key.
 * `default` instance keeps unscoped keys unchanged.
 */
export function imScopedStoreKey(
  baseChannel: ImBaseChannel,
  instanceId: string,
  defaultKey: string,
): string {
  if (instanceId === 'default') return defaultKey;
  const bridgePrefix = `bridge_${baseChannel}_`;
  if (defaultKey.startsWith(bridgePrefix)) {
    const rest = defaultKey.slice(bridgePrefix.length);
    return `${bridgePrefix}${instanceId}_${rest}`;
  }
  if (baseChannel === 'telegram' && defaultKey.startsWith('telegram_')) {
    const rest = defaultKey.slice('telegram_'.length);
    return `telegram_${instanceId}_${rest}`;
  }
  return defaultKey;
}

export function imScopedGet(
  store: BridgeStore,
  baseChannel: ImBaseChannel,
  instanceId: string,
  defaultKey: string,
): string | null {
  const key = imScopedStoreKey(baseChannel, instanceId, defaultKey);
  return store.getSetting(key);
}

/**
 * List instance ids for a base channel from store (comma list), or `["default"]` when only flat `bridge_*_enabled` is set.
 */
export function listInstanceIdsForChannel(baseType: string, store: BridgeStore): string[] {
  const csv = store.getSetting(`bridge_${baseType}_instances`)?.trim();
  if (csv) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (store.getSetting(`bridge_${baseType}_enabled`) === 'true') {
    return ['default'];
  }
  return [];
}

/**
 * Whether this base + instance should be started.
 */
export function isInstanceImEnabled(
  store: BridgeStore,
  baseChannel: ImBaseChannel,
  instanceId: string,
): boolean {
  const csv = store.getSetting(`bridge_${baseChannel}_instances`)?.trim();
  if (csv) {
    const ids = csv.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.includes(instanceId)) return false;
    const per = store.getSetting(`bridge_${baseChannel}_${instanceId}_enabled`);
    if (per !== null && per !== '') return per === 'true';
    return true;
  }
  if (instanceId !== 'default') return false;
  return store.getSetting(`bridge_${baseChannel}_enabled`) === 'true';
}

/**
 * Parse adapter `channelType` (`telegram` or `telegram:instanceId`) into base + instance id.
 */
export function parseImBaseAndInstanceId(channelType: string): { base: ImBaseChannel; instanceId: string } | null {
  const idx = channelType.indexOf(':');
  if (idx === -1) {
    if (
      channelType === 'telegram' ||
      channelType === 'discord' ||
      channelType === 'feishu' ||
      channelType === 'qq'
    ) {
      return { base: channelType, instanceId: 'default' };
    }
    return null;
  }
  const base = channelType.slice(0, idx);
  if (base !== 'telegram' && base !== 'discord' && base !== 'feishu' && base !== 'qq') return null;
  const instanceId = channelType.slice(idx + 1).trim() || 'default';
  return { base, instanceId };
}

/**
 * Runner profile id configured for the Local Agent Redis pipeline (`imBot.localAgentRunnerId`).
 */
export function getLocalAgentRunnerIdFromStore(
  store: BridgeStore,
  channelType: string,
): string | undefined {
  const parsed = parseImBaseAndInstanceId(channelType);
  if (!parsed) return undefined;
  const v = imScopedGet(
    store,
    parsed.base,
    parsed.instanceId,
    `bridge_${parsed.base}_local_agent_runner_id`,
  )?.trim();
  return v || undefined;
}

/**
 * Resolve effective runner id for an IM chat. `allRunnerIds` is the **per-bot** list from config
 * (`imBot.runners`), not a global pool.
 */
export function resolveRunnerForChannelBinding(
  _store: BridgeStore,
  _channelType: string,
  bindingRunnerId: string | undefined,
  globalDefaultRunnerId: string | undefined,
  allRunnerIds: string[],
): string {
  if (allRunnerIds.length === 0) {
    return bindingRunnerId?.trim() || globalDefaultRunnerId?.trim() || 'default';
  }

  const pick = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const t = id.trim();
    if (!allRunnerIds.includes(t)) return undefined;
    return t;
  };

  return (
    pick(bindingRunnerId) ??
    pick(globalDefaultRunnerId) ??
    allRunnerIds[0] ??
    'default'
  );
}
