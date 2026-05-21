/**
 * Research mode protocol — structured markers exchanged between Agent A
 * (researcher) and Agent B (senior reviewer).
 *
 * Each turn ends with one tagged JSON line; the orchestrator parses the
 * **last** matching line in the agent's reply to decide the next action.
 *
 * The shape is deliberately compact: `phase`/`verdict` drives the loop,
 * `summary`/`advice` is shown to the peer and persisted in the transcript.
 */

export const RESEARCH_A_STATUS_PREFIX = 'RESEARCH_A_STATUS_JSON:';
export const RESEARCH_B_VERDICT_PREFIX = 'RESEARCH_B_VERDICT_JSON:';

export type ResearcherPhase = 'plan' | 'blocker' | 'complete';

export interface ResearcherStatus {
  phase: ResearcherPhase;
  summary: string;
  next: string;
}

export type ReviewerVerdict =
  | 'approve-plan'
  | 'request-changes'
  | 'suggest-direction'
  | 'confirm-complete'
  | 'reject-complete';

export interface ReviewerEvaluation {
  verdict: ReviewerVerdict;
  advice: string;
}

const RESEARCHER_PHASE_VALUES: readonly ResearcherPhase[] = [
  'plan',
  'blocker',
  'complete',
] as const;

const REVIEWER_VERDICT_VALUES: readonly ReviewerVerdict[] = [
  'approve-plan',
  'request-changes',
  'suggest-direction',
  'confirm-complete',
  'reject-complete',
] as const;

function isResearcherPhase(v: unknown): v is ResearcherPhase {
  return typeof v === 'string' && (RESEARCHER_PHASE_VALUES as readonly string[]).includes(v);
}

function isReviewerVerdict(v: unknown): v is ReviewerVerdict {
  return typeof v === 'string' && (REVIEWER_VERDICT_VALUES as readonly string[]).includes(v);
}

/**
 * Returns the JSON payload from the **last** line of `text` starting with `prefix`.
 *
 * Agents are instructed to emit the tagged line at the end of their reply, but
 * are sometimes verbose; scanning bottom-up makes the parser robust to trailing
 * whitespace, code fences the model inserted on its own, or repeated emissions.
 */
function extractLastTaggedJsonPayload(text: string, prefix: string): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function safeString(v: unknown, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  return v;
}

export interface ParsedAStatus {
  ok: boolean;
  status: ResearcherStatus | null;
  error?: string;
}

export function parseResearcherStatus(text: string): ParsedAStatus {
  const payload = extractLastTaggedJsonPayload(text, RESEARCH_A_STATUS_PREFIX);
  if (!payload) {
    return { ok: false, status: null, error: 'missing-tagged-json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `invalid-json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: null, error: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isResearcherPhase(obj.phase)) {
    return { ok: false, status: null, error: `invalid-phase: ${String(obj.phase)}` };
  }
  return {
    ok: true,
    status: {
      phase: obj.phase,
      summary: safeString(obj.summary).slice(0, 1000),
      next: safeString(obj.next).slice(0, 1000),
    },
  };
}

export interface ParsedBVerdict {
  ok: boolean;
  evaluation: ReviewerEvaluation | null;
  error?: string;
}

export function parseReviewerVerdict(text: string): ParsedBVerdict {
  const payload = extractLastTaggedJsonPayload(text, RESEARCH_B_VERDICT_PREFIX);
  if (!payload) {
    return { ok: false, evaluation: null, error: 'missing-tagged-json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      evaluation: null,
      error: `invalid-json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, evaluation: null, error: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isReviewerVerdict(obj.verdict)) {
    return { ok: false, evaluation: null, error: `invalid-verdict: ${String(obj.verdict)}` };
  }
  return {
    ok: true,
    evaluation: {
      verdict: obj.verdict,
      advice: safeString(obj.advice).slice(0, 4000),
    },
  };
}

/**
 * Strip the tagged JSON line(s) from an agent reply so the peer sees only the
 * human-readable narrative when we embed it in a downstream prompt.
 *
 * Both prefixes are removed defensively (agents occasionally emit both due to
 * confusion); leading/trailing whitespace and orphan code fences are trimmed.
 */
export function stripProtocolMarkers(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const keep = lines.filter((line) => {
    const t = line.trim();
    if (t.startsWith(RESEARCH_A_STATUS_PREFIX)) return false;
    if (t.startsWith(RESEARCH_B_VERDICT_PREFIX)) return false;
    return true;
  });
  // Drop trailing empty / fence-only lines so the body is tight.
  while (keep.length > 0) {
    const last = keep[keep.length - 1]!.trim();
    if (last === '' || last === '```' || last === '```json') {
      keep.pop();
      continue;
    }
    break;
  }
  return keep.join('\n').trim();
}

/**
 * Decide whether the session has reached a terminal state.
 *
 * Both A and B must agree: A must claim `complete` AND B must answer with
 * `confirm-complete` on the very next reviewer turn. Anything else continues
 * the loop.
 */
export function isMutualCompletion(
  aStatus: ResearcherStatus,
  bEval: ReviewerEvaluation,
): boolean {
  return aStatus.phase === 'complete' && bEval.verdict === 'confirm-complete';
}

/**
 * Map the researcher's current phase to which review template the orchestrator
 * should hand to Agent B.
 */
export function reviewerPromptKindForPhase(
  phase: ResearcherPhase,
): 'plan' | 'blocker' | 'completion' {
  switch (phase) {
    case 'plan':
      return 'plan';
    case 'blocker':
      return 'blocker';
    case 'complete':
      return 'completion';
  }
}

/**
 * Map the reviewer's verdict to which feedback template Agent A should see next.
 */
export function researcherFeedbackKindForVerdict(
  verdict: ReviewerVerdict,
): 'plan' | 'blocker' | 'completion' {
  switch (verdict) {
    case 'approve-plan':
    case 'request-changes':
      return 'plan';
    case 'suggest-direction':
      return 'blocker';
    case 'confirm-complete':
    case 'reject-complete':
      return 'completion';
  }
}
