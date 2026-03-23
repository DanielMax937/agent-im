/**
 * IM bridge: per-instance store keys for multi-bot (same or cross platform).
 * See docs/IM_BRIDGE_MULTI_INSTANCE.md.
 */

import type { BridgeStore } from './host';

export type ImBaseChannel = 'telegram' | 'discord' | 'feishu' | 'qq';

/**
 * Map a legacy default store key to the per-instance key.
 * `default` instance keeps legacy keys unchanged.
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
 * List instance ids for a base channel from store (comma list), or `["default"]` when legacy single-instance is enabled.
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
