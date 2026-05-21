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
 *   • Telegram notify (`research-telegram-notify.ts`) — emits a single
 *     completion message when the orchestrator agrees the task is done.
 */

import type { ChannelBinding } from '../types';
import type { LLMProvider } from '../host';
import { getBridgeContext } from '../context';
import { processMessage } from '../conversation-engine';
import { renderPrompt } from '../../../prompts/loader';
import { getLogger } from '../../../logger';
import { loadConfig } from '../../../config';

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
import { notifyTelegramCompletion } from './telegram-notify';

export interface StartResearchSessionInput {
  /** Absolute folder containing `goal.md`. */
  folder: string;
  /** Cap on the number of researcher turns (each turn = A + B exchange). Defaults to 30. */
  maxTurns?: number;
  /** Informational — currently logged for traceability; LLM selection still uses bridge default. */
  runnerA?: string;
  runnerB?: string;
  /** If set, post a Telegram notice when the loop ends. */
  notifyTelegram?: { chatId: string; instanceId?: string };
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

/** Build the bootstrap prompt that seeds Agent A with the goal text. */
function buildBootstrapPrompt(folder: string, goalText: string): string {
  return renderPrompt('bridge/research-mode-bootstrap', {
    folder,
    goalText: goalText.trim() || '_(goal.md is empty)_',
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
  return renderPrompt(template, {
    folder: state.folder,
    goalText: goalText.trim() || '_(goal.md is empty)_',
    turn: String(state.turn),
    aBody: aBody.trim(),
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

interface BackgroundLoopParams {
  state: ResearchSessionState;
  bindingA: ChannelBinding;
  bindingB: ChannelBinding;
  llmA?: LLMProvider;
  llmB?: LLMProvider;
  mirror: ResearchMirror | null;
  notifyTelegram?: StartResearchSessionInput['notifyTelegram'];
  abortRef: { aborted: boolean; reason?: string };
}

/**
 * Resolve the LLM provider for one side, in priority order:
 *   1. HTTP override (`runnerA` / `runnerB` query string / body)
 *   2. Configured `imBot.researchResearcherRunner` / `researchReviewerRunner`
 *   3. `undefined` (orchestrator falls back to the bridge default LLM)
 *
 * Also returns the **resolved runner id** so the session state can record
 * exactly which agent each side ended up using.
 */
function resolveSideRunner(
  override: string | undefined,
  configured: string | undefined,
): { runnerId?: string; llm?: LLMProvider } {
  const ctx = getBridgeContext();
  const candidate = override?.trim() || configured?.trim();
  if (!candidate) return {};
  const llm = ctx.resolveLlmForRunner?.(candidate);
  if (!llm) {
    getLogger().warn(
      { event: 'research_runner_not_built', runnerId: candidate },
      `[research-mode] requested runner "${candidate}" has no provider built; falling back to default LLM`,
    );
    return { runnerId: candidate };
  }
  return { runnerId: candidate, llm };
}

function readConfiguredResearchRunnerIds(): { researcher?: string; reviewer?: string } {
  try {
    const cfg = loadConfig();
    const aId = cfg.imBot?.researchResearcherRunner?.id?.trim();
    const bId = cfg.imBot?.researchReviewerRunner?.id?.trim();
    return { researcher: aId || undefined, reviewer: bId || undefined };
  } catch {
    return {};
  }
}

async function runOrchestratorLoop(
  params: BackgroundLoopParams,
): Promise<ResearchSessionState> {
  const { bindingA, bindingB, llmA, llmB, mirror, notifyTelegram, abortRef } = params;
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

  try {
    const goalText = readGoalText(state.folder);

    log.info({ event: 'research_loop_start', folder: state.folder }, 'research loop start');
    recordOrchestratorNote(state, `Loop start. folder=${state.folder} maxTurns=${state.maxTurns}`);

    let nextResearcherPrompt = buildBootstrapPrompt(state.folder, goalText);
    let nextResearcherKind: 'goal-bootstrap' | 'researcher-followup' = 'goal-bootstrap';

    while (state.turn < state.maxTurns) {
      if (checkAbort()) {
        finalPhase = 'aborted';
        finalReason = abortRef.reason ?? 'aborted by caller';
        break;
      }

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
        recordResearcherReply(state, {
          text: `[orchestrator] Agent A errored: ${aResult.errorMessage}`,
          status: null,
          parseError: aResult.errorMessage || 'empty-response',
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
        // Researcher violated protocol — give them one more chance via a corrective followup.
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

      const aStatus = aParsed.status;
      const aBodyForPeer = trimForEmbedding(stripProtocolMarkers(aText));

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
        recordReviewerReply(state, {
          text: `[orchestrator] Agent B errored: ${bResult.errorMessage}`,
          verdict: null,
          parseError: bResult.errorMessage || 'empty-response',
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

      // ── Decide next step ───────────────────────────────────────────────
      if (isMutualCompletion(aStatus, bEval)) {
        finalPhase = 'completed';
        finalReason = 'both A and B agreed task is complete';
        break;
      }

      // Otherwise, hand B's verdict back to A for the next turn.
      nextResearcherPrompt = buildResearcherFeedbackPrompt(state, bEval);
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

  if (notifyTelegram) {
    try {
      await notifyTelegramCompletion({
        chatId: notifyTelegram.chatId,
        instanceId: notifyTelegram.instanceId,
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
 */
export function startResearchSession(
  input: StartResearchSessionInput,
): StartResearchSessionResult {
  const { store } = getBridgeContext();
  const goalPath = resolveGoalPath(input.folder);
  const folder = goalPath.slice(0, goalPath.length - ('/' + GOAL_FILE_NAME).length);
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;

  // Resolve which runner backs each side: explicit HTTP override wins, then
  // configured `imBot.researchResearcherRunner` / `researchReviewerRunner`, then
  // the bridge default LLM. The chosen runner id (if any) is persisted so the
  // session state and result.md show exactly which agent did each role.
  const configuredIds = readConfiguredResearchRunnerIds();
  const sideA = resolveSideRunner(input.runnerA, configuredIds.researcher);
  const sideB = resolveSideRunner(input.runnerB, configuredIds.reviewer);

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

  const abortRef: { aborted: boolean; reason?: string } = { aborted: false };
  const done = runOrchestratorLoop({
    state,
    bindingA,
    bindingB,
    llmA: sideA.llm,
    llmB: sideB.llm,
    mirror,
    notifyTelegram: input.notifyTelegram,
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

/** Public re-exports for the HTTP layer. */
export {
  listSessions,
  readState,
  readTranscript,
  getResultPath,
  type ResearchSessionState,
  type ResearchTranscriptEntry,
};
