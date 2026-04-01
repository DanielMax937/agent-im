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

/**
 * Prompt enqueued when auto-advance did not run; asks the agent to confirm readiness or continue work.
 */
export function buildSystemCheckPrompt(taskSession: TaskSession, role: AgentRole): string {
  const ws = WORKFLOW_STATE_HINT[taskSession.workflowState] ?? taskSession.workflowState;
  return [
    '[Kanban system check — respond in your next assistant message]',
    '',
    `Current workflow state: ${taskSession.workflowState} (${ws}).`,
    `Your role for this lane: ${role}.`,
    '',
    '1) If you are ready to advance the board using the platform automation, end your reply with a single final line exactly as documented in your system prompt, e.g. `KANBAN_ACTION:START_TESTING` (developer), `KANBAN_ACTION:SUBMIT_REVIEW` (tester), `KANBAN_ACTION:APPROVE_MERGE` (reviewer), etc.',
    '2) If you still need to implement, fix, or explain more, continue working — do NOT add a KANBAN_ACTION line until you are ready.',
    '3) If you are blocked, say what you need.',
    '',
    `Task: ${taskSession.issueId} — ${taskSession.title}`,
  ].join('\n');
}
