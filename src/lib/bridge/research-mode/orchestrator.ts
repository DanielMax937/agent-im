/**
 * Research-mode orchestrator.
 *
 * Drives the Agent A (researcher) ↔ Agent B (reviewer) loop in-process.
 *
 *   bootstrap → A(plan)  → B(review-plan)    → A(execute or revise) → …
 *                                              ↓
 *                                            A(complete) → B(review-completion)
 *                                              ↓
 *                                       both agree → write result.md, stop
 *
 * Each LLM turn is dispatched through `conversation-engine.processMessage`
 * with a new `deliverySource` (`'researcher'` / `'reviewer'`) that injects
 * the corresponding system prompt and keeps tool access intact.
 *
 * The orchestrator runs as a background async function; callers (HTTP API,
 * tests, scripts) start it and immediately get a session id back. The
 * session state, transcript, and final `result.md` are written to disk
 * inside `<folder>/.research/` so the run survives a process restart for
 * post-mortem inspection.
 *
 * Optional integrations:
 *   • Redis mirror (`research-redis-mirror.ts`) — exposes turns to the
 *     existing monitor page when configured.
 *   • Telegram mirror (`telegram-notify.ts`) — every A/B reply plus a
 *     completion summary; auto-resolves Auto-mode `tgBotToken` / `tgChatId`.
 */

import path from 'node:path';

import type { ChannelBinding } from '../types';
import type { LLMProvider } from '../host';
import type { BridgeStore } from '../host';
import { getBridgeContext } from '../context';
import { processMessage } from '../conversation-engine';
import { renderPrompt } from '../../../prompts/loader';
import { getLogger } from '../../../logger';
import { JsonFileStore } from '../../../store';
import { PendingPermissions } from '../../../permission-gateway';
import {
  getResearchBridgeCtiHome,
  loadResearchBridgeConfig,
  configToSettings,
  loadConfig,
  type Config,
} from '../../../config';
import { buildImBridgeLlmStack } from '../llm-registry';

import {
  type ResearcherStatus,
  type ReviewerEvaluation,
  isMutualCompletion,
  parseResearcherStatus,
  parseReviewerVerdict,
  reviewerPromptKindForPhase,
  researcherFeedbackKindForVerdict,
  stripProtocolMarkers,
} from './protocol';
import {
  appendTranscript,
  createSession,
  GOAL_FILE_NAME,
  getResultPath,
  listSessions,
  markFinished,
  readGoalText,
  readState,
  readTranscript,
  recordOrchestratorNote,
  recordResearcherReply,
  recordReviewerReply,
  ResearchSessionStoreError,
  resolveGoalPath,
  writeResultMarkdown,
  writeState,
  type ResearchSessionState,
  type ResearchTranscriptEntry,
} from './session-store';
import {
  type ResearchMirror,
  resolveResearchMirror,
} from './redis-mirror';
import {
  notifyTelegramAgentReply,
  notifyTelegramCompletion,
  resolveResearchTelegramTarget,
  type ResearchTelegramOverride,
  type ResearchTelegramTarget,
} from './telegram-notify';
import {
  indexReferences,
  buildReferencePack,
  writeManifest,
  type ReferenceManifest,
} from './reference-loader';
import {
  loadKnowledgeEntries,
  extractGoalKeywords,
  isValidKnowledgeVault,
} from './knowledge-base';
import {
  runExpertCouncil,
  shouldTriggerExpertCouncil,
  type ExpertDefinition,
  type ExpertCouncilConfig,
  type ExpertCouncilResult,
} from './expert-council';

export interface StartResearchSessionInput {
  /** Absolute folder containing `goal.md`. */
  folder: string;
  /** Cap on the number of researcher turns (each turn = A + B exchange). Defaults to 30. */
  maxTurns?: number;
  /** Informational — currently logged for traceability; LLM selection still uses bridge default. */
  runnerA?: string;
  runnerB?: string;
  /**
   * Optional Telegram mirror override (`chatId`, `instanceId`, `bridgeSlug`).
   * When omitted, credentials are auto-resolved from the Auto-mode Telegram bot
   * (`mybot` / store `telegram_bot_token` + `telegram_chat_id`). Every agent
   * reply and the session summary are sent when resolution succeeds.
   */
  notifyTelegram?: ResearchTelegramOverride;
}

export interface ContinueResearchSessionInput {
  folder: string;
  sessionId: string;
  /** Raise `maxTurns` to at least `turn + additionalMaxTurns`. */
  additionalMaxTurns?: number;
  /** Set an absolute new `maxTurns` ceiling (must be > current `turn`). */
  maxTurns?: number;
  runnerA?: string;
  runnerB?: string;
  notifyTelegram?: ResearchTelegramOverride;
}

export interface StartResearchSessionResult {
  state: ResearchSessionState;
  /** Resolves when the orchestrator loop ends (terminal phase reached). */
  done: Promise<ResearchSessionState>;
  /** Call to request an early abort; the loop stops at the next safe boundary. */
  abort: (reason?: string) => void;
}

const DEFAULT_MAX_TURNS = 30;
const TRANSCRIPT_PREVIEW_CHARS = 8000;
/**
 * Hard ceiling on **consecutive** protocol-parse failures from the same agent.
 *
 * The orchestrator gives the agent one corrective followup when it fails to
 * emit the expected `RESEARCH_A_STATUS_JSON` / `RESEARCH_B_VERDICT_JSON` line.
 * In practice, when the underlying LLM is broken (auth 403, network error, the
 * runner returning the error text as the reply body) the same parse failure
 * repeats every turn and the session would burn through `maxTurns` doing
 * nothing useful. We stop the loop early once a single agent has hit this many
 * parse failures in a row, marking the session as `failed` with the last error
 * verbatim so the failure mode is obvious.
 */
const MAX_CONSECUTIVE_PARSE_FAILURES = 3;

/**
 * Resources for a standalone Research bridge.
 *
 * When a Research bridge directory exists at `~/.claude-to-im/research/`
 * (or `CTI_RESEARCH_HOME`), the orchestrator uses its own config and store.
 * Otherwise it falls back to the global BridgeContext.
 */
export interface ResearchBridgeResources {
  /** The resolved config (never null — falls back to global config). */
  config: Config;
  /** Store for CodePilot sessions (research bridge or global). */
  store: BridgeStore;
  /** Resolve an LLM provider by runner id. */
  resolveLlmForRunner: (runnerId: string) => LLMProvider | undefined;
  /** Whether this session uses a dedicated Research bridge (vs global). */
  usesDedicatedBridge: boolean;
}

let cachedResearchResources: ResearchBridgeResources | null = null;
let researchResourcesPromise: Promise<ResearchBridgeResources> | null = null;

/**
 * Get or create the standalone Research bridge resources (async).
 *
 * The resources are cached per-process since building LLM providers is expensive.
 * Use `invalidateResearchBridgeCache()` to reset the cache if config changes.
 */
export async function getResearchBridgeResources(): Promise<ResearchBridgeResources> {
  if (cachedResearchResources) return cachedResearchResources;
  if (researchResourcesPromise) return researchResourcesPromise;

  researchResourcesPromise = buildResearchBridgeResources();
  cachedResearchResources = await researchResourcesPromise;
  researchResourcesPromise = null;
  return cachedResearchResources;
}

async function buildResearchBridgeResources(): Promise<ResearchBridgeResources> {
  const researchHome = getResearchBridgeCtiHome();
  const researchConfig = loadResearchBridgeConfig();

  if (researchConfig) {
    // Use dedicated Research bridge
    const store = new JsonFileStore(configToSettings(researchConfig));
    const pendingPermissions = new PendingPermissions();
    const { resolveLlmForRunner, defaultLlm } = await buildImBridgeLlmStack(researchConfig, pendingPermissions);
    const resources: ResearchBridgeResources = {
      config: researchConfig,
      store,
      resolveLlmForRunner: resolveLlmForRunner ?? (() => undefined),
      usesDedicatedBridge: true,
    };
    getLogger().info(
      { event: 'research_bridge_init', home: researchHome },
      '[research-mode] Using dedicated Research bridge',
    );
    return resources;
  } else {
    // Fall back to global BridgeContext
    const ctx = getBridgeContext();
    const resources: ResearchBridgeResources = {
      config: loadConfig() ?? ({} as Config),
      store: ctx.store,
      resolveLlmForRunner: ctx.resolveLlmForRunner ?? (() => undefined),
      usesDedicatedBridge: false,
    };
    getLogger().info(
      { event: 'research_bridge_init', home: researchHome, fallback: true },
      '[research-mode] Research bridge not found, falling back to global BridgeContext',
    );
    return resources;
  }
}

/**
 * Invalidate the cached Research bridge resources.
 * Call this if the Research bridge config may have changed.
 */
export function invalidateResearchBridgeCache(): void {
  cachedResearchResources = null;
  researchResourcesPromise = null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function syntheticBinding(opts: {
  channelTypeSuffix: 'researcher' | 'reviewer';
  chatId: string;
  sessionId: string;
  folder: string;
  runnerProfileId?: string;
}): ChannelBinding {
  return {
    id: `research:${opts.channelTypeSuffix}:${opts.sessionId}`,
    channelType: `research:${opts.channelTypeSuffix}`,
    chatId: opts.chatId,
    codepilotSessionId: opts.sessionId,
    sdkSessionId: '',
    workingDirectory: opts.folder,
    model: '',
    runnerProfileId: opts.runnerProfileId,
    mode: 'code',
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/** Build the bootstrap prompt that seeds Agent A with goal, references, and KB. */
function buildBootstrapPrompt(
  folder: string,
  goalText: string,
  referencePack: string,
  knowledgeSnippets: string,
): string {
  return renderPrompt('bridge/research-mode-bootstrap', {
    folder,
    goalText: goalText.trim() || '_(goal.md is empty)_',
    referencePack: referencePack
      ? `## Reference Materials\n\nThe following reference files were found in \`${folder}/reference/\`. You must consider all of them:\n\n${referencePack}`
      : '',
    knowledgeSnippets: knowledgeSnippets
      ? `## Knowledge Base Entries\n\nRelevant entries from the topic knowledge base:\n\n${knowledgeSnippets}`
      : '',
  });
}

function buildReviewerPrompt(
  state: ResearchSessionState,
  goalText: string,
  status: ResearcherStatus,
  aBody: string,
): string {
  const kind = reviewerPromptKindForPhase(status.phase);
  const template = `bridge/research-mode-review-${kind}`;
  const firstPlanReviewSocraticGuidance =
    state.turn === 1 && status.phase === 'plan'
      ? [
          '## FIRST_REVIEW_SOCRATIC_GUIDANCE',
          '',
          'This is Agent B\'s first review of Agent A\'s plan. Use the local Codex skill `socratic-goal-decomposition` as your review method.',
          '',
          'Combine the `goal.md` snapshot and Agent A\'s proposed plan, then guide Agent A with prioritized Socratic questions before approving execution.',
          '',
          'Apply these stages:',
          '',
          '- `定义与目标`: clarify what the goal means in concrete, testable terms and what an excellent outcome must satisfy.',
          '- `依据与价值`: ask what evidence, constraints, or values justify A\'s proposed direction.',
          '- `反例与一致性`: test counterexamples, edge cases, hidden assumptions, and conflicts with `goal.md`.',
          '- `修正与约束`: ask A to revise the decision rule, scope, dependencies, or verification criteria.',
          '',
          'Prefer `request-changes` unless A\'s plan already answers these layers clearly. Put the highest-leverage questions in `advice` as concise guidance to Agent A; do not solve the task for A.',
          '',
        ].join('\n')
      : '';
  return renderPrompt(template, {
    folder: state.folder,
    goalText: goalText.trim() || '_(goal.md is empty)_',
    turn: String(state.turn),
    aBody: aBody.trim(),
    firstPlanReviewSocraticGuidance,
  });
}

function buildResearcherFeedbackPrompt(
  state: ResearchSessionState,
  evaluation: ReviewerEvaluation,
): string {
  const kind = researcherFeedbackKindForVerdict(evaluation.verdict);
  const template = `bridge/research-mode-feedback-${kind}`;
  return renderPrompt(template, {
    folder: state.folder,
    turn: String(state.turn),
    verdict: evaluation.verdict,
    advice: evaluation.advice.trim() || '_(no advice provided)_',
  });
}

/**
 * Truncate the agent's reply when embedding into the peer's next prompt so we
 * stay within token budgets. Keeps head + tail with an elision marker.
 */
function trimForEmbedding(text: string, maxChars = TRANSCRIPT_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n_…(elided ${text.length - head.length - tail.length} chars)…_\n\n${tail}`;
}

type ResumeLoopStep =
  | { kind: 'reviewer'; aStatus: ResearcherStatus; aBody: string }
  | { kind: 'researcher' };

interface BackgroundLoopParams {
  state: ResearchSessionState;
  bindingA: ChannelBinding;
  bindingB: ChannelBinding;
  llmA?: LLMProvider;
  llmB?: LLMProvider;
  mirror: ResearchMirror | null;
  telegramTarget: ResearchTelegramTarget | null;
  abortRef: { aborted: boolean; reason?: string };
  /** When set, skip bootstrap / reference re-index and resume from the last A↔B boundary. */
  resume?: ResumeLoopStep;
}

const TERMINAL_PHASES = new Set<ResearchSessionState['phase']>([
  'completed',
  'failed',
  'timeout',
  'aborted',
]);

function inferResumeStep(
  transcript: ResearchTranscriptEntry[],
  state: ResearchSessionState,
): ResumeLoopStep {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]!;
    if (e.kind === 'reviewer-reply') {
      if (!state.lastVerdict) {
        throw new ResearchSessionStoreError(
          'cannot resume: last reviewer reply has no parsed verdict on disk',
        );
      }
      return { kind: 'researcher' };
    }
    if (e.kind === 'researcher-reply') {
      const status = e.status ?? state.lastStatus;
      if (!status) {
        throw new ResearchSessionStoreError(
          'cannot resume: last researcher reply has no status to review',
        );
      }
      return {
        kind: 'reviewer',
        aStatus: status,
        aBody: trimForEmbedding(stripProtocolMarkers(e.text)),
      };
    }
    if (e.kind === 'orchestrator-note' && e.text.includes('→ B')) {
      const status = state.lastStatus;
      if (!status) {
        throw new ResearchSessionStoreError('cannot resume: awaiting reviewer but no lastStatus');
      }
      const lastA = transcript
        .slice()
        .reverse()
        .find((x) => x.kind === 'researcher-reply');
      const body = lastA
        ? trimForEmbedding(stripProtocolMarkers(lastA.text))
        : status.summary;
      return { kind: 'reviewer', aStatus: status, aBody: body };
    }
    if (e.kind === 'orchestrator-note' && e.text.includes('→ A')) {
      if (!state.lastVerdict) {
        throw new ResearchSessionStoreError('cannot resume: awaiting researcher but no lastVerdict');
      }
      return { kind: 'researcher' };
    }
  }
  if (state.lastVerdict) return { kind: 'researcher' };
  if (state.lastStatus) {
    return {
      kind: 'reviewer',
      aStatus: state.lastStatus,
      aBody: state.lastStatus.summary,
    };
  }
  throw new ResearchSessionStoreError('cannot resume: transcript is empty');
}

/** Fire-and-forget Telegram mirror for one agent turn (never blocks the loop). */
function mirrorAgentReplyToTelegram(
  target: ResearchTelegramTarget | null,
  payload: {
    role: 'researcher' | 'reviewer';
    sessionId: string;
    turn: number;
    text: string;
    meta?: string;
  },
): void {
  if (!target || !payload.text.trim()) return;
  void notifyTelegramAgentReply({ target, ...payload }).catch(() => {});
}

/**
 * Resolve the LLM provider for one side, in priority order:
 *   1. HTTP override (`runnerA` / `runnerB` query string / body)
 *   2. Configured top-level `research.researcherRunner` / `reviewerRunner`
 *      (with legacy fallback to the deprecated `imBot.research*Runner`)
 *   3. `undefined` (orchestrator falls back to the bridge default LLM)
 *
 * Also returns the **resolved runner id** so the session state can record
 * exactly which agent each side ended up using.
 *
 * @param override - Runner id from HTTP request
 * @param configured - Runner id from config
 * @param resolveLlmForRunner - Function to resolve LLM by runner id (from Research bridge)
 */
function resolveSideRunner(
  override: string | undefined,
  configured: string | undefined,
  resolveLlmForRunner: (id: string) => LLMProvider | undefined,
): { runnerId?: string; llm?: LLMProvider } {
  const candidate = override?.trim() || configured?.trim();
  if (!candidate) return {};
  const llm = resolveLlmForRunner?.(candidate);
  if (!llm) {
    getLogger().warn(
      { event: 'research_runner_not_built', runnerId: candidate },
      `[research-mode] requested runner "${candidate}" has no provider built; falling back to default LLM`,
    );
    return { runnerId: candidate };
  }
  return { runnerId: candidate, llm };
}

function readConfiguredDefaultMaxTurns(config: Config): number | undefined {
  try {
    const n = config.research?.defaultMaxTurns;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

function readConfiguredResearchRunnerIds(config: Config): { researcher?: string; reviewer?: string } {
  try {
    // Prefer top-level `Config.research`; fall back to legacy nested fields so
    // a stale `config.env` that hasn't been re-saved still works.
    const aId =
      config.research?.researcherRunner?.id?.trim() ||
      config.imBot?.researchResearcherRunner?.id?.trim();
    const bId =
      config.research?.reviewerRunner?.id?.trim() ||
      config.imBot?.researchReviewerRunner?.id?.trim();
    return { researcher: aId || undefined, reviewer: bId || undefined };
  } catch {
    return {};
  }
}

async function runOrchestratorLoop(
  params: BackgroundLoopParams,
): Promise<ResearchSessionState> {
  const { bindingA, bindingB, llmA, llmB, mirror, telegramTarget, abortRef } = params;
  let { state } = params;
  const log = getLogger().child({ scope: 'research-mode', sessionId: state.sessionId });

  const abortController = new AbortController();
  const checkAbort = (): boolean => {
    if (abortRef.aborted && !abortController.signal.aborted) {
      abortController.abort();
    }
    return abortController.signal.aborted;
  };

  let finalReason = 'maxTurns';
  let finalPhase: 'completed' | 'timeout' | 'aborted' | 'failed' = 'timeout';

  // Per-agent consecutive protocol-parse failure counters. Reset to 0 the moment
  // an agent produces a parseable status/verdict, so transient failures don't
  // accumulate across the whole session.
  let aParseFailStreak = 0;
  let bParseFailStreak = 0;

  // Expert council state — persisted in session state across potential restarts.
  let consecutiveRejects = state.consecutiveRejects ?? 0;
  let councilsTriggered = state.expertCouncilCount ?? 0;
  let sessionExperts: ExpertDefinition[] | undefined;
  let pendingExpertNotes = '';

  try {
    const goalText = readGoalText(state.folder);

    const cfg = (() => { try { return loadConfig(); } catch { return null; } })();
    const refDirName = cfg?.research?.reference?.dir ?? 'reference';
    const refRequired = cfg?.research?.reference?.required ?? false;
    const refMaxChars = cfg?.research?.reference?.maxChars ?? 40000;
    const kbVaultPath = cfg?.research?.knowledgeVaultPath;
    const expertCouncilConfig: ExpertCouncilConfig = cfg?.research?.expertCouncil ?? {};
    const isResume = Boolean(params.resume);

    // ── Reference indexing (skipped on continue when already indexed) ─────
    const BOOTSTRAP_BUDGET = 60000;
    const refBudget = Math.min(refMaxChars, Math.floor(BOOTSTRAP_BUDGET * 0.7));
    const kbBudget = Math.floor(BOOTSTRAP_BUDGET * 0.3);

    let referencePack = '';
    let manifest: ReferenceManifest | null = null;
    if (!isResume || !state.referencesIndexed) {
      manifest = indexReferences(state.folder);
      if (manifest && manifest.totalFiles > 0) {
        const sDir = path.join(state.folder, '.research', 'sessions', state.sessionId);
        writeManifest(sDir, manifest);
        referencePack = buildReferencePack(manifest, refBudget);
        state.referencesIndexed = manifest.totalFiles;
        state.referencePackChars = referencePack.length;
        writeState(state);

        appendTranscript(state, {
          turn: 0,
          role: 'orchestrator',
          kind: 'reference-index',
          text: `Indexed ${manifest.totalFiles} reference files (${manifest.totalTextBytes} bytes text, ${manifest.skippedFiles.length} binary skipped)`,
        });
      } else if (refRequired && !isResume) {
        markFinished(state, 'failed', `reference directory required but missing or empty: ${state.folder}/${refDirName}`);
        return state;
      }
    }

    let knowledgeSnippets = '';
    if (!isResume && kbVaultPath && isValidKnowledgeVault(kbVaultPath)) {
      const keywords = extractGoalKeywords(goalText);
      knowledgeSnippets = loadKnowledgeEntries(kbVaultPath, keywords, kbBudget);
    }

    log.info(
      {
        event: isResume ? 'research_loop_resume' : 'research_loop_start',
        folder: state.folder,
        telegramMirror: Boolean(telegramTarget),
        telegramBridge: telegramTarget?.bridgeSlug,
        referencesIndexed: state.referencesIndexed ?? 0,
        knowledgeLoaded: knowledgeSnippets.length > 0,
        resumeStep: params.resume?.kind,
      },
      isResume ? 'research loop resume' : 'research loop start',
    );
    recordOrchestratorNote(
      state,
      (isResume ? 'Loop resume' : 'Loop start') +
        `. folder=${state.folder} maxTurns=${state.maxTurns} turn=${state.turn}` +
        ` refs=${state.referencesIndexed ?? 0}` +
        (knowledgeSnippets ? ' kb=loaded' : ' kb=none') +
        (telegramTarget ? ` telegram→${telegramTarget.chatId}` : ' telegram=off') +
        (params.resume ? ` resume=${params.resume.kind}` : ''),
    );

    let nextResearcherPrompt = buildBootstrapPrompt(state.folder, goalText, referencePack, knowledgeSnippets);
    let nextResearcherKind: 'goal-bootstrap' | 'researcher-followup' = 'goal-bootstrap';
    if (params.resume?.kind === 'researcher') {
      if (!state.lastVerdict) {
        markFinished(state, 'failed', 'cannot resume researcher step: missing lastVerdict');
        return state;
      }
      nextResearcherPrompt = buildResearcherFeedbackPrompt(state, state.lastVerdict);
      nextResearcherKind = 'researcher-followup';
    }

    let pendingReviewerOnly: ResumeLoopStep | null =
      params.resume?.kind === 'reviewer' ? params.resume : null;

    while (state.turn < state.maxTurns) {
      if (checkAbort()) {
        finalPhase = 'aborted';
        finalReason = abortRef.reason ?? 'aborted by caller';
        break;
      }

      let aStatus: ResearcherStatus;
      let aBodyForPeer: string;

      if (pendingReviewerOnly?.kind === 'reviewer') {
        const rv = pendingReviewerOnly;
        pendingReviewerOnly = null;
        aStatus = rv.aStatus;
        aBodyForPeer = rv.aBody;
        recordOrchestratorNote(
          state,
          `→ B (resume review ${reviewerPromptKindForPhase(aStatus.phase)})`,
        );
      } else {
        // ── Researcher (Agent A) turn ──────────────────────────────────────
        appendTranscript(state, {
          turn: state.turn + 1,
          role: 'orchestrator',
          kind: nextResearcherKind,
          text:
            nextResearcherKind === 'goal-bootstrap'
              ? '→ A (bootstrap with goal.md)'
              : '→ A (followup from B)',
        });
        await mirror?.recordOrchestratorEvent({
          sessionId: state.sessionId,
          kind: 'researcher-prompt',
          turn: state.turn + 1,
          preview: nextResearcherPrompt.slice(0, 240),
        });

        const aResult = await processMessage(
          bindingA,
          nextResearcherPrompt,
          undefined,
          abortController.signal,
          undefined,
          undefined,
          { deliverySource: 'researcher', llmOverride: llmA },
        );

        if (aResult.hasError && !aResult.responseText) {
          log.warn({ event: 'research_a_error', err: aResult.errorMessage }, 'researcher errored');
          const errText = `[orchestrator] Agent A errored: ${aResult.errorMessage}`;
          recordResearcherReply(state, {
            text: errText,
            status: null,
            parseError: aResult.errorMessage || 'empty-response',
          });
          mirrorAgentReplyToTelegram(telegramTarget, {
            role: 'researcher',
            sessionId: state.sessionId,
            turn: state.turn + 1,
            text: errText,
            meta: 'error',
          });
          finalPhase = 'failed';
          finalReason = `Agent A errored: ${aResult.errorMessage}`;
          break;
        }

        const aText = aResult.responseText;
        const aParsed = parseResearcherStatus(aText);
        state = recordResearcherReply(state, {
          text: aText,
          status: aParsed.status,
          parseError: aParsed.ok ? undefined : aParsed.error,
        });
        await mirror?.recordTranscriptEntry({
          sessionId: state.sessionId,
          entry: {
            turn: state.turn,
            role: 'researcher',
            kind: 'researcher-reply',
            text: aText,
            status: aParsed.status ?? undefined,
            parseError: aParsed.ok ? undefined : aParsed.error,
            createdAt: nowIso(),
          },
        });

        mirrorAgentReplyToTelegram(telegramTarget, {
          role: 'researcher',
          sessionId: state.sessionId,
          turn: state.turn,
          text: aText,
          meta: aParsed.status
            ? `phase=${aParsed.status.phase}`
            : aParsed.error
              ? `parse-error=${aParsed.error}`
              : undefined,
        });

        if (!aParsed.ok || !aParsed.status) {
          aParseFailStreak += 1;
          if (aParseFailStreak >= MAX_CONSECUTIVE_PARSE_FAILURES) {
            recordOrchestratorNote(
              state,
              `A failed protocol parse ${aParseFailStreak} turns in a row (last error: ${aParsed.error}); aborting session.`,
            );
            finalPhase = 'failed';
            finalReason = `Agent A produced ${aParseFailStreak} consecutive un-parseable replies (last: ${
              aParsed.error ?? 'unknown'
            }). Last raw reply: ${aText.slice(0, 240)}`;
            break;
          }
          const correction = renderProtocolCorrectionForResearcher(aParsed.error ?? 'unknown');
          recordOrchestratorNote(
            state,
            `A status parse failed (${aParseFailStreak}/${MAX_CONSECUTIVE_PARSE_FAILURES}): ${aParsed.error}. Sending correction.`,
          );
          nextResearcherPrompt = correction;
          nextResearcherKind = 'researcher-followup';
          continue;
        }
        aParseFailStreak = 0;

        aStatus = aParsed.status;
        aBodyForPeer = trimForEmbedding(stripProtocolMarkers(aText));
      }

      // ── Reviewer (Agent B) turn ────────────────────────────────────────
      const reviewerPrompt = buildReviewerPrompt(state, goalText, aStatus, aBodyForPeer);
      appendTranscript(state, {
        turn: state.turn,
        role: 'orchestrator',
        kind: 'orchestrator-note',
        text: `→ B (review ${reviewerPromptKindForPhase(aStatus.phase)})`,
      });
      await mirror?.recordOrchestratorEvent({
        sessionId: state.sessionId,
        kind: 'reviewer-prompt',
        turn: state.turn,
        preview: reviewerPrompt.slice(0, 240),
      });

      const bResult = await processMessage(
        bindingB,
        reviewerPrompt,
        undefined,
        abortController.signal,
        undefined,
        undefined,
        { deliverySource: 'reviewer', llmOverride: llmB },
      );

      if (bResult.hasError && !bResult.responseText) {
        log.warn({ event: 'research_b_error', err: bResult.errorMessage }, 'reviewer errored');
        const errText = `[orchestrator] Agent B errored: ${bResult.errorMessage}`;
        recordReviewerReply(state, {
          text: errText,
          verdict: null,
          parseError: bResult.errorMessage || 'empty-response',
        });
        mirrorAgentReplyToTelegram(telegramTarget, {
          role: 'reviewer',
          sessionId: state.sessionId,
          turn: state.turn,
          text: errText,
          meta: 'error',
        });
        finalPhase = 'failed';
        finalReason = `Agent B errored: ${bResult.errorMessage}`;
        break;
      }

      const bText = bResult.responseText;
      const bParsed = parseReviewerVerdict(bText);
      state = recordReviewerReply(state, {
        text: bText,
        verdict: bParsed.evaluation,
        parseError: bParsed.ok ? undefined : bParsed.error,
      });
      await mirror?.recordTranscriptEntry({
        sessionId: state.sessionId,
        entry: {
          turn: state.turn,
          role: 'reviewer',
          kind: 'reviewer-reply',
          text: bText,
          verdict: bParsed.evaluation ?? undefined,
          parseError: bParsed.ok ? undefined : bParsed.error,
          createdAt: nowIso(),
        },
      });

      mirrorAgentReplyToTelegram(telegramTarget, {
        role: 'reviewer',
        sessionId: state.sessionId,
        turn: state.turn,
        text: bText,
        meta: bParsed.evaluation
          ? `verdict=${bParsed.evaluation.verdict}`
          : bParsed.error
            ? `parse-error=${bParsed.error}`
            : undefined,
      });

      if (!bParsed.ok || !bParsed.evaluation) {
        bParseFailStreak += 1;
        if (bParseFailStreak >= MAX_CONSECUTIVE_PARSE_FAILURES) {
          recordOrchestratorNote(
            state,
            `B failed protocol parse ${bParseFailStreak} turns in a row (last error: ${bParsed.error}); aborting session.`,
          );
          finalPhase = 'failed';
          finalReason = `Agent B produced ${bParseFailStreak} consecutive un-parseable replies (last: ${
            bParsed.error ?? 'unknown'
          }). Last raw reply: ${bText.slice(0, 240)}`;
          break;
        }
        // Reviewer protocol violation — try once more by re-sending the review prompt
        // with a short correction nudge prepended.
        const correction = renderProtocolCorrectionForReviewer(bParsed.error ?? 'unknown');
        recordOrchestratorNote(
          state,
          `B verdict parse failed (${bParseFailStreak}/${MAX_CONSECUTIVE_PARSE_FAILURES}): ${bParsed.error}. Sending correction.`,
        );
        nextResearcherPrompt = correction + '\n\n' + reviewerPrompt;
        nextResearcherKind = 'researcher-followup';
        continue;
      }
      bParseFailStreak = 0;

      const bEval = bParsed.evaluation;

      // ── Track consecutive rejections for expert council ─────────────────
      const isRejection = bEval.verdict === 'request-changes' || bEval.verdict === 'reject-complete';
      const isApproval = bEval.verdict === 'approve-plan' || bEval.verdict === 'confirm-complete';
      if (isRejection) {
        consecutiveRejects += 1;
      }
      if (isApproval) {
        consecutiveRejects = 0;
      }
      // Persist rejection counter
      state.consecutiveRejects = consecutiveRejects;
      writeState(state);

      // ── Decide next step ───────────────────────────────────────────────
      if (isMutualCompletion(aStatus, bEval)) {
        finalPhase = 'completed';
        finalReason = 'both A and B agreed task is complete';
        break;
      }

      // ── Expert council trigger ─────────────────────────────────────────
      if (shouldTriggerExpertCouncil(consecutiveRejects, councilsTriggered, expertCouncilConfig)) {
        log.info(
          { event: 'expert_council_trigger', consecutiveRejects, councilsTriggered },
          'triggering expert council due to consecutive rejections',
        );
        recordOrchestratorNote(
          state,
          `Expert council triggered (${consecutiveRejects} consecutive rejections). Consulting domain experts...`,
        );

        const sessionDirPath = path.join(state.folder, '.research', 'sessions', state.sessionId);
        const goalText = readGoalText(state.folder);

        // Build a summary of references for expert determination
        const refSummary = manifest
          ? `Reference files available: ${manifest.files.map((f) => f.relativePath).join(', ')}`
          : '';

        const councilResult: ExpertCouncilResult = await runExpertCouncil({
          goalText,
          referencesSummary: refSummary,
          currentPlanSummary: state.lastStatus?.summary ?? '(no plan summary)',
          lastReviewerAdvice: bEval.advice,
          failedAttempts: `${consecutiveRejects} consecutive rejections`,
          workingDir: state.folder,
          sessionDir: sessionDirPath,
          existingExperts: sessionExperts,
          config: expertCouncilConfig,
          abortSignal: abortController.signal,
        });

        sessionExperts = councilResult.experts;
        councilsTriggered += 1;
        state.expertCouncilCount = councilsTriggered;
        state.expertCouncilTriggeredAt = councilResult.triggeredAt;
        state.expertsInvoked = councilResult.experts.map((e) => e.id);
        writeState(state);

        pendingExpertNotes = councilResult.formattedNotes;

        // Record expert consultation in transcript
        appendTranscript(state, {
          turn: state.turn,
          role: 'expert',
          kind: 'expert-consult',
          text: councilResult.formattedNotes.slice(0, 5000),
        });

        mirrorAgentReplyToTelegram(telegramTarget, {
          role: 'researcher',
          sessionId: state.sessionId,
          turn: state.turn,
          text: `[expert-council] ${councilResult.experts.length} experts consulted`,
          meta: `experts=${councilResult.experts.map((e) => e.id).join(',')}`,
        });
      }

      // ── Build next researcher prompt ───────────────────────────────────
      if (pendingExpertNotes) {
        // Use the expert-enhanced feedback template
        const kind = researcherFeedbackKindForVerdict(bEval.verdict);
        if (kind === 'plan') {
          nextResearcherPrompt = renderPrompt('bridge/research-mode-feedback-plan-with-experts', {
            folder: state.folder,
            turn: String(state.turn),
            verdict: bEval.verdict,
            advice: bEval.advice.trim() || '_(no advice provided)_',
            expertNotes: pendingExpertNotes,
          });
        } else {
          // For blocker/completion, prepend expert notes to standard template
          const basePrompt = buildResearcherFeedbackPrompt(state, bEval);
          nextResearcherPrompt = basePrompt + '\n\n' + pendingExpertNotes;
        }
        pendingExpertNotes = ''; // Clear after use
      } else {
        // Standard feedback (no expert notes)
        nextResearcherPrompt = buildResearcherFeedbackPrompt(state, bEval);
      }
      nextResearcherKind = 'researcher-followup';
    }

    if (state.turn >= state.maxTurns && finalPhase === 'timeout') {
      finalReason = `max turns reached (${state.maxTurns}) without mutual completion`;
    }
  } catch (err) {
    finalPhase = 'failed';
    finalReason = err instanceof Error ? err.message : String(err);
    log.warn({ event: 'research_loop_exception', err: finalReason }, 'research loop exception');
  }

  state = markFinished(state, finalPhase, finalReason);
  const resultPath = writeResultMarkdown({
    state,
    outcome: finalPhase,
    reason: finalReason,
  });
  recordOrchestratorNote(state, `Loop end. phase=${finalPhase} result=${resultPath}`);
  await mirror?.recordOrchestratorEvent({
    sessionId: state.sessionId,
    kind: 'session-end',
    turn: state.turn,
    preview: `${finalPhase}: ${finalReason}`,
  });

  if (telegramTarget) {
    try {
      await notifyTelegramCompletion({
        target: telegramTarget,
        state,
        outcome: finalPhase,
        reason: finalReason,
        resultPath,
      });
    } catch (err) {
      log.warn(
        { event: 'research_telegram_notify_failed', err: err instanceof Error ? err.message : err },
        'telegram completion notice failed',
      );
    }
  }

  return state;
}

function renderProtocolCorrectionForResearcher(reason: string): string {
  return [
    '## ORCHESTRATOR_PROTOCOL_CORRECTION',
    '',
    'Your previous reply did not end with a valid `RESEARCH_A_STATUS_JSON:` line.',
    `Parse error: \`${reason}\`.`,
    '',
    'Please repeat your previous content and **end with exactly one line** of the form:',
    '',
    '```',
    'RESEARCH_A_STATUS_JSON: {"phase": "plan" | "blocker" | "complete", "summary": "…", "next": "…"}',
    '```',
    '',
    'No text after that line.',
  ].join('\n');
}

function renderProtocolCorrectionForReviewer(reason: string): string {
  return [
    '## ORCHESTRATOR_PROTOCOL_CORRECTION',
    '',
    'Your previous reply did not end with a valid `RESEARCH_B_VERDICT_JSON:` line.',
    `Parse error: \`${reason}\`.`,
    '',
    'Please repeat your previous content and **end with exactly one line** of the form:',
    '',
    '```',
    'RESEARCH_B_VERDICT_JSON: {"verdict": "approve-plan" | "request-changes" | "suggest-direction" | "confirm-complete" | "reject-complete", "advice": "…"}',
    '```',
    '',
    'No text after that line.',
  ].join('\n');
}

/**
 * Start a research session. Returns immediately with the state and a promise
 * that resolves when the loop ends; callers can poll the on-disk state if they
 * don't want to await the promise.
 *
 * Uses the dedicated Research bridge if available, otherwise falls back to
 * the global BridgeContext.
 */
export async function startResearchSession(
  input: StartResearchSessionInput,
): Promise<StartResearchSessionResult> {
  const resources = await getResearchBridgeResources();
  const { store, config, resolveLlmForRunner } = resources;
  const goalPath = resolveGoalPath(input.folder);
  const folder = goalPath.slice(0, goalPath.length - ('/' + GOAL_FILE_NAME).length);
  const maxTurns = input.maxTurns ?? readConfiguredDefaultMaxTurns(config) ?? DEFAULT_MAX_TURNS;

  // Resolve which runner backs each side: explicit HTTP override wins, then
  // configured top-level `Config.research.researcher/reviewerRunner` (with
  // legacy fallback to `imBot.research*Runner`), then the bridge default LLM.
  // The chosen runner id (if any) is persisted so the session state and
  // result.md show exactly which agent each side ended up using.
  const configuredIds = readConfiguredResearchRunnerIds(config);
  const sideA = resolveSideRunner(input.runnerA, configuredIds.researcher, resolveLlmForRunner);
  const sideB = resolveSideRunner(input.runnerB, configuredIds.reviewer, resolveLlmForRunner);

  let state = createSession({
    folder,
    maxTurns,
    runnerA: sideA.runnerId,
    runnerB: sideB.runnerId,
  });

  // Underlying message sessions (one per agent) so the conversation engine can
  // persist context and the LLM provider sees per-side history.
  const sessionA = store.createSession(
    `research-A-${state.sessionId}`,
    '',
    undefined,
    state.folder,
    'code',
  );
  const sessionB = store.createSession(
    `research-B-${state.sessionId}`,
    '',
    undefined,
    state.folder,
    'code',
  );
  state.sessionIdA = sessionA.id;
  state.sessionIdB = sessionB.id;
  writeState(state);

  const bindingA = syntheticBinding({
    channelTypeSuffix: 'researcher',
    chatId: `research:${state.sessionId}:A`,
    sessionId: sessionA.id,
    folder: state.folder,
    runnerProfileId: sideA.runnerId,
  });
  const bindingB = syntheticBinding({
    channelTypeSuffix: 'reviewer',
    chatId: `research:${state.sessionId}:B`,
    sessionId: sessionB.id,
    folder: state.folder,
    runnerProfileId: sideB.runnerId,
  });

  const mirror = resolveResearchMirror({
    folder: state.folder,
    sessionId: state.sessionId,
    runnerA: sideA.runnerId,
    runnerB: sideB.runnerId,
  });
  void mirror?.recordOrchestratorEvent({
    sessionId: state.sessionId,
    kind: 'session-start',
    turn: 0,
    preview: `folder=${state.folder} maxTurns=${state.maxTurns}`,
  });

  const telegramTarget = resolveResearchTelegramTarget(input.notifyTelegram);
  if (!telegramTarget) {
    getLogger().info(
      { event: 'research_telegram_mirror_disabled' },
      '[research-mode] Telegram mirror off (no bot token + chat id resolved)',
    );
  }

  const abortRef: { aborted: boolean; reason?: string } = { aborted: false };
  const done = runOrchestratorLoop({
    state,
    bindingA,
    bindingB,
    llmA: sideA.llm,
    llmB: sideB.llm,
    mirror,
    telegramTarget,
    abortRef,
  });

  return {
    state,
    done,
    abort: (reason?: string) => {
      abortRef.aborted = true;
      abortRef.reason = reason ?? 'aborted';
    },
  };
}

function ensureBridgeSession(
  store: ReturnType<typeof getBridgeContext>['store'],
  existingId: string | undefined,
  label: string,
  folder: string,
): string {
  if (existingId) {
    const hit = store.getSession(existingId);
    if (hit) return hit.id;
  }
  const created = store.createSession(label, '', undefined, folder, 'code');
  return created.id;
}

/**
 * Resume a terminal research session on disk (same sessionId, transcript preserved).
 */
export async function continueResearchSession(
  input: ContinueResearchSessionInput,
): Promise<StartResearchSessionResult> {
  const folder = path.resolve(input.folder);
  const sessionId = input.sessionId.trim();
  const existing = readState(folder, sessionId);
  if (!existing) {
    throw new ResearchSessionStoreError(`session not found: ${sessionId}`);
  }
  if (!TERMINAL_PHASES.has(existing.phase)) {
    throw new ResearchSessionStoreError(
      `session phase is "${existing.phase}"; only terminal sessions can continue`,
    );
  }

  let state = { ...existing };
  if (input.maxTurns !== undefined) {
    if (!Number.isFinite(input.maxTurns) || input.maxTurns <= state.turn) {
      throw new ResearchSessionStoreError('maxTurns must be greater than current turn');
    }
    state.maxTurns = Math.floor(input.maxTurns);
  } else if (input.additionalMaxTurns !== undefined) {
    if (!Number.isFinite(input.additionalMaxTurns) || input.additionalMaxTurns <= 0) {
      throw new ResearchSessionStoreError('additionalMaxTurns must be a positive number');
    }
    state.maxTurns = Math.max(state.maxTurns, state.turn) + Math.floor(input.additionalMaxTurns);
  } else if (state.turn >= state.maxTurns) {
    state.maxTurns = state.turn + 10;
  }

  const transcript = readTranscript(folder, sessionId);
  const resume = inferResumeStep(transcript, state);
  state.phase = resume.kind === 'reviewer' ? 'awaiting-reviewer' : 'awaiting-researcher';
  delete state.finishedAt;
  delete state.finishedReason;
  writeState(state);

  const resources = await getResearchBridgeResources();
  const { store, config, resolveLlmForRunner } = resources;
  const configuredIds = readConfiguredResearchRunnerIds(config);
  const sideA = resolveSideRunner(input.runnerA ?? state.runnerA, configuredIds.researcher, resolveLlmForRunner);
  const sideB = resolveSideRunner(input.runnerB ?? state.runnerB, configuredIds.reviewer, resolveLlmForRunner);

  state.sessionIdA = ensureBridgeSession(
    store,
    state.sessionIdA,
    `research-A-${state.sessionId}`,
    state.folder,
  );
  state.sessionIdB = ensureBridgeSession(
    store,
    state.sessionIdB,
    `research-B-${state.sessionId}`,
    state.folder,
  );
  state.runnerA = sideA.runnerId ?? state.runnerA;
  state.runnerB = sideB.runnerId ?? state.runnerB;
  writeState(state);

  const bindingA = syntheticBinding({
    channelTypeSuffix: 'researcher',
    chatId: `research:${state.sessionId}:A`,
    sessionId: state.sessionIdA,
    folder: state.folder,
    runnerProfileId: state.runnerA,
  });
  const bindingB = syntheticBinding({
    channelTypeSuffix: 'reviewer',
    chatId: `research:${state.sessionId}:B`,
    sessionId: state.sessionIdB,
    folder: state.folder,
    runnerProfileId: state.runnerB,
  });

  const mirror = resolveResearchMirror({
    folder: state.folder,
    sessionId: state.sessionId,
    runnerA: state.runnerA,
    runnerB: state.runnerB,
  });
  const telegramTarget = resolveResearchTelegramTarget(input.notifyTelegram);
  const abortRef: { aborted: boolean; reason?: string } = { aborted: false };
  const done = runOrchestratorLoop({
    state,
    bindingA,
    bindingB,
    llmA: sideA.llm,
    llmB: sideB.llm,
    mirror,
    telegramTarget,
    abortRef,
    resume,
  });

  return {
    state,
    done,
    abort: (reason?: string) => {
      abortRef.aborted = true;
      abortRef.reason = reason ?? 'aborted';
    },
  };
}

/** Public re-exports for the HTTP layer. */
export {
  listSessions,
  readState,
  readTranscript,
  getResultPath,
  type ResearchSessionState,
  type ResearchTranscriptEntry,
};
