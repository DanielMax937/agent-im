/**
 * Redis key layout for Auto mode — individual namespaces per role:
 *
 *   cti:auto:{bridgeSlug}:{channelType}:master:{suffix}
 *   cti:auto:{bridgeSlug}:{channelType}:slave:{suffix}
 *
 * Master fetches from `master:input` and sends to `slave:input`.
 * Slave  fetches from `slave:input`  and sends to `slave:out`.
 */

import { getImBotInstanceId, loadConfig, resolveAutoRedisBridgeSlug } from '../../config';

export type AutoRedisQueueSuffix = 'input' | 'out' | 'turns' | 'resp' | 'summary' | 'busy';

export type AutoRedisRole = 'master' | 'slave';

export function buildAutoRedisKey(options: {
  bridgeSlug: string;
  channelType: string;
  role: AutoRedisRole;
  suffix: AutoRedisQueueSuffix;
}): string {
  const { bridgeSlug, channelType, role, suffix } = options;
  return `cti:auto:${bridgeSlug.trim()}:${channelType}:${role}:${suffix}`;
}

/** Redis key segment: {@link resolveAutoRedisBridgeSlug} or directory id as fallback. */
export function autoModeBridgeSlug(): string {
  try {
    return resolveAutoRedisBridgeSlug(loadConfig());
  } catch {
    return getImBotInstanceId();
  }
}
