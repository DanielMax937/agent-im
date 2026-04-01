import type { AgentRole, Project, Sprint, TaskSession } from './types';

export const ROLE_PROMPTS: Record<AgentRole, string> = {
  developer: [
    'You are the Developer agent inside the agent-im DevOps Agentic Platform.',
    'Focus on implementation quality, repository conventions, safe refactors, and minimal diffs.',
    'Always keep task context isolated to the current Kanban issue and branch.',
    'If a tool requires approval, stop and wait for approval instead of bypassing controls.',
    'Leave clear commit-ready changes and explain trade-offs tersely.',
  ].join('\n'),
  reviewer: [
    'You are the Reviewer agent inside the agent-im DevOps Agentic Platform.',
    'Focus on security, robustness, missing edge cases, regression risk, and logic gaps.',
    'Review the open PR on GitHub/GitLab: post findings as **PR discussion comments** on the remote.',
    'Mirror the same review summary into the Kanban task conversation (workflow comment or POST /api/workflows/tasks/.../sync-review-comment if available).',
    'If the PR cannot be merged cleanly: fetch the **target branch** into your local clone, merge/rebase onto the task branch, resolve conflicts, push the task branch, then complete the PR merge.',
    'Do not approve risky shell or file operations without explicit permission.',
    'Prefer concrete review findings over summaries.',
  ].join('\n'),
  tester: [
    'You are the Tester agent inside the agent-im DevOps Agentic Platform.',
    'Focus on producing or updating high-signal tests and executing the most relevant suites.',
    'When tests fail, return concise diagnostics with the exact failing command and logs.',
    'Do not leak context across tasks; report only against the current Kanban issue.',
    'Preserve runtime extensibility so the same workflow can run on Claude, Codex, or Cursor.',
  ].join('\n'),
};

export interface BuildRolePromptOptions {
  role: AgentRole;
  project: Project;
  sprint: Sprint;
  taskSession: TaskSession;
}

export function buildRolePrompt({
  role,
  project,
  sprint,
  taskSession,
}: BuildRolePromptOptions): string {
  const skillBlock =
    taskSession.preferredSkills && taskSession.preferredSkills.length > 0
      ? ['Preferred skills / conventions (read & apply when relevant):', ...taskSession.preferredSkills.map((s) => `- ${s}`), '']
      : [];

  const handoffBlock = taskSession.handoffComment
    ? ['Handoff comment (read before acting):', taskSession.handoffComment, '']
    : [];

  /** Same data as board “交接记录”: each transition stores the outgoing role’s last assistant reply as summary. */
  const historyLogBlock =
    taskSession.historyComments && taskSession.historyComments.length > 0
      ? [
          'Task transition log (per step: what the previous lane last said when the card moved; complements chat messages below):',
          ...taskSession.historyComments.slice(-40).map((h) => {
            const head = h.transition
              ? `${h.transition.from} → ${h.transition.to} · ${h.transition.actionLabel}`
              : 'note';
            const roleLabel = h.role ?? '—';
            const body = h.content.length > 4000 ? `${h.content.slice(0, 4000)}…` : h.content;
            return `[${roleLabel}] ${head}\n${body}`;
          }),
          '',
        ]
      : [];

  /** `appendWorkflowComment` stores `role: system` — those rows are omitted from LLM chat history; surface here. */
  const workflowNotesBlock = (() => {
    const lines = taskSession.conversationHistory
      .filter((e) => e.role === 'system' && e.source === 'workflow')
      .slice(-25)
      .map((e) => e.content.trim());
    if (lines.length === 0) return [];
    return [
      'Platform workflow notes (automated system lines; not repeated as chat turns below):',
      ...lines.map((c) => (c.length > 1200 ? `${c.slice(0, 1200)}…` : c)),
      '',
    ];
  })();

  const testingScopeBlock =
    taskSession.workflowState === 'testing' && role === 'tester'
      ? [
          'Feature-test phase (before PR): validate **only this task’s acceptance criteria** on the **task branch** (or worktree).',
          'No PR exists yet in this phase. After green tests, end with `KANBAN_ACTION:SUBMIT_REVIEW` so the platform opens the PR and moves to review.',
          'If tests fail, use `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` (optional payload = reason) to send the card back to development.',
          '',
        ]
      : [];

  const regressionBlock =
    taskSession.workflowState === 'regression_testing' && role === 'tester'
      ? [
          `Final regression phase: the platform has merged the PR and checked out the **integration branch** \`${sprint.branchName}\` in the main repo clone (see working directory).`,
          '**Pull latest** (`git fetch` / `git pull`) on that branch before running suites. Update whole-application tests when behavior changes.',
          `Compare new commits on origin/${sprint.branchName} to \`regressionMasterSha\`; if the branch advanced, re-fetch and re-run full suites — or call POST .../regression/refresh when configured.`,
          'When regression is green, end with `KANBAN_ACTION:PROCEED_TO_RELEASE` to move to the **pending_release** column; the platform then ensures a release PR (sprint branch → repo base) if one is not already open.',
          '',
        ]
      : [];

  return [
    ROLE_PROMPTS[role],
    '',
    ...skillBlock,
    ...handoffBlock,
    ...historyLogBlock,
    ...workflowNotesBlock,
    ...testingScopeBlock,
    ...regressionBlock,
    'Execution context:',
    `- Project: ${project.name}`,
    `- Repository: ${project.repository.remoteUrl}`,
    `- Local path: ${project.repository.localPath}`,
    `- Sprint branch: ${sprint.branchName}`,
    `- Task branch: ${taskSession.branchName ?? 'not assigned yet'}`,
    `- Workflow state: ${taskSession.workflowState}`,
    `- Issue: ${taskSession.issueId}`,
    `- Task title: ${taskSession.title}`,
    '',
    'Platform guardrails:',
    '- Context Isolation: use only the current task queue and session history.',
    '- Permission Control: wait for approval when the runtime requests it.',
    '- Runtime Extensibility: avoid runtime-specific assumptions unless necessary.',
    '',
    'Workflow automation (when the server has workflow auto-advance enabled):',
    `To advance the Kanban board without a separate API call, end your reply with a final line exactly like one of the following (no extra text on that line):`,
    '- `KANBAN_ACTION:START_TESTING` — **developer** in **in_progress** (hand off to feature testing on the task branch).',
    '- `KANBAN_ACTION:SUBMIT_REVIEW` — **tester** in **testing** (commit/push + **create PR** → **review** column).',
    '- `KANBAN_ACTION:REJECT_REVIEW` — **reviewer** in **review** when the PR must go back to development; put the reason on the lines after the action (conflicts, failing CI, design issues, etc.).',
    '- `KANBAN_ACTION:APPROVE_MERGE` — **reviewer** in **review** only when the PR exists on the host, is **not** draft, and is **merge-ready** (no conflicts; required checks/reviews satisfied — the server checks this before merging). If the PR cannot be merged yet, do **not** use this line; use `REJECT_REVIEW` with an explanation instead.',
    '- `KANBAN_ACTION:RETURN_TO_DEVELOPMENT` — **tester** in **testing** if feature tests fail before PR.',
    '- `KANBAN_ACTION:PROCEED_TO_RELEASE` — **tester** in **regression_testing** when regression is OK (moves to **pending_release**; platform ensures release PR, posts on the PR, **no** agent in that column — humans merge and **close via API**).',
    '- **pending_release** has no runner — close the card with **POST `/api/workflows/tasks/:taskSessionId/close`** after you merge the release PR on the host (not a chat action).',
  ].join('\n');
}
