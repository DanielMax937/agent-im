/**
 * Resolves the **user goal** line for `## Slave Execution Report`.
 *
 * Session summaries append `User goal: …` for each Telegram→slave forward. Using the **first**
 * match wrongly surfaces stale goals. Use {@link resolveSlaveReportGoalWithFallbacks} with Redis
 * `last_user` when summary is empty or missing markers.
 *
 * Optional: set `CTI_SLAVE_REPORT_GOAL` to pin a fixed string (e.g. deployment-wide default).
 */

/** Shown when no goal can be recovered — never use vague "(unknown — see session context)" in reports. */
export const SLAVE_REPORT_GOAL_MISSING =
  'goal 缺失：请 Master 重发或粘贴本条';

/**
 * Replaces the slave’s raw reply in `## Slave Execution Report` when {@link SLAVE_REPORT_GOAL_MISSING}
 * so Master never sees only “Hello / How can I help” while the title already says goal 缺失.
 */
import { renderPrompt } from '../../prompts/loader';

export const SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY = renderPrompt('bridge/slave-report-goal-missing');

export interface ResolveSlaveReportGoalInput {
  sessionSummary: string | null | undefined;
  /** From Redis `last_user` — last Telegram user text forwarded to the slave path. */
  lastUserRequest?: string | null | undefined;
}

/** Legacy placeholder from older builds — must not be treated as a real goal. */
const LEGACY_UNKNOWN_GOAL_RE = /^\(unknown — see session context\)\s*$/i;

/** Lines to drop from rolling summary when embedding in Slave reports (pre-fix / stale Redis snapshots). */
const LEGACY_USER_GOAL_LINE_RE = /^\s*User goal:\s*\(unknown — see session context\)\s*$/i;
const LEGACY_CANONICAL_LINE_RE =
  /^\s*\*\*Canonical goal \(same as report header above\):\*\*\s*\(unknown — see session context\)\s*$/i;

/**
 * Strips legacy placeholder lines from rolling session text so **Session context** does not repeat
 * misleading `User goal: (unknown…)` after deploy (Redis may still hold old summary until reset).
 */
export function sanitizeSessionSummaryForDisplay(raw: string): string {
  const lines = raw.split('\n').filter((line) => {
    if (LEGACY_USER_GOAL_LINE_RE.test(line)) return false;
    if (LEGACY_CANONICAL_LINE_RE.test(line)) return false;
    return true;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Match each Master evaluation block. Boundaries align with `telegram-adapter`:
 * - `afterAutoModeMasterTurn`: `…\n---\nMaster evaluation: …` (payload slice 0..300, may include newlines)
 * - `handleMasterRedisMessage`: `…\n---\nUser goal: …`
 * - First-only summary: `Master evaluation: …` at start (no leading `---`)
 *
 * **Important:** A block ends at `\n---\n` **only** when the next section is another `Master evaluation:` or
 * `User goal:` (same strings the bridge writes). Verdict text may contain its own `---` / `\n---\n` lines;
 * those must **not** end the block early (Master noted multi-segment scroll bugs from this mismatch).
 */
const MASTER_EVAL_BLOCK_RE =
  /(?:^|\n---\n)(Master evaluation:[\s\S]*?)(?=\n---\n(?:Master evaluation:|User goal:)|$)/g;

function findFirstMasterEvaluationIndex(s: string): number {
  if (s.startsWith('Master evaluation:')) return 0;
  const idx = s.indexOf('\n---\nMaster evaluation:');
  return idx >= 0 ? idx : s.indexOf('Master evaluation:');
}

/**
 * Rolling `session_summary` appends `---\nMaster evaluation: …` after each slave-report evaluation.
 * That stacks old verdicts (e.g. goal 缺失 / needs improvement) and clutters **Session context**.
 * For display only: keep the last N master-evaluation **blocks**; drop older ones and insert a one-line note
 * immediately before the first retained block (after any leading `User goal:` preamble).
 *
 * Uses regex boundaries so Redis **2000-char tail trim** (`...` prefix) and mixed `User goal` / `Master evaluation`
 * order still drop stale verdicts reliably.
 *
 * Set `CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST=0` to disable (keep all). Default: **1** (less noise in Telegram).
 * Use `2` or higher if you want more history visible in Session context.
 */
export function truncateMasterEvaluationsForRollingDisplay(
  raw: string,
  keepLastOverride?: number,
): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const defaultKeep = 1;

  let effectiveKeep: number;
  if (keepLastOverride !== undefined) {
    effectiveKeep = keepLastOverride;
  } else {
    const fromEnv = process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST?.trim();
    if (fromEnv === undefined || fromEnv === '') effectiveKeep = defaultKeep;
    else {
      const n = parseInt(fromEnv, 10);
      effectiveKeep = Number.isFinite(n) ? n : defaultKeep;
    }
  }
  if (effectiveKeep <= 0) return trimmed;

  const matches: Array<{ full: string; index: number }> = [];
  let m: RegExpExecArray | null;
  MASTER_EVAL_BLOCK_RE.lastIndex = 0;
  while ((m = MASTER_EVAL_BLOCK_RE.exec(trimmed)) !== null) {
    matches.push({ full: m[0], index: m.index });
  }
  if (matches.length <= effectiveKeep) return trimmed;

  const dropCount = matches.length - effectiveKeep;
  const toRemove = matches.slice(0, dropCount);

  let out = trimmed;
  for (let i = toRemove.length - 1; i >= 0; i--) {
    const { full, index } = toRemove[i]!;
    out = out.slice(0, index) + out.slice(index + full.length);
  }
  out = out.replace(/^\n---\n+/, '').replace(/\n{3,}/g, '\n\n').trim();

  const note = `_（已省略 ${dropCount} 轮较早的 Master evaluation；本滚动区仅保留最近 ${effectiveKeep} 轮。）_`;
  const insertAt = findFirstMasterEvaluationIndex(out);
  if (insertAt <= 0) {
    return `${note}\n\n${out}`;
  }
  return `${out.slice(0, insertAt)}\n${note}\n${out.slice(insertAt)}`;
}

function isLegacyUnknownGoalString(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return LEGACY_UNKNOWN_GOAL_RE.test(t);
}

function extractLastUserGoalBlock(summary: string): string | null {
  const marker = 'User goal:';
  const idx = summary.lastIndexOf(marker);
  if (idx === -1) return null;
  let rest = summary.slice(idx + marker.length);
  const blockEnd = rest.indexOf('\n---');
  const block = blockEnd === -1 ? rest : rest.slice(0, blockEnd);
  const goal = block.trim();
  if (!goal || isLegacyUnknownGoalString(goal)) return null;
  return goal;
}

/** `### User's Request` blocks from handoff templates embedded in rolling summary. */
function extractUsersRequestBlock(summary: string): string | null {
  const m = summary.match(/### User's Request\s*\n([\s\S]*?)(?=\n### |\n---\n|$)/);
  const t = m?.[1]?.trim();
  if (!t || isLegacyUnknownGoalString(t)) return null;
  return t;
}

/**
 * Full resolution order: pinned env → last `User goal:` → `### User's Request` → Redis last user →
 * {@link SLAVE_REPORT_GOAL_MISSING}.
 */
export function resolveSlaveReportGoalWithFallbacks(input: ResolveSlaveReportGoalInput): string {
  const pinned = process.env.CTI_SLAVE_REPORT_GOAL?.trim();
  if (pinned) return pinned;

  const summary = input.sessionSummary?.trim() ?? '';

  const fromUserGoal = summary ? extractLastUserGoalBlock(summary) : null;
  if (fromUserGoal) return fromUserGoal.slice(0, 4000);

  const fromHandoff = summary ? extractUsersRequestBlock(summary) : null;
  if (fromHandoff) return fromHandoff.slice(0, 4000);

  const last = input.lastUserRequest?.trim();
  if (last && !isLegacyUnknownGoalString(last)) return last.slice(0, 4000);

  return SLAVE_REPORT_GOAL_MISSING;
}

/** @deprecated Prefer {@link resolveSlaveReportGoalWithFallbacks} with `lastUserRequest` from Redis. */
export function resolveSlaveReportGoal(sessionSummary: string | null | undefined): string {
  return resolveSlaveReportGoalWithFallbacks({ sessionSummary, lastUserRequest: null });
}

/**
 * Builds the `### Session Context` section for `## Slave Execution Report`.
 *
 * Without this, the rolling summary often **starts** with an older `User goal:` (e.g. weather) while the
 * report header already shows the **latest** goal — master / humans read the first lines of Session
 * Context and see a mismatched "outer" title. This block repeats the **same** canonical goal as the
 * header and labels the rest as history.
 */
export function buildSlaveReportSessionContextBlock(
  sessionSummary: string | null | undefined,
  resolvedGoal: string,
): string {
  const raw = sessionSummary?.trim() ?? '';
  if (!raw) {
    return '';
  }

  const history = truncateMasterEvaluationsForRollingDisplay(
    sanitizeSessionSummaryForDisplay(raw),
  );
  const historyBlock = history
    ? `${history}\n\n`
    : '_（滚动摘要中原仅含已剔除的旧 unknown 占位；请发新 Telegram 消息或执行 Auto mode reset 以刷新 Redis。）_\n\n';

  return renderPrompt('bridge/slave-report-session-context', {
    resolvedGoal,
    history: historyBlock,
  });
}
