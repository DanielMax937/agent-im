/**
 * Optional one-time append to Auto mode Redis `session_summary` when forwarding Telegram → slave,
 * so rolling history does not rely on truncated User goal fragments (e.g. ending mid–requirement g).
 *
 * **Order:** call {@link truncateRollingSessionSummary} on the raw `User goal` block **first**, then
 * {@link appendKanbanRequirementGIfMissing}, so the Kanban **g** supplement is never cut off by the
 * 2000-char tail trim (Master / Telegram rolling context).
 */

const ROLLING_SUMMARY_MAX = 2000;
const ROLLING_SUMMARY_SUFFIX = 1997;

/** Default cap for the **final** string after appending Kanban (g); can be lowered via env if Redis/UI has a hard limit. */
const DEFAULT_SESSION_SUMMARY_HARD_MAX = 4000;

function getSessionSummaryHardMax(): number {
  const raw = process.env.CTI_KANBAN_SESSION_SUMMARY_MAX?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SESSION_SUMMARY_HARD_MAX;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_SESSION_SUMMARY_HARD_MAX;
}

function truncateToSuffixMax(s: string, max: number): string {
  if (s.length <= max) return s;
  const suffixLen = max - 3;
  return '...' + s.slice(s.length - suffixLen);
}

/** `\n---\n` + marker line (what {@link appendKanbanRequirementGIfMissing} appends before the body). */
function gBlockLeaderIndex(summary: string): number {
  const sep = `\n---\n${KANBAN_REDIS_REQUIREMENT_G_MARKER}`;
  const i = summary.indexOf(sep);
  if (i !== -1) return i;
  if (summary.startsWith(`${KANBAN_REDIS_REQUIREMENT_G_MARKER} `)) return 0;
  return -1;
}

/**
 * If the summary (after g append) exceeds {@link getSessionSummaryHardMax}, trim **only** the prefix
 * before the Kanban **g** block so the full **g** paragraph stays intact at the end.
 * When no **g** block is present, falls back to a plain tail trim to `max`.
 */
export function truncateSessionSummaryAfterGIfNeeded(summary: string): string {
  const max = getSessionSummaryHardMax();
  if (summary.length <= max) return summary;

  const gStart = gBlockLeaderIndex(summary);
  if (gStart === -1) {
    return truncateToSuffixMax(summary, max);
  }

  const gBlock = summary.slice(gStart);
  if (gBlock.length >= max) {
    return truncateToSuffixMax(gBlock, max);
  }

  const prefix = summary.slice(0, gStart);
  const budget = max - gBlock.length;
  if (prefix.length <= budget) return summary;

  return '...' + prefix.slice(prefix.length - (budget - 3)) + gBlock;
}

/** Marker line for dedupe inside rolling summary. */
export const KANBAN_REDIS_REQUIREMENT_G_MARKER = 'Kanban requirement (g, full):';

/**
 * Complete requirement **g** in one block (Chinese), aligned with board product copy / prompts.
 * Not a substitute for the user’s own goal text — stored alongside `User goal:` for Slave/Master context.
 */
export const KANBAN_REDIS_REQUIREMENT_G_BODY =
  '开发可用 worktree（CTI_KANBAN_USE_WORKTREE=1）。功能测试仅验证本 task 功能点；合入 master、解决合并冲突与 PR 为后续步骤。回归测试须针对 origin 上主分支最新；若主分支出现新的合并，须废弃用于回归的旧分支或 checkout，重新拉取最新代码后再跑全量用例，可配合 refreshRegressionIfMasterAdvanced。';

export function appendKanbanRequirementGIfMissing(summary: string): string {
  if (process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS === '0') return summary;
  if (summary.includes(KANBAN_REDIS_REQUIREMENT_G_MARKER)) return summary;
  return `${summary}\n---\n${KANBAN_REDIS_REQUIREMENT_G_MARKER} ${KANBAN_REDIS_REQUIREMENT_G_BODY}`;
}

/** Keeps the newest tail of a rolling summary (legacy 2000-char cap). Do not use on text that already includes the g block — truncate **before** {@link appendKanbanRequirementGIfMissing}. */
export function truncateRollingSessionSummary(summary: string): string {
  if (summary.length <= ROLLING_SUMMARY_MAX) return summary;
  return '...' + summary.slice(summary.length - ROLLING_SUMMARY_SUFFIX);
}
