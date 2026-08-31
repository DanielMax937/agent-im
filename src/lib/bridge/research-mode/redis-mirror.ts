/**
 * Optional Redis mirror for research mode.
 *
 * The orchestrator runs entirely on the filesystem; this module is a thin
 * write-through layer that pushes a copy of each turn (and lifecycle events)
 * to Redis when the user has Auto-mode Redis already configured. That way the
 * existing monitor page can peek at research-mode transcripts using the same
 * `cti:*` key conventions as Auto-mode master/slave queues.
 *
 * Key layout:
 *
 *   cti:research:{bridgeSlug}:{sessionId}:turns           # LPUSH JSON entries (newest first)
 *   cti:research:{bridgeSlug}:{sessionId}:events          # LPUSH orchestrator lifecycle events
 *   cti:research:{bridgeSlug}:{sessionId}:meta            # JSON blob (folder, runners, createdAt)
 *
 * The mirror is **best-effort**: any failure is logged and swallowed. The
 * filesystem transcript remains the source of truth.
 */

import { autoModeBridgeSlug } from '../auto-redis-keys';
import { getLogger } from '../../../logger';
import type { ResearchTranscriptEntry } from './session-store';

interface RedisClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lPush(key: string, value: string): Promise<number>;
  set(key: string, value: string): Promise<string>;
}

export interface ResearchMirrorEvent {
  sessionId: string;
  kind:
    | 'session-start'
    | 'session-end'
    | 'researcher-prompt'
    | 'reviewer-prompt';
  turn: number;
  preview: string;
}

export interface ResearchMirrorTranscript {
  sessionId: string;
  entry: ResearchTranscriptEntry;
}

export interface ResearchMirror {
  recordOrchestratorEvent(event: ResearchMirrorEvent): Promise<void>;
  recordTranscriptEntry(entry: ResearchMirrorTranscript): Promise<void>;
  /** Idempotent — safe to call repeatedly. */
  recordSessionMeta(meta: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
}

function resolveRedisUrlFromEnv(): string | null {
  const candidates = [
    process.env.CTI_RESEARCH_REDIS_URL,
    process.env.CTI_TELEGRAM_AUTO_REDIS_URL,
    process.env.CTI_AUTO_REDIS_URL,
    process.env.CTI_LOCAL_AGENT_REDIS_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

interface InitMirrorInput {
  folder: string;
  sessionId: string;
  runnerA?: string;
  runnerB?: string;
}

/**
 * Create a research mirror when a Redis URL is reachable; otherwise return null
 * so the orchestrator can skip mirroring without branching at every call site.
 */
export function resolveResearchMirror(input: InitMirrorInput): ResearchMirror | null {
  const url = resolveRedisUrlFromEnv();
  if (!url) return null;

  let bridgeSlug: string;
  try {
    bridgeSlug = autoModeBridgeSlug();
  } catch {
    bridgeSlug = 'default';
  }

  const baseKey = (suffix: 'turns' | 'events' | 'meta'): string =>
    `cti:research:${bridgeSlug}:${input.sessionId}:${suffix}`;

  let clientPromise: Promise<RedisClientLike | null> | null = null;
  const getClient = (): Promise<RedisClientLike | null> => {
    if (clientPromise) return clientPromise;
    clientPromise = (async (): Promise<RedisClientLike | null> => {
      try {
        const { createClient } = await import('redis');
        const c = createClient({ url });
        c.on('error', (err: Error) => {
          getLogger().warn(
            { event: 'research_mirror_redis_error', err: err.message },
            '[research-mirror] redis error',
          );
        });
        await c.connect();
        return c as unknown as RedisClientLike;
      } catch (err) {
        getLogger().warn(
          { event: 'research_mirror_connect_failed', err: err instanceof Error ? err.message : err },
          '[research-mirror] connect failed; running without mirror',
        );
        return null;
      }
    })();
    return clientPromise;
  };

  // Fire-and-forget initial meta write so monitors can list sessions.
  void (async () => {
    const c = await getClient();
    if (!c) return;
    try {
      await c.set(
        baseKey('meta'),
        JSON.stringify({
          sessionId: input.sessionId,
          folder: input.folder,
          runnerA: input.runnerA ?? null,
          runnerB: input.runnerB ?? null,
          bridgeSlug,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      getLogger().warn(
        { event: 'research_mirror_meta_failed', err: err instanceof Error ? err.message : err },
        '[research-mirror] meta write failed',
      );
    }
  })();

  return {
    async recordOrchestratorEvent(event) {
      const c = await getClient();
      if (!c) return;
      try {
        await c.lPush(baseKey('events'), JSON.stringify({ ...event, at: new Date().toISOString() }));
      } catch (err) {
        getLogger().warn(
          { event: 'research_mirror_event_failed', err: err instanceof Error ? err.message : err },
          '[research-mirror] event push failed',
        );
      }
    },
    async recordTranscriptEntry(entry) {
      const c = await getClient();
      if (!c) return;
      try {
        await c.lPush(baseKey('turns'), JSON.stringify(entry.entry));
      } catch (err) {
        getLogger().warn(
          { event: 'research_mirror_turn_failed', err: err instanceof Error ? err.message : err },
          '[research-mirror] turn push failed',
        );
      }
    },
    async recordSessionMeta(meta) {
      const c = await getClient();
      if (!c) return;
      try {
        await c.set(baseKey('meta'), JSON.stringify({ sessionId: input.sessionId, ...meta }));
      } catch (err) {
        getLogger().warn(
          { event: 'research_mirror_meta_update_failed', err: err instanceof Error ? err.message : err },
          '[research-mirror] meta update failed',
        );
      }
    },
    async disconnect() {
      if (!clientPromise) return;
      const c = await clientPromise;
      if (!c) return;
      try {
        await c.disconnect();
      } catch {
        /* best effort */
      }
    },
  };
}
