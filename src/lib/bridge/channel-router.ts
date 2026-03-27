/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types';
import { getBridgeContext } from './context';
import {
  getLocalAgentRunnerIdFromStore,
  resolveRunnerForChannelBinding,
} from './im-instance-settings';

function isLocalAgentAddress(address: ChannelAddress): boolean {
  return address.chatId.startsWith('la:') || (address.userId?.startsWith('localagent-') ?? false);
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const {
    store,
    imRunners,
    getRunnerConfigsForChannelType,
    getDefaultRunnerIdForChannelType,
    defaultRunnerId: ctxDefaultRunner,
  } = getBridgeContext();
  const row = getRunnerConfigsForChannelType?.(address.channelType) ?? imRunners;
  const allIds = (row ?? []).map((r) => r.id);
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  const storeDefault = store.getSetting('bridge_default_runner_profile_id')?.trim() || undefined;
  const globalDef =
    getDefaultRunnerIdForChannelType?.(address.channelType) ??
    ctxDefaultRunner ??
    storeDefault ??
    allIds[0];
  const laRunner = isLocalAgentAddress(address)
    ? getLocalAgentRunnerIdFromStore(store, address.channelType)
    : undefined;
  const runnerProfileId = resolveRunnerForChannelBinding(
    store,
    address.channelType,
    laRunner,
    globalDef,
    allIds,
  );

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    workingDirectory: defaultCwd,
    model: defaultModel,
    runnerProfileId,
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const {
    store,
    imRunners,
    getRunnerConfigsForChannelType,
    getDefaultRunnerIdForChannelType,
    defaultRunnerId: ctxDefaultRunner,
  } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  const row = getRunnerConfigsForChannelType?.(address.channelType) ?? imRunners;
  const allIds = (row ?? []).map((r) => r.id);
  const storeDefault = store.getSetting('bridge_default_runner_profile_id')?.trim() || undefined;
  const globalDef =
    getDefaultRunnerIdForChannelType?.(address.channelType) ??
    ctxDefaultRunner ??
    storeDefault ??
    allIds[0];
  const laRunner = isLocalAgentAddress(address)
    ? getLocalAgentRunnerIdFromStore(store, address.channelType)
    : undefined;
  const runnerProfileId = resolveRunnerForChannelBinding(
    store,
    address.channelType,
    laRunner,
    globalDef,
    allIds,
  );

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
    runnerProfileId,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<
    Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active' | 'runnerProfileId'>
  >,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * Point this chat at a new CodePilot session and clear SDK resume state.
 * Call when the effective runner changes so the next turn does not resume a
 * stale CLI thread from the previous backend (avoids "No conversation found" errors).
 */
export function recreateBindingSession(binding: ChannelBinding): void {
  const { store } = getBridgeContext();
  const cwd =
    binding.workingDirectory ||
    store.getSetting('bridge_default_work_dir') ||
    process.env.HOME ||
    '';
  const session = store.createSession(
    `Bridge: ${binding.chatId}`,
    binding.model || '',
    undefined,
    cwd,
    binding.mode,
  );
  store.updateChannelBinding(binding.id, {
    codepilotSessionId: session.id,
    sdkSessionId: '',
  });
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
