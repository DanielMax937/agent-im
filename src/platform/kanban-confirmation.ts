import type { AgentRole, TaskSession, TaskWorkflowState } from './types';

export function kanbanConfirmationMaxLoops(): number {
  const raw = Number(process.env.CTI_KANBAN_CONFIRMATION_MAX_LOOPS ?? '100');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

const WORKFLOW_STATE_HINT: Record<TaskWorkflowState, string> = {
  todo: 'todo',
  pending_start: 'pending_start (queued for first dev run; dependencies + FIFO)',
  in_progress: 'in_progress (developer: START_TESTING → testing)',
  testing: 'testing (tester: SUBMIT_REVIEW → PR + review, or RETURN_TO_DEVELOPMENT)',
  review:
    'review (reviewer: REJECT_REVIEW → dev with comment; APPROVE_MERGE only when PR merge-ready on host → merge + regression)',
  regression_testing:
    'regression_testing (tester: PROCEED_TO_RELEASE when regression OK → pending_release + release PR)',
  pending_release:
    'pending_release (no agent — merge release PR on host, then close task via API)',
  closed: 'closed',
};

function roleActionInstruction(taskSession: TaskSession, role: AgentRole): string {
  if (role === 'developer' && taskSession.workflowState === 'in_progress') {
    return 'If your implementation is ready for feature testing, end your reply with exactly `KANBAN_ACTION:START_TESTING`. Do not use tester or reviewer actions from the developer lane.';
  }
  if (role === 'tester' && taskSession.workflowState === 'testing') {
    return 'If feature testing passed, end your reply with exactly `KANBAN_ACTION:SUBMIT_REVIEW`. If feature testing failed, end your reply with exactly `KANBAN_ACTION:RETURN_TO_DEVELOPMENT`. Do not use developer or reviewer actions from the tester lane.';
  }
  if (role === 'reviewer' && taskSession.workflowState === 'review') {
    return 'If review passed and the host PR is merge-ready, end your reply with exactly `KANBAN_ACTION:APPROVE_MERGE`. If review failed or merge is blocked, end your reply with exactly `KANBAN_ACTION:REJECT_REVIEW`. Do not use developer or tester actions from the reviewer lane.';
  }
  if (role === 'tester' && taskSession.workflowState === 'regression_testing') {
    return 'If regression passed, end your reply with exactly `KANBAN_ACTION:PROCEED_TO_RELEASE`. Do not use developer or reviewer actions from the tester lane.';
  }
  return 'If you are ready to advance the board, end your reply with the exact `KANBAN_ACTION:...` line that matches your current role and workflow state.';
}

/**
 * Prompt enqueued when auto-advance did not run; asks the agent to confirm readiness or continue work.
 */
export function buildSystemCheckPrompt(taskSession: TaskSession, role: AgentRole): string {
  const ws = WORKFLOW_STATE_HINT[taskSession.workflowState] ?? taskSession.workflowState;
  const hasDeveloperRejectionContext =
    role === 'developer' &&
    taskSession.workflowState === 'in_progress' &&
    ((taskSession.reviewRejectionCount ?? 0) > 0 || Boolean(taskSession.handoffComment?.trim()));
  const laneSpecificRule =
    role === 'reviewer' && taskSession.workflowState === 'review'
      ? 'Reviewer rule: if the host PR is dirty, draft, blocked by checks, or otherwise not merge-ready, you must NOT output `KANBAN_ACTION:APPROVE_MERGE`; instead end with `KANBAN_ACTION:REJECT_REVIEW` and put the concrete reason on the following lines.'
      : role === 'developer' && taskSession.workflowState === 'in_progress'
        ? hasDeveloperRejectionContext
          ? 'Developer rule: read the latest reviewer/workflow comment first and treat it as the active work item, even if the task most recently came from the tester lane. If the rejection is about PR mergeability, pull the latest sprint branch code locally, merge the sprint branch into your dev branch, resolve conflicts, commit, push, then hand off. Do NOT end with `KANBAN_ACTION:START_TESTING` until the issue is actually fixed.'
          : 'Developer rule: if implementation is done and ready for feature testing, your reply must end with `KANBAN_ACTION:START_TESTING`.'
        : role === 'tester' && taskSession.workflowState === 'testing'
          ? 'Tester rule: if feature testing passed, your reply must end with `KANBAN_ACTION:SUBMIT_REVIEW`; if it failed, end with `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` and explain why.'
          : role === 'tester' && taskSession.workflowState === 'regression_testing'
            ? 'Tester rule: if regression passed, your reply must end with `KANBAN_ACTION:PROCEED_TO_RELEASE`.'
            : undefined;
  return [
    '[Kanban system check — respond in your next assistant message]',
    '',
    `Current workflow state: ${taskSession.workflowState} (${ws}).`,
    `Your role for this lane: ${role}.`,
    '',
    `1) ${roleActionInstruction(taskSession, role)}`,
    '2) If you are done with this lane, do not send only a prose summary. You must either emit the correct final `KANBAN_ACTION:...` line or explicitly explain why you cannot advance yet.',
    ...(laneSpecificRule ? [laneSpecificRule] : []),
    '3) If you still need to implement, fix, or explain more, continue working — do NOT add a KANBAN_ACTION line until you are ready.',
    '4) If you are blocked, say what you need.',
    '',
    `Task: ${taskSession.issueId} — ${taskSession.title}`,
  ].join('\n');
}
