/**
 * Bridge Context — dependency injection container for host interfaces.
 *
 * All bridge modules access host services through this context instead
 * of importing directly from the host application.
 *
 * The host initializes the context once at startup via `initBridgeContext()`.
 * Bridge modules access it via `getBridgeContext()`.
 */

import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
} from './host';
import type { ChannelBinding } from './types';

/** Snapshot of `config.runtimeProfiles` for IM slash commands (e.g. /runner). */
export interface BridgeImRuntimeProfile {
  id: string;
  runtime: string;
  label?: string;
}

export interface BridgeContext {
  store: BridgeStore;
  /** Default LLM (used when `resolveLlmForBinding` is absent or as legacy fallback). */
  llm: LLMProvider;
  /**
   * IM bridge: pick LLM per chat binding (multi-runner under one bot).
   * Jira/platform code does not use this path.
   */
  resolveLlmForBinding?: (binding: ChannelBinding) => LLMProvider;
  /**
   * IM: selectable runtime profiles (same ids as `ChannelBinding.runnerProfileId`).
   * Set from `normalizeRuntimeProfiles(config)` at startup.
   */
  imRuntimeProfiles?: ReadonlyArray<BridgeImRuntimeProfile>;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
}

const CONTEXT_KEY = '__bridge_context__';

/**
 * Initialize the bridge context with host-provided implementations.
 * Must be called once before any bridge module is used.
 */
export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

/**
 * Get the current bridge context.
 * Throws if the context has not been initialized.
 */
export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as BridgeContext | undefined;
  if (!ctx) {
    throw new Error(
      '[bridge] Context not initialized. Call initBridgeContext() before using bridge modules.',
    );
  }
  return ctx;
}

/**
 * Check whether the bridge context has been initialized.
 */
export function hasBridgeContext(): boolean {
  return !!(globalThis as Record<string, unknown>)[CONTEXT_KEY];
}
