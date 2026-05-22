/**
 * Filesystem-backed session store for research mode.
 *
 * Per session, we lay out:
 *
 *   <folder>/
 *     goal.md                       (read-only input authored by the user)
 *     .research/
 *       sessions/
 *         <sessionId>/
 *           state.json              (current status, turn count, last verdict)
 *           transcript.jsonl        (one JSON entry per turn, append-only)
 *       result-<sessionId>.md       (final write on agreed completion or timeout)
 *
 * The folder is the single source of truth for the goal; `goal.md` is also
 * re-read at every turn boundary so the user can edit it mid-session.
 *
 * Filesystem is intentionally chosen as the **primary** transport so the
 * orchestrator can run with zero external dependencies (Redis is optional
 * and used only for monitor mirroring).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  ResearcherStatus,
  ReviewerEvaluation,
  ReviewerVerdict,
} from './protocol';

export type ResearchSessionPhase =
  | 'pending'
  | 'awaiting-reviewer'
  | 'awaiting-researcher'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timeout';

export interface ResearchTranscriptEntry {
  turn: number;
  role: 'orchestrator' | 'researcher' | 'reviewer' | 'expert';
  /** Researcher-status / reviewer-verdict / orchestrator note. */
  kind:
    | 'goal-bootstrap'
    | 'researcher-followup'
    | 'researcher-reply'
    | 'reviewer-reply'
    | 'orchestrator-note'
    | 'reference-index'
    | 'expert-consult';
  /** Body text — for replies, the full reply incl. trailing tagged JSON. */
  text: string;
  /** Parsed marker payload, if any. */
  status?: ResearcherStatus;
  verdict?: ReviewerEvaluation;
  /** Parse error message when a reply was missing a valid tagged JSON line. */
  parseError?: string;
  createdAt: string;
}

export interface ResearchSessionState {
  sessionId: string;
  folder: string;
  goalPath: string;
  createdAt: string;
  updatedAt: string;
  phase: ResearchSessionPhase;
  turn: number;
  /** Most recent researcher status. */
  lastStatus?: ResearcherStatus;
  /** Most recent reviewer verdict. */
  lastVerdict?: ReviewerEvaluation;
  /** Set when the session has terminated. */
  finishedAt?: string;
  /** Human-readable termination reason. */
  finishedReason?: string;
  /** Max turns; once reached the session is marked `timeout`. */
  maxTurns: number;
  /** runner ids assigned to each side (informational). */
  runnerA?: string;
  runnerB?: string;
  /** Underlying provider session ids (for log-cross-reference). */
  sessionIdA?: string;
  sessionIdB?: string;

  // ── Expert Council state ──────────────────────────────────────────────
  /** Consecutive reviewer rejection count (reset on approve-plan / confirm-complete). */
  consecutiveRejects?: number;
  /** Number of times the expert council has been triggered this session. */
  expertCouncilCount?: number;
  /** Timestamp of last expert council trigger. */
  expertCouncilTriggeredAt?: string;
  /** IDs of experts determined for this session. */
  expertsInvoked?: string[];

  // ── Reference state ───────────────────────────────────────────────────
  /** Number of reference files indexed at startup. */
  referencesIndexed?: number;
  /** Total chars of reference pack injected. */
  referencePackChars?: number;
}

export interface CreateSessionInput {
  folder: string;
  maxTurns: number;
  runnerA?: string;
  runnerB?: string;
}

export const RESEARCH_DIR_NAME = '.research';
export const GOAL_FILE_NAME = 'goal.md';

export class ResearchSessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchSessionStoreError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function sessionDir(folder: string, sessionId: string): string {
  return path.join(folder, RESEARCH_DIR_NAME, 'sessions', sessionId);
}

function statePath(folder: string, sessionId: string): string {
  return path.join(sessionDir(folder, sessionId), 'state.json');
}

function transcriptPath(folder: string, sessionId: string): string {
  return path.join(sessionDir(folder, sessionId), 'transcript.jsonl');
}

function resultPath(folder: string, sessionId: string): string {
  return path.join(folder, RESEARCH_DIR_NAME, `result-${sessionId}.md`);
}

function safeFolder(folder: string): string {
  if (!folder || typeof folder !== 'string') {
    throw new ResearchSessionStoreError('folder is required');
  }
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs)) {
    throw new ResearchSessionStoreError(`folder does not exist: ${abs}`);
  }
  if (!fs.statSync(abs).isDirectory()) {
    throw new ResearchSessionStoreError(`folder is not a directory: ${abs}`);
  }
  return abs;
}

/**
 * Look up the goal file inside the working folder.
 *
 * Only `goal.md` (case-sensitive) is supported; the user explicitly asked for
 * that one filename. Throws a `ResearchSessionStoreError` so callers can
 * surface a useful HTTP response.
 */
export function resolveGoalPath(folder: string): string {
  const abs = safeFolder(folder);
  const goal = path.join(abs, GOAL_FILE_NAME);
  if (!fs.existsSync(goal)) {
    throw new ResearchSessionStoreError(
      `goal file not found: ${goal} (expected '${GOAL_FILE_NAME}' inside the working folder)`,
    );
  }
  if (!fs.statSync(goal).isFile()) {
    throw new ResearchSessionStoreError(`goal path is not a regular file: ${goal}`);
  }
  return goal;
}

export function readGoalText(folder: string): string {
  const goalPath = resolveGoalPath(folder);
  return fs.readFileSync(goalPath, 'utf8');
}

export function createSession(input: CreateSessionInput): ResearchSessionState {
  const folder = safeFolder(input.folder);
  const goalPath = resolveGoalPath(folder);
  const sessionId = crypto.randomUUID();
  ensureDir(sessionDir(folder, sessionId));

  const state: ResearchSessionState = {
    sessionId,
    folder,
    goalPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    phase: 'pending',
    turn: 0,
    maxTurns: Math.max(1, Math.floor(input.maxTurns)),
    runnerA: input.runnerA,
    runnerB: input.runnerB,
  };
  fs.writeFileSync(statePath(folder, sessionId), JSON.stringify(state, null, 2));
  // touch transcript so readers don't ENOENT
  fs.writeFileSync(transcriptPath(folder, sessionId), '');
  return state;
}

export function readState(folder: string, sessionId: string): ResearchSessionState | null {
  try {
    const raw = fs.readFileSync(statePath(folder, sessionId), 'utf8');
    return JSON.parse(raw) as ResearchSessionState;
  } catch {
    return null;
  }
}

export function writeState(state: ResearchSessionState): void {
  state.updatedAt = nowIso();
  ensureDir(sessionDir(state.folder, state.sessionId));
  fs.writeFileSync(statePath(state.folder, state.sessionId), JSON.stringify(state, null, 2));
}

export function appendTranscript(
  state: ResearchSessionState,
  entry: Omit<ResearchTranscriptEntry, 'createdAt'>,
): ResearchTranscriptEntry {
  const full: ResearchTranscriptEntry = { ...entry, createdAt: nowIso() };
  ensureDir(sessionDir(state.folder, state.sessionId));
  fs.appendFileSync(
    transcriptPath(state.folder, state.sessionId),
    `${JSON.stringify(full)}\n`,
  );
  return full;
}

export function readTranscript(
  folder: string,
  sessionId: string,
): ResearchTranscriptEntry[] {
  try {
    const raw = fs.readFileSync(transcriptPath(folder, sessionId), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ResearchTranscriptEntry);
  } catch {
    return [];
  }
}

/**
 * Sessions ever recorded for `folder`. Returns newest-first by `createdAt`.
 */
export function listSessions(folder: string): ResearchSessionState[] {
  const abs = path.resolve(folder);
  const dir = path.join(abs, RESEARCH_DIR_NAME, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir).filter((id) => {
    const p = path.join(dir, id);
    return fs.statSync(p).isDirectory();
  });
  const states: ResearchSessionState[] = [];
  for (const id of ids) {
    const s = readState(abs, id);
    if (s) states.push(s);
  }
  states.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return states;
}

export interface FinalizeResultInput {
  state: ResearchSessionState;
  outcome: 'completed' | 'timeout' | 'aborted' | 'failed';
  reason: string;
  reviewerAdvice?: string;
  researcherSummary?: string;
}

/**
 * Write `result-<sessionId>.md` capturing the agreed (or partial) outcome.
 *
 * Includes the goal snapshot, the final researcher summary, the final
 * reviewer verdict, and a transcript turn count for traceability.
 */
export function writeResultMarkdown(input: FinalizeResultInput): string {
  const { state, outcome, reason, reviewerAdvice, researcherSummary } = input;
  const goal = (() => {
    try {
      return fs.readFileSync(state.goalPath, 'utf8');
    } catch {
      return '_(goal.md no longer readable)_';
    }
  })();
  const verdict = state.lastVerdict?.verdict ?? 'n/a';
  const advice = reviewerAdvice ?? state.lastVerdict?.advice ?? '';
  const summary = researcherSummary ?? state.lastStatus?.summary ?? '';
  const transcriptCount = readTranscript(state.folder, state.sessionId).length;
  const body = [
    `# Research session result — ${outcome}`,
    '',
    `- session id: \`${state.sessionId}\``,
    `- working folder: \`${state.folder}\``,
    `- created at: ${state.createdAt}`,
    `- finished at: ${state.finishedAt ?? nowIso()}`,
    `- turns recorded: ${transcriptCount}`,
    `- final reviewer verdict: \`${verdict}\``,
    `- termination reason: ${reason}`,
    ...(state.referencesIndexed ? [`- references indexed: ${state.referencesIndexed}`] : []),
    ...(state.expertCouncilCount ? [`- expert councils triggered: ${state.expertCouncilCount}`] : []),
    ...(state.expertsInvoked?.length ? [`- experts consulted: ${state.expertsInvoked.join(', ')}`] : []),
    '',
    '## Goal (`goal.md`)',
    '',
    goal.trimEnd(),
    '',
    '## Researcher final summary',
    '',
    summary || '_(no summary recorded)_',
    '',
    '## Reviewer final advice',
    '',
    advice || '_(no advice recorded)_',
    '',
  ].join('\n');
  const out = resultPath(state.folder, state.sessionId);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, body);
  return out;
}

export function getResultPath(state: ResearchSessionState): string {
  return resultPath(state.folder, state.sessionId);
}

/**
 * Apply researcher reply: append transcript, update last status / phase / turn.
 */
export function recordResearcherReply(
  state: ResearchSessionState,
  payload: {
    text: string;
    status: ResearcherStatus | null;
    parseError?: string;
  },
): ResearchSessionState {
  state.turn += 1;
  appendTranscript(state, {
    turn: state.turn,
    role: 'researcher',
    kind: 'researcher-reply',
    text: payload.text,
    status: payload.status ?? undefined,
    parseError: payload.parseError,
  });
  if (payload.status) state.lastStatus = payload.status;
  state.phase = 'awaiting-reviewer';
  writeState(state);
  return state;
}

export function recordReviewerReply(
  state: ResearchSessionState,
  payload: {
    text: string;
    verdict: ReviewerEvaluation | null;
    parseError?: string;
  },
): ResearchSessionState {
  appendTranscript(state, {
    turn: state.turn,
    role: 'reviewer',
    kind: 'reviewer-reply',
    text: payload.text,
    verdict: payload.verdict ?? undefined,
    parseError: payload.parseError,
  });
  if (payload.verdict) state.lastVerdict = payload.verdict;
  state.phase = 'awaiting-researcher';
  writeState(state);
  return state;
}

export function recordOrchestratorNote(
  state: ResearchSessionState,
  text: string,
): void {
  appendTranscript(state, {
    turn: state.turn,
    role: 'orchestrator',
    kind: 'orchestrator-note',
    text,
  });
}

export function markFinished(
  state: ResearchSessionState,
  phase: Exclude<ResearchSessionPhase, 'pending' | 'awaiting-reviewer' | 'awaiting-researcher'>,
  reason: string,
): ResearchSessionState {
  state.phase = phase;
  state.finishedAt = nowIso();
  state.finishedReason = reason;
  writeState(state);
  return state;
}

/** Verdict alias used internally so we don't import the union elsewhere. */
export type { ReviewerVerdict };
