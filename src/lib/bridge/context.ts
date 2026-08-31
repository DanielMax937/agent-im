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
import type { RunnerConfig } from '../../config';

/** Snapshot of one runner row for IM slash commands (e.g. /runner). */
export interface BridgeImRunner {
  id: string;
  runtime: string;
  label?: string;
}

export interface BridgeContext {
  store: BridgeStore;
  /** Default LLM when `resolveLlmForBinding` is absent. */
  llm: LLMProvider;
  /**
   * IM bridge: pick LLM per chat binding (multi-runner under one bot).
   * Platform Kanban code does not use this path.
   */
  resolveLlmForBinding?: (binding: ChannelBinding) => LLMProvider;
  /**
   * IM bridge: pick LLM by runner id (channel-agnostic).
   *
   * Used by features that select a runner outside the IM routing path
   * (e.g. Research mode A/B runners). Returns `undefined` when no
   * provider exists for that id — callers fall back to {@link llm}.
   */
  resolveLlmForRunner?: (runnerId: string) => LLMProvider | undefined;
  /**
   * IM: runner list **for this adapter channel** (`telegram` or `telegram:slug`).
   * Backed by `imBot.runners` in config (not global `CTI_RUNNERS` when absent on bot).
   */
  getRunnerConfigsForChannelType?: (channelType: string) => ReadonlyArray<RunnerConfig>;
  /** Default runner id for `channelType` (per-bot `defaultRunnerId` or bridge default). */
  getDefaultRunnerIdForChannelType?: (channelType: string) => string | undefined;
  /**
   * @deprecated Use {@link getRunnerConfigsForChannelType}; legacy flat config only.
   */
  imRunners?: ReadonlyArray<BridgeImRunner>;
  /**
   * @deprecated Use {@link getRunnerConfigsForChannelType}; legacy flat config only.
   */
  imRunnerConfigs?: ReadonlyArray<RunnerConfig>;
  /**
   * @deprecated Use {@link getDefaultRunnerIdForChannelType}; legacy flat config only.
   */
  defaultRunnerId?: string;
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
